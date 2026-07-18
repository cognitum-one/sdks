"""``ExecutionReceipt`` / ``LineageReference`` construction + verification
(issue #56, building out the ADR-0028 D7-D9 type-only stubs from #79).

Deliberate scope limits (documented rather than silently skipped):

- Signatures are HMAC-SHA256 (symmetric, caller-supplied key resolver), not
  asymmetric Ed25519. ADR-0028 D7 asks for "a discoverable, rotatable
  verification key" without mandating an algorithm; a full asymmetric PKI
  (key discovery/rotation service) is out of scope for this pass.
- ``anchored`` (D8) requires an externally durable checkpoint/proof. This
  module only calls an optional caller-supplied ``check_anchor`` callback;
  it does not implement or assume any specific anchor/ledger service.
- Checkpoint "freshness" (D9) is a parseable-timestamp + optional max-age
  check, not a live clock-skew/NTP protocol.

Cross-language canonicalization note (fix for a bug found in review of #84):
the ``cognitum-canonical-json-v1`` scheme is shared with the Node and Rust
SDKs, which both canonicalize receipt/lineage fields as camelCase (Node's
types are natively camelCase; Rust's ``ExecutionReceipt``/``LineageReference``
carry ``#[serde(rename_all = "camelCase")]``). Python's dataclasses stay
snake_case (matching Python convention -- ``receipt.contract_version``, not
``receipt.contractVersion``), but the *signable/digestible* payload built by
``_signable_value`` below renames known schema field names to camelCase
before serializing, so the canonical bytes -- and therefore SHA-256 digests
and HMAC-SHA256 signatures -- match byte-for-byte across all three SDKs for
the same logical receipt. Opaque caller-supplied blobs (``usage``) are
intentionally NOT renamed: Node and Rust pass them through verbatim too, so
renaming them here would itself introduce a new cross-language mismatch.
``canonical_json`` additionally normalizes whole-valued floats (``10.0`` ->
``10``) to match JavaScript's single ``number`` type, which is what
``JSON.stringify`` on the Node side already produces -- Rust's ``serde_json``
and Python's ``json`` module both default to preserving the float/int
distinction and would otherwise diverge from Node's canonical bytes whenever
a cost amount happens to be a whole number.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
import json
import math
from collections.abc import Callable
from dataclasses import dataclass, field, fields, is_dataclass, replace
from datetime import datetime, timezone
from typing import Any

from cognitum.agentic.receipts import (
    CostObservation,
    ExecutionReceipt,
    LineageReference,
    ReceiptSubject,
    VerificationLevel,
    VerificationResult,
)

CANONICALIZATION_VERSION = "cognitum-canonical-json-v1"
_LEVEL_ORDER: list[VerificationLevel] = [
    "none",
    "shape",
    "digest",
    "cryptographic",
    "anchored",
]


def _level_index(level: VerificationLevel) -> int:
    return _LEVEL_ORDER.index(level)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_timestamp(value: str) -> datetime | None:
    """Parses an RFC3339 timestamp, accepting a trailing ``Z`` (not natively
    understood by ``datetime.fromisoformat`` before Python 3.11)."""
    normalized = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---------------------------------------------------------------------------
# Canonical bytes + digests
# ---------------------------------------------------------------------------


def _normalize_numbers(value: Any) -> Any:
    """Recursively normalizes JSON-bound numbers to match JavaScript's
    canonical numeric formatting (see module docstring): a whole-valued
    float (``10.0``) collapses to an int (``10``) so ``json.dumps`` renders
    it identically to Node's ``JSON.stringify``. Applies to the *whole*
    value tree, including opaque blobs like ``usage``, since any JSON
    number appearing in the canonical bytes must format consistently, not
    just the receipt's own schema fields.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return int(value)
        return value
    if isinstance(value, dict):
        return {k: _normalize_numbers(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_numbers(v) for v in value]
    return value


def _camel_case(name: str) -> str:
    """Converts a ``snake_case`` field name to ``camelCase``."""
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _signable_value(value: Any) -> Any:
    """Recursively converts dataclass instances into JSON-ready values with
    camelCase keys (matching the Node/Rust canonical wire format). Only
    known dataclass fields are renamed -- opaque caller-supplied dict blobs
    (e.g. ``usage``) are returned unchanged, matching how Node/Rust pass
    them through verbatim rather than re-keying their contents.
    """
    if is_dataclass(value) and not isinstance(value, type):
        return {
            _camel_case(f.name): _signable_value(getattr(value, f.name))
            for f in fields(value)
        }
    if isinstance(value, (list, tuple)):
        return [_signable_value(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    """Deterministic JSON matching the ``cognitum-canonical-json-v1`` scheme
    shared with the Node/Rust SDKs: recursively sorted object keys, no
    whitespace, and JS-compatible numeric formatting (see
    ``_normalize_numbers``)."""
    return json.dumps(_normalize_numbers(value), sort_keys=True, separators=(",", ":"))


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _hmac_sha256_hex(key: bytes, text: str) -> str:
    return hmac_lib.new(key, text.encode("utf-8"), hashlib.sha256).hexdigest()


def _constant_time_hex_equal(a: str, b: str) -> bool:
    if not a or not b or len(a) != len(b):
        return False
    return hmac_lib.compare_digest(a, b)


def _receipt_signable_dict(r: ExecutionReceipt) -> dict[str, Any]:
    d = _signable_value(r)
    d.pop("signature", None)
    d.pop("verification", None)
    return d


def _lineage_signable_dict(l: LineageReference) -> dict[str, Any]:  # noqa: E741
    d = _signable_value(l)
    d.pop("signature", None)
    d.pop("verification", None)
    return d


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def build_execution_receipt(
    *,
    receipt_id: str,
    product: str,
    contract_version: str,
    request_id: str,
    started_at: str,
    outcome: str,
    operation_id: str | None = None,
    tenant_hash: str | None = None,
    completed_at: str | None = None,
    usage: dict[str, Any] | None = None,
    costs: list[CostObservation] | None = None,
    artifact_digests: list[str] | None = None,
    lineage_root: str | None = None,
    issuer: str | None = None,
    key_id: str | None = None,
    sign: Callable[[str], str] | None = None,
    now: Callable[[], str] | None = None,
) -> ExecutionReceipt:
    """Builds an ``ExecutionReceiptV1`` from operation metadata, usage/cost,
    and timestamps (ADR-0028 D7)."""
    checked_at = now() if now else _now_iso()

    receipt = ExecutionReceipt(
        receipt_id=receipt_id,
        product=product,
        contract_version=contract_version,
        subject=ReceiptSubject(
            request_id=request_id, operation_id=operation_id, tenant_hash=tenant_hash
        ),
        started_at=started_at,
        outcome=outcome,
        verification=VerificationResult(level="none", valid=False, checked_at=checked_at),
        completed_at=completed_at,
        usage=usage,
        costs=costs if costs is not None else [],
        artifact_digests=artifact_digests,
        lineage_root=lineage_root,
        canonicalization=CANONICALIZATION_VERSION,
        issuer=issuer,
        key_id=key_id,
    )

    if sign is not None:
        canonical = canonical_json(_receipt_signable_dict(receipt))
        receipt = replace(receipt, signature=sign(canonical))

    failure = shape_check_execution_receipt(receipt)
    verification = (
        VerificationResult(level="none", valid=False, checked_at=checked_at, failure=failure)
        if failure
        else VerificationResult(level="shape", valid=True, checked_at=checked_at)
    )
    return replace(receipt, verification=verification)


# ---------------------------------------------------------------------------
# Shape checks (structural completeness only -- D8 "shape")
# ---------------------------------------------------------------------------


def shape_check_execution_receipt(r: ExecutionReceipt) -> str | None:
    if r.schema != "cognitum.execution-receipt.v1":
        return "unexpected schema tag"
    if not r.receipt_id:
        return "receipt_id is required"
    if not r.product:
        return "product is required"
    if not r.contract_version:
        return "contract_version is required"
    if not r.subject or not r.subject.request_id:
        return "subject.request_id is required"
    started = _parse_timestamp(r.started_at)
    if started is None:
        return "started_at must be a parseable timestamp"
    if r.completed_at:
        completed = _parse_timestamp(r.completed_at)
        if completed is None:
            return "completed_at must be a parseable timestamp"
        if completed < started:
            return "completed_at precedes started_at"
    if not r.outcome:
        return "outcome is required"
    for cost in r.costs:
        if not cost.source:
            return "cost.source is required"
        amount = cost.amount
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            return "cost.amount must be a finite number"
        if amount != amount or amount in (float("inf"), float("-inf")):  # noqa: PLR0124 (NaN check)
            return "cost.amount must be a finite number"
        if not cost.currency:
            return "cost.currency is required"
    return None


def shape_check_lineage_reference(link: LineageReference) -> str | None:
    if link.schema != "cognitum.lineage-reference.v1":
        return "unexpected schema tag"
    if not link.subject or not link.subject.request_id:
        return "subject.request_id is required"
    if link.sequence is not None and (
        not isinstance(link.sequence, int) or isinstance(link.sequence, bool) or link.sequence < 0
    ):
        return "sequence must be a non-negative integer"
    return None


# ---------------------------------------------------------------------------
# Verification (D8 verification levels)
# ---------------------------------------------------------------------------


@dataclass
class VerifyReceiptOptions:
    min_level: VerificationLevel
    expected_digest: str | None = None
    resolve_key: Callable[[str, str], bytes | None] | None = None
    check_anchor: Callable[[str], bool] | None = None
    now: Callable[[], str] | None = None


def verify_execution_receipt(
    receipt: ExecutionReceipt, opts: VerifyReceiptOptions
) -> VerificationResult:
    """Verifies a receipt against a minimum required VerificationLevel
    (fail-closed)."""
    checked_at = opts.now() if opts.now else _now_iso()
    warnings: list[str] = []

    failure = shape_check_execution_receipt(receipt)
    if failure:
        return VerificationResult(level="none", valid=False, checked_at=checked_at, failure=failure)

    achieved: VerificationLevel = "shape"
    canonical_bytes = canonical_json(_receipt_signable_dict(receipt))
    subject_digest = sha256_hex(canonical_bytes)
    algorithm: str | None = None

    if opts.expected_digest:
        if opts.expected_digest == subject_digest:
            achieved = "digest"
        else:
            warnings.append("expected digest mismatch")

    if receipt.signature and receipt.issuer and receipt.key_id:
        if opts.resolve_key is None:
            warnings.append("no key resolver supplied; cannot verify signature")
        else:
            key = opts.resolve_key(receipt.issuer, receipt.key_id)
            if key is None:
                warnings.append(f"unknown key '{receipt.key_id}' for issuer '{receipt.issuer}'")
            else:
                expected_sig = _hmac_sha256_hex(key, canonical_bytes)
                if _constant_time_hex_equal(expected_sig, receipt.signature):
                    achieved = "cryptographic"
                    algorithm = "hmac-sha256"
                else:
                    return VerificationResult(
                        level="none",
                        valid=False,
                        checked_at=checked_at,
                        subject_digest=subject_digest,
                        failure="signature does not match canonical bytes",
                    )
    elif _level_index(opts.min_level) >= _level_index("cryptographic"):
        warnings.append("receipt carries no signature/issuer/keyId claim")

    if achieved == "cryptographic" and receipt.lineage_root and opts.check_anchor:
        if opts.check_anchor(receipt.lineage_root):
            achieved = "anchored"
        else:
            warnings.append("anchor check did not confirm durable checkpoint")

    valid = _level_index(achieved) >= _level_index(opts.min_level)
    return VerificationResult(
        level=achieved,
        valid=valid,
        algorithm=algorithm,
        key_id=receipt.key_id,
        checked_at=checked_at,
        subject_digest=subject_digest,
        warnings=warnings or None,
        failure=None
        if valid
        else f"minimum level '{opts.min_level}' not reached (achieved '{achieved}')",
    )


# ---------------------------------------------------------------------------
# Lineage chain (D9) -- structural chain validation
# ---------------------------------------------------------------------------


@dataclass
class VerifyLineageChainOptions:
    min_level: VerificationLevel
    resolve_key: Callable[[str, str], bytes | None] | None = None
    max_checkpoint_age_ms: float | None = None
    now: Callable[[], str] | None = None


@dataclass
class LineageChainVerification:
    valid: bool
    level: VerificationLevel
    results: list[VerificationResult] = field(default_factory=list)
    broken_at_index: int | None = None
    failure: str | None = None


def verify_lineage_chain(
    chain: list[LineageReference], opts: VerifyLineageChainOptions
) -> LineageChainVerification:
    """Verifies a LineageReference chain is well-formed: each entry's
    ``previous_checkpoint`` resolves to the prior entry's ``root``, sequence
    numbers strictly increase, and no ``root`` digest repeats (cycle
    detection). This is a structural check (D9), not a full Merkle/anchored
    proof.
    """
    checked_at = opts.now() if opts.now else _now_iso()
    results: list[VerificationResult] = []

    if not chain:
        return LineageChainVerification(
            valid=False, level="none", results=results, failure="lineage chain is empty"
        )

    seen_roots: set[str] = set()
    min_achieved: VerificationLevel = "anchored"
    # The genesis entry (index 0) has no predecessor to link against, so it
    # can never reach "digest" on its own -- that's not a weak link, it's
    # simply not applicable. It only counts toward the chain's overall level
    # when the chain has exactly one entry (nothing else to fold in).
    genesis_achieved: VerificationLevel | None = None

    for i, entry in enumerate(chain):
        shape_failure = shape_check_lineage_reference(entry)
        if shape_failure:
            results.append(
                VerificationResult(
                    level="none", valid=False, checked_at=checked_at, failure=shape_failure
                )
            )
            return LineageChainVerification(
                valid=False,
                level="none",
                broken_at_index=i,
                results=results,
                failure=shape_failure,
            )

        if entry.root:
            if entry.root in seen_roots:
                failure = f"cycle detected at index {i} (root already seen)"
                results.append(
                    VerificationResult(
                        level="none", valid=False, checked_at=checked_at, failure=failure
                    )
                )
                return LineageChainVerification(
                    valid=False, level="none", broken_at_index=i, results=results, failure=failure
                )
            seen_roots.add(entry.root)

        achieved: VerificationLevel = "shape"
        warnings: list[str] = []

        if i > 0:
            prev = chain[i - 1]
            if not entry.previous_checkpoint or entry.previous_checkpoint != prev.root:
                failure = (
                    f"entry {i} previousCheckpoint does not resolve to entry {i - 1} root"
                )
                results.append(
                    VerificationResult(
                        level="none", valid=False, checked_at=checked_at, failure=failure
                    )
                )
                return LineageChainVerification(
                    valid=False, level="none", broken_at_index=i, results=results, failure=failure
                )
            if (
                entry.sequence is not None
                and prev.sequence is not None
                and entry.sequence <= prev.sequence
            ):
                failure = f"entry {i} sequence ({entry.sequence}) is not strictly increasing"
                results.append(
                    VerificationResult(
                        level="none", valid=False, checked_at=checked_at, failure=failure
                    )
                )
                return LineageChainVerification(
                    valid=False, level="none", broken_at_index=i, results=results, failure=failure
                )
            achieved = "digest"

        if entry.checkpoint_time:
            ts = _parse_timestamp(entry.checkpoint_time)
            if ts is None:
                warnings.append("checkpointTime not parseable")
            elif opts.max_checkpoint_age_ms is not None:
                age_ms = (datetime.now(timezone.utc) - ts).total_seconds() * 1000
                if age_ms > opts.max_checkpoint_age_ms:
                    warnings.append("checkpoint is stale")

        if entry.signature and entry.issuer and entry.key_id:
            if opts.resolve_key is None:
                warnings.append("no key resolver supplied; cannot verify signature")
            else:
                key = opts.resolve_key(entry.issuer, entry.key_id)
                if key is None:
                    warnings.append(f"unknown key '{entry.key_id}'")
                else:
                    payload = canonical_json(_lineage_signable_dict(entry))
                    expected = _hmac_sha256_hex(key, payload)
                    if _constant_time_hex_equal(expected, entry.signature):
                        achieved = "cryptographic"
                    else:
                        failure = f"entry {i} signature does not match canonical bytes"
                        results.append(
                            VerificationResult(
                                level="none", valid=False, checked_at=checked_at, failure=failure
                            )
                        )
                        return LineageChainVerification(
                            valid=False,
                            level="none",
                            broken_at_index=i,
                            results=results,
                            failure=failure,
                        )

        results.append(
            VerificationResult(
                level=achieved,
                valid=True,
                checked_at=checked_at,
                key_id=entry.key_id,
                warnings=warnings or None,
            )
        )
        if i == 0:
            genesis_achieved = achieved
        elif _level_index(achieved) < _level_index(min_achieved):
            min_achieved = achieved

    if len(chain) == 1:
        min_achieved = genesis_achieved or "shape"

    valid = _level_index(min_achieved) >= _level_index(opts.min_level)
    chain_failure = None
    if not valid:
        chain_failure = (
            f"minimum level '{opts.min_level}' not reached across chain "
            f"(achieved '{min_achieved}')"
        )
    return LineageChainVerification(
        valid=valid,
        level=min_achieved,
        results=results,
        failure=chain_failure,
    )


__all__ = [
    "CANONICALIZATION_VERSION",
    "canonical_json",
    "sha256_hex",
    "build_execution_receipt",
    "shape_check_execution_receipt",
    "shape_check_lineage_reference",
    "VerifyReceiptOptions",
    "verify_execution_receipt",
    "VerifyLineageChainOptions",
    "LineageChainVerification",
    "verify_lineage_chain",
]
