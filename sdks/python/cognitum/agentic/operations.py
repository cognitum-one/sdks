"""OperationHandle / OperationState and transport-neutral pagination /
event-stream primitives (ADR-0019 §D5, ADR-0023 §D9).

Type-only scaffolding (issue #52 / M1) -- no polling loop or event-stream
implementation ships in this pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import (
    Any,
    AsyncIterator,
    Generic,
    Literal,
    Protocol,
    TypeVar,
    runtime_checkable,
)

from cognitum.agentic.errors import AgenticError

#: Native lifecycle states for a durable remote operation (ADR-0023 §D9).
OperationState = Literal[
    "pending",
    "running",
    "approval_required",
    "completed",
    "failed",
    "cancelled",
    "cancellation_requested",
]

TResult = TypeVar("TResult")
TPayload = TypeVar("TPayload")


@dataclass(frozen=True)
class OperationSnapshot(Generic[TResult]):
    """A point-in-time view of a durable operation, including terminal failures."""

    id: str
    state: OperationState
    updated_at: str
    result: TResult | None = None
    error: AgenticError | None = None


@dataclass(frozen=True)
class WaitOptions:
    """Options controlling :meth:`OperationHandle.wait`."""

    wait_deadline_ms: int | None = None
    poll_interval_ms: int | None = None


@dataclass(frozen=True)
class EventStreamOptions:
    """Options controlling :meth:`OperationHandle.events`."""

    last_event_id: str | None = None
    idle_timeout_ms: int | None = None


@dataclass(frozen=True)
class OperationEvent(Generic[TPayload]):
    """A single durable-operation event (ADR-0023 §D6)."""

    id: str
    type: str
    occurred_at: str
    payload: TPayload
    sequence: int | None = None


@runtime_checkable
class OperationHandle(Protocol[TResult]):
    """Common handle contract for remote batches, pods, and HarnessaaS jobs
    (ADR-0023 §D9).

    ``events`` and ``cancel`` are only present when the product capability
    set declares support -- see ADR-0019 §D6.
    """

    @property
    def id(self) -> str: ...

    @property
    def product(self) -> str: ...

    @property
    def origin_binding(self) -> str: ...

    @property
    def tenant_binding(self) -> str | None: ...

    @property
    def created_at(self) -> str: ...

    async def get(self) -> OperationSnapshot[TResult]: ...

    async def wait(
        self, options: WaitOptions | None = None
    ) -> OperationSnapshot[TResult]: ...

    def events(
        self, options: EventStreamOptions | None = None
    ) -> AsyncIterator[OperationEvent[Any]] | None: ...

    async def cancel(self) -> OperationSnapshot[TResult] | None: ...

    async def result(self) -> TResult: ...


@dataclass(frozen=True)
class PageRequest:
    """Cursor-based page request, independent of transport."""

    cursor: str | None = None
    limit: int | None = None


TItem = TypeVar("TItem")


@dataclass(frozen=True)
class Page(Generic[TItem]):
    """A single page of results."""

    items: list[TItem]
    has_more: bool
    next_cursor: str | None = None


__all__ = [
    "OperationState",
    "OperationSnapshot",
    "WaitOptions",
    "EventStreamOptions",
    "OperationEvent",
    "OperationHandle",
    "PageRequest",
    "Page",
]
