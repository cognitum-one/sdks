"""Result and metadata envelope for HarnessaaSClient operations (ADR-0027a)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class HarnessaaSResponseMeta:
    """Per-response metadata carried alongside every ``HarnessaaSResult``."""

    request_id: str
    http_status: int
    retry_after_ms: int | None = None


@dataclass(frozen=True)
class HarnessaaSResult(Generic[T]):
    """Envelope wrapping every HarnessaaSClient operation result."""

    data: T
    meta: HarnessaaSResponseMeta


__all__ = ["HarnessaaSResponseMeta", "HarnessaaSResult"]
