"""ExecutionReceipt / LineageReference type-only stubs (ADR-0028 §D7, §D9).

Tracking issue #56 builds these out further (verification, canonical bytes,
signature checks). This pass only freezes the field shapes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

#: Ordered guarantee levels for any artifact/witness/receipt/lineage check
#: (ADR-0028 §D8).
VerificationLevel = Literal["none", "shape", "digest", "cryptographic", "anchored"]

#: Finality of a single cost observation within a receipt.
CostFinality = Literal[
    "estimate", "reserved", "committed", "provider_reported", "invoiced"
]


@dataclass(frozen=True)
class VerificationResult:
    """Tagged verification outcome.

    ``valid=True`` at ``shape`` MUST NOT satisfy a ``cryptographic``
    requirement.
    """

    level: VerificationLevel
    valid: bool
    checked_at: str
    algorithm: str | None = None
    key_id: str | None = None
    subject_digest: str | None = None
    warnings: list[str] | None = None
    failure: str | None = None


@dataclass(frozen=True)
class CostObservation:
    """A single labeled cost observation (ADR-0022 §D6 distinct-fields rule)."""

    source: str
    amount: float
    currency: str
    finality: CostFinality


@dataclass(frozen=True)
class ReceiptSubject:
    """Receipt subject binding -- binds to the operation and tenant without
    exposing raw tenant credentials."""

    request_id: str
    operation_id: str | None = None
    tenant_hash: str | None = None


@dataclass(frozen=True)
class ExecutionReceipt:
    """Verifiable common receipt envelope, v1 (ADR-0028 §D7).

    Type-only stub -- issue #56.
    """

    receipt_id: str
    product: str
    contract_version: str
    subject: ReceiptSubject
    started_at: str
    outcome: str
    verification: VerificationResult
    schema: Literal["cognitum.execution-receipt.v1"] = (
        "cognitum.execution-receipt.v1"
    )
    completed_at: str | None = None
    usage: dict[str, object] | None = None
    costs: list[CostObservation] = field(default_factory=list)
    artifact_digests: list[str] | None = None
    lineage_root: str | None = None
    canonicalization: str | None = None
    issuer: str | None = None
    key_id: str | None = None
    signature: str | None = None


@dataclass(frozen=True)
class LineageSubject:
    """Lineage subject binding."""

    request_id: str
    operation_id: str | None = None


@dataclass(frozen=True)
class LineageReference:
    """Verifiable lineage proof reference, v1 (ADR-0028 §D9).

    Type-only stub -- issue #56.
    """

    subject: LineageSubject
    verification: VerificationResult
    schema: Literal["cognitum.lineage-reference.v1"] = (
        "cognitum.lineage-reference.v1"
    )
    leaf: str | None = None
    root: str | None = None
    sequence: int | None = None
    previous_checkpoint: str | None = None
    checkpoint_time: str | None = None
    canonicalization: str | None = None
    issuer: str | None = None
    key_id: str | None = None
    signature: str | None = None


__all__ = [
    "VerificationLevel",
    "CostFinality",
    "VerificationResult",
    "CostObservation",
    "ReceiptSubject",
    "ExecutionReceipt",
    "LineageSubject",
    "LineageReference",
]
