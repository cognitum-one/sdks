"""Result and metadata envelope (ADR-0024a §D4).

Type-only this pass -- the receipt/drift-comparison logic described in
§D4's "body and headers duplicate receipt fields" paragraph is deferred to
the follow-up issue that lands ADR-0024b's ``MetaLlmReceipt``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, TypeVar

#: Placeholder for ADR-0024b's ``MetaLlmReceipt``. Kept as ``object`` rather
#: than a shaped type so callers cannot accidentally treat an absent receipt
#: as a shaped, empty value (ADR-0024a §D4: "Missing metadata remains
#: missing").
MetaLlmReceipt = Any

T = TypeVar("T")


@dataclass(frozen=True)
class MetaLlmResponseMeta:
    """Per-response metadata carried alongside every ``MetaLlmResult`` (ADR-0024a §D4)."""

    request_id: str
    http_status: int
    protocol_version: str | None = None
    retry_after_ms: int | None = None
    idempotent_replay: bool | None = None
    receipt: MetaLlmReceipt | None = None
    warnings: list[str] | None = None
    unknown_headers: dict[str, str] | None = None


@dataclass(frozen=True)
class MetaLlmResult(Generic[T]):
    """Envelope wrapping every MetaLlmClient operation result (ADR-0024a §D4)."""

    data: T
    meta: MetaLlmResponseMeta


__all__ = ["MetaLlmReceipt", "MetaLlmResponseMeta", "MetaLlmResult"]
