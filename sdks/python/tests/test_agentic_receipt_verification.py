"""Tests for ``cognitum.agentic.receipt_verification`` (issue #56).

Mirrors the Node/Rust suites for the same module: build a valid receipt and
verify it passes; tamper with it and verify rejection; confirm a shape-only
receipt correctly skips cryptographic checks it never claimed; and validate
lineage-chain structural checks (broken link, cycle, non-increasing
sequence, and the genesis-only single-entry edge case).

Also includes the cross-language canonicalization conformance suite (see
``test_conformance_*`` below) added in review of PR #84: it loads the
golden fixture shared with the Node and Rust suites
(``sdks/fixtures/receipt-canonicalization/``) and asserts this SDK's own
canonical bytes/SHA-256 digest/HMAC-SHA256 signature match the pinned
values byte-for-byte -- the test that would have caught the casing bug
(``dataclasses.asdict(r)`` emitting snake_case with no rename step) and the
whole-number-float formatting bug found in the same review pass.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_lib
import json
from pathlib import Path

from cognitum.agentic.receipt_verification import (
    VerifyLineageChainOptions,
    VerifyReceiptOptions,
    _hmac_sha256_hex,
    _lineage_signable_dict,
    _receipt_signable_dict,
    build_execution_receipt,
    canonical_json,
    sha256_hex,
    verify_execution_receipt,
    verify_lineage_chain,
)
from cognitum.agentic.receipts import (
    CostObservation,
    ExecutionReceipt,
    LineageReference,
    LineageSubject,
    ReceiptSubject,
    VerificationResult,
)

KEY = b"test-signing-key"

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "fixtures"
    / "receipt-canonicalization"
    / "execution-receipt-v1.json"
)


def _load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def resolve_key(issuer: str, key_id: str) -> bytes | None:
    return KEY if issuer == "cognitum-one" and key_id == "key-1" else None


def sign(canonical_bytes: str) -> str:
    return hmac_lib.new(KEY, canonical_bytes.encode("utf-8"), hashlib.sha256).hexdigest()


def make_receipt(**overrides):
    params = {
        "receipt_id": "rcpt_1",
        "product": "harnessaas",
        "contract_version": "1.0",
        "request_id": "req_1",
        "operation_id": "op_1",
        "started_at": "2026-07-18T00:00:00.000Z",
        "completed_at": "2026-07-18T00:00:05.000Z",
        "outcome": "succeeded",
        "costs": [
            {"source": "provider", "amount": 0.01, "currency": "USD", "finality": "estimate"}
        ],
        "issuer": "cognitum-one",
        "key_id": "key-1",
        "sign": sign,
    }
    params.update(overrides)
    from cognitum.agentic.receipts import CostObservation

    params["costs"] = [CostObservation(**c) if isinstance(c, dict) else c for c in params["costs"]]
    return build_execution_receipt(**params)


def test_build_produces_shape_valid_receipt():
    receipt = make_receipt()
    assert receipt.schema == "cognitum.execution-receipt.v1"
    assert receipt.subject.request_id == "req_1"
    assert receipt.verification.level == "shape"
    assert receipt.verification.valid is True
    assert receipt.canonicalization == "cognitum-canonical-json-v1"


def test_build_flags_structurally_incomplete_receipt():
    receipt = make_receipt(outcome="")
    assert receipt.verification.level == "none"
    assert receipt.verification.valid is False
    assert "outcome" in receipt.verification.failure


def test_verify_reaches_cryptographic_for_a_valid_signed_receipt():
    receipt = make_receipt()
    result = verify_execution_receipt(
        receipt, VerifyReceiptOptions(min_level="cryptographic", resolve_key=resolve_key)
    )
    assert result.valid is True
    assert result.level == "cryptographic"
    assert result.algorithm == "hmac-sha256"


def test_verify_rejects_a_receipt_with_a_tampered_signature():
    from dataclasses import replace

    receipt = make_receipt()
    tampered = replace(receipt, outcome="failed")
    result = verify_execution_receipt(
        tampered, VerifyReceiptOptions(min_level="cryptographic", resolve_key=resolve_key)
    )
    assert result.valid is False
    assert result.level == "none"
    assert "signature" in result.failure


def test_verify_rejects_tampered_costs_post_signing():
    from dataclasses import replace

    from cognitum.agentic.receipts import CostObservation

    receipt = make_receipt()
    tampered = replace(
        receipt,
        costs=[CostObservation(source="provider", amount=999, currency="USD", finality="estimate")],
    )
    result = verify_execution_receipt(
        tampered, VerifyReceiptOptions(min_level="digest", resolve_key=resolve_key)
    )
    assert result.valid is False


def test_shape_only_receipt_skips_crypto_checks_it_never_claimed():
    receipt = build_execution_receipt(
        receipt_id="rcpt_2",
        product="meta-llm",
        contract_version="1.0",
        request_id="req_2",
        started_at="2026-07-18T00:00:00.000Z",
        outcome="succeeded",
    )
    assert receipt.signature is None

    result = verify_execution_receipt(receipt, VerifyReceiptOptions(min_level="shape"))
    assert result.valid is True
    assert result.level == "shape"

    strict = verify_execution_receipt(receipt, VerifyReceiptOptions(min_level="cryptographic"))
    assert strict.valid is False
    assert "receipt carries no signature/issuer/keyId claim" in strict.warnings


def test_achieves_digest_level_with_matching_expected_digest():
    from cognitum.agentic.receipt_verification import _receipt_signable_dict, sha256_hex

    receipt = build_execution_receipt(
        receipt_id="rcpt_3",
        product="meta-proxy",
        contract_version="1.0",
        request_id="req_3",
        started_at="2026-07-18T00:00:00.000Z",
        outcome="succeeded",
    )
    # NOTE: the digest MUST be computed via the module's own signable-dict
    # helper (camelCase keys), not a raw `dataclasses.asdict(receipt)` --
    # the latter emits snake_case keys and would canonicalize to different
    # bytes than Node/Rust ever produce for the same logical receipt (the
    # cross-SDK canonicalization bug fixed alongside this test).
    digest = sha256_hex(canonical_json(_receipt_signable_dict(receipt)))
    result = verify_execution_receipt(
        receipt, VerifyReceiptOptions(min_level="digest", expected_digest=digest)
    )
    assert result.valid is True
    assert result.level == "digest"


def test_receipt_signable_dict_uses_camel_case_keys_matching_node_and_rust():
    """Regression test for the cross-SDK canonicalization bug: the
    signable/digestible payload MUST use camelCase keys (receiptId,
    contractVersion, subject.requestId, ...), matching Node's native
    camelCase types and Rust's `#[serde(rename_all = "camelCase")]`. Before
    the fix, this emitted snake_case (`receipt_id`, `contract_version`,
    `subject.request_id`), so identical receipts canonicalized to different
    bytes -- and therefore different digests/signatures -- across languages.
    """
    from cognitum.agentic.receipt_verification import _receipt_signable_dict

    receipt = make_receipt()
    signable = _receipt_signable_dict(receipt)
    assert "receiptId" in signable
    assert "contractVersion" in signable
    assert "receipt_id" not in signable
    assert "contract_version" not in signable
    assert signable["subject"]["requestId"] == "req_1"
    assert "request_id" not in signable["subject"]


def make_chain() -> list[LineageReference]:
    def entry(i: int, prev_root: str | None = None) -> LineageReference:
        return LineageReference(
            subject=LineageSubject(request_id="req_1"),
            leaf=f"leaf-{i}",
            root=f"root-{i}",
            sequence=i,
            previous_checkpoint=prev_root,
            checkpoint_time="2026-07-18T00:00:00.000Z",
            verification=VerificationResult(
                level="none", valid=False, checked_at="2026-07-18T00:00:00.000Z"
            ),
        )

    return [entry(0), entry(1, "root-0"), entry(2, "root-1")]


def test_accepts_a_well_formed_chain():
    result = verify_lineage_chain(make_chain(), VerifyLineageChainOptions(min_level="digest"))
    assert result.valid is True
    assert len(result.results) == 3


def test_rejects_a_chain_with_a_broken_link():
    from dataclasses import replace

    chain = make_chain()
    chain[2] = replace(chain[2], previous_checkpoint="root-999")
    result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="digest"))
    assert result.valid is False
    assert result.broken_at_index == 2
    assert "previousCheckpoint" in result.failure


def test_rejects_a_chain_containing_a_cycle():
    from dataclasses import replace

    chain = make_chain()
    chain[2] = replace(chain[2], root="root-0")
    result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="shape"))
    assert result.valid is False
    assert "cycle" in result.failure


def test_rejects_a_chain_whose_sequence_does_not_strictly_increase():
    from dataclasses import replace

    chain = make_chain()
    chain[2] = replace(chain[2], sequence=1)
    result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="shape"))
    assert result.valid is False
    assert "sequence" in result.failure


def test_single_entry_genesis_only_chain_achieves_only_shape():
    chain = [make_chain()[0]]
    shape_result = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="shape"))
    assert shape_result.valid is True
    assert shape_result.level == "shape"

    strict = verify_lineage_chain(chain, VerifyLineageChainOptions(min_level="digest"))
    assert strict.valid is False


def test_mixed_level_chain_reports_cryptographic_not_capped_by_shape_only_genesis():
    """Regression test for the mixed-verification-level lineage chain claim
    (issue #56 / PR #84 review): the prior implementation's self-report
    claimed this coverage existed but it did not. The genesis entry (index
    0) has no predecessor to link against, so it can only ever reach
    ``shape`` on its own -- that's expected, not a weak link -- and it must
    NOT cap the chain's overall reported level once later entries reach
    ``cryptographic``. The genesis-exclusion fix itself was already
    verified correct by the reviewer; this closes the missing-test-coverage
    gap.
    """
    from dataclasses import replace

    chain = make_chain()
    signed = [chain[0]]  # genesis stays unsigned: shape-only is correct here.
    for entry in chain[1:]:
        entry = replace(entry, issuer="cognitum-one", key_id="key-1")
        payload = canonical_json(_lineage_signable_dict(entry))
        entry = replace(entry, signature=_hmac_sha256_hex(KEY, payload))
        signed.append(entry)

    result = verify_lineage_chain(
        signed, VerifyLineageChainOptions(min_level="cryptographic", resolve_key=resolve_key)
    )

    assert result.valid is True
    assert result.level == "cryptographic"
    assert len(result.results) == 3
    assert result.results[0].level == "shape"
    assert result.results[1].level == "cryptographic"
    assert result.results[2].level == "cryptographic"


# ---------------------------------------------------------------------------
# Cross-language canonicalization conformance (issue #56 / PR #84 review)
# ---------------------------------------------------------------------------


def test_conformance_receipt_canonical_bytes_match_the_cross_language_golden_fixture():
    fixture = _load_fixture()
    logical = fixture["logicalReceipt"]

    receipt = ExecutionReceipt(
        schema=logical["schema"],
        receipt_id=logical["receiptId"],
        product=logical["product"],
        contract_version=logical["contractVersion"],
        subject=ReceiptSubject(
            request_id=logical["subject"]["requestId"],
            operation_id=logical["subject"].get("operationId"),
            tenant_hash=logical["subject"].get("tenantHash"),
        ),
        started_at=logical["startedAt"],
        completed_at=logical.get("completedAt"),
        usage=logical.get("usage"),
        costs=[
            CostObservation(
                source=c["source"],
                # Deliberately coerced to `float` (not left as whatever
                # `json.load` inferred) so this genuinely exercises the
                # whole-number-float canonicalization fix, regardless of
                # whether the fixture's JSON literal has a decimal point.
                amount=float(c["amount"]),
                currency=c["currency"],
                finality=c["finality"],
            )
            for c in logical["costs"]
        ],
        outcome=logical["outcome"],
        verification=VerificationResult(level="none", valid=False, checked_at=""),
        artifact_digests=logical.get("artifactDigests"),
        lineage_root=logical.get("lineageRoot"),
        canonicalization=logical.get("canonicalization"),
        issuer=logical.get("issuer"),
        key_id=logical.get("keyId"),
    )

    canonical = canonical_json(_receipt_signable_dict(receipt))
    assert canonical == fixture["expectedCanonicalJson"]
    assert sha256_hex(canonical) == fixture["expectedSha256Hex"]

    key = fixture["hmacKeyUtf8"].encode("utf-8")
    assert _hmac_sha256_hex(key, canonical) == fixture["expectedHmacSha256Hex"]


def test_conformance_lineage_entry_canonical_bytes_match_the_cross_language_golden_fixture():
    fixture = _load_fixture()
    logical = fixture["logicalLineageEntry"]

    entry = LineageReference(
        schema=logical["schema"],
        subject=LineageSubject(
            request_id=logical["subject"]["requestId"],
            operation_id=logical["subject"].get("operationId"),
        ),
        verification=VerificationResult(level="none", valid=False, checked_at=""),
        leaf=logical.get("leaf"),
        root=logical.get("root"),
        sequence=logical.get("sequence"),
        previous_checkpoint=logical.get("previousCheckpoint"),
        checkpoint_time=logical.get("checkpointTime"),
        canonicalization=logical.get("canonicalization"),
        issuer=logical.get("issuer"),
        key_id=logical.get("keyId"),
    )

    canonical = canonical_json(_lineage_signable_dict(entry))
    assert canonical == fixture["expectedLineageCanonicalJson"]
    assert sha256_hex(canonical) == fixture["expectedLineageSha256Hex"]

    key = fixture["hmacKeyUtf8"].encode("utf-8")
    assert _hmac_sha256_hex(key, canonical) == fixture["expectedLineageHmacSha256Hex"]


def test_conformance_signable_dict_leaves_opaque_usage_keys_untouched():
    """The camelCase rename applies only to the receipt's own schema
    fields; opaque caller-supplied blobs (``usage``) must canonicalize
    verbatim (sorted, but never re-keyed), matching Node/Rust."""
    fixture = _load_fixture()
    logical = fixture["logicalReceipt"]
    receipt = ExecutionReceipt(
        schema=logical["schema"],
        receipt_id=logical["receiptId"],
        product=logical["product"],
        contract_version=logical["contractVersion"],
        subject=ReceiptSubject(request_id=logical["subject"]["requestId"]),
        started_at=logical["startedAt"],
        outcome=logical["outcome"],
        verification=VerificationResult(level="none", valid=False, checked_at=""),
        usage=logical["usage"],
    )
    signable = _receipt_signable_dict(receipt)
    assert signable["usage"] == {
        "prompt_tokens": 128,
        "completion_tokens": 64,
        "cacheHitRatio": 0.5,
    }
