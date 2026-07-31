"""Result and metadata envelope (ADR-0024a §D4).

The receipt/drift-comparison logic described in §D4's "body and headers
duplicate receipt fields" paragraph remains deferred (still not implemented
this pass -- only decoding a receipt already present on the response, not
comparing it against header/body duplicates), but ``MetaLlmReceipt`` itself
is now the concrete ADR-0024b §D3 shape (issue #59, D11 migration step 1)
rather than the earlier ``Any`` placeholder.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, TypeVar

from cognitum.meta_llm.types.receipt import MetaLlmReceipt

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
