"""OperationHandle / OperationState and transport-neutral pagination /
event-stream primitives (ADR-0019 §D5, ADR-0023 §D9), plus a shared
``wait_for_operation`` polling-loop helper (ADR-0023 §D8/§D9, issue #55).

The event-stream resumption behavior described in ADR-0023 §D6 (boundary-
event dedup, gap/regression detection, ``Last-Event-ID`` replay) deliberately
does NOT ship here -- every durable-operation client that would consume it
(HarnessaaS async jobs, Meta-LLM batches, Meta-Proxy sponsor ops) is still
blocked on its own upstream contract landing (issues #59, #62, #68).
Designing that resumption logic without a real consumer to validate it
against risks freezing the wrong contract -- see the M1 cross-language
consistency review's fail-closed philosophy.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import (
    Any,
    Generic,
    Literal,
    Protocol,
    TypeVar,
    runtime_checkable,
)

from cognitum.agentic.errors import (
    DEFAULT_RETRY_POLICY,
    AgenticError,
    RetryPolicy,
    equal_jitter_delay_ms,
)

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

    ``events`` is only present in behavior when the product capability set
    declares event-stream support -- see ADR-0019 §D6.

    ``cancel`` is always declared but MUST fail closed: implementations
    that don't support cancellation MUST raise
    :class:`cognitum.agentic.errors.UnsupportedCapabilityError` rather than
    silently returning ``None`` (FIX 4 of the M1 cross-language
    consistency review, per ADR-0019 §D6's fail-closed philosophy; Rust's
    default ``OperationHandle::cancel`` already does this and is the
    reference behavior).
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

    async def cancel(self) -> OperationSnapshot[TResult]: ...

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


#: Snapshot states that end a :func:`wait_for_operation` poll loop
#: (ADR-0023 §D9). ``approval_required`` is included per D9's "Approval-
#: required is a state, not an exception" -- polling further can't resolve
#: it without out-of-band human action, so it's returned like any other
#: terminal snapshot rather than awaited through.
_WAIT_TERMINAL_STATES: frozenset[OperationState] = frozenset(
    {"completed", "failed", "cancelled", "approval_required"}
)


@runtime_checkable
class _HasGet(Protocol[TResult]):
    async def get(self) -> OperationSnapshot[TResult]: ...


@runtime_checkable
class _HasIsCancelled(Protocol):
    @property
    def is_cancelled(self) -> bool: ...


def _default_now_ms() -> float:
    return time.monotonic() * 1000


async def _default_sleep_ms(ms: float) -> None:
    await asyncio.sleep(ms / 1000)


async def wait_for_operation(
    handle: _HasGet[TResult],
    *,
    wait_deadline_ms: int | None = None,
    poll_interval_ms: int | None = None,
    retry_policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    cancellation: _HasIsCancelled | None = None,
    now: Callable[[], float] = _default_now_ms,
    sleep: Callable[[float], Awaitable[None]] = _default_sleep_ms,
    jitter_ms: Callable[[int], int] | None = None,
) -> OperationSnapshot[TResult]:
    """Product-agnostic polling loop implementing
    :meth:`OperationHandle.wait`'s shared semantics (ADR-0023 §D8/§D9):
    bounded equal-jitter backoff (the exact algorithm ADR-0005/ADR-0023
    already freeze -- see :func:`cognitum.agentic.errors.equal_jitter_delay_ms`),
    a ``wait_deadline_ms`` ceiling that raises ``deadline_exceeded`` with
    the latest snapshot attached (never marks the remote operation itself
    failed or cancelled), and early return on any terminal state
    (including ``approval_required``, per D9). Poll iterations are bounded
    only by the wait deadline, not ``retry_policy.max_attempts`` -- that
    field governs a single HTTP request's retry budget, a distinct concern
    from "keep checking a long-running job" (D9: "not counted as retrying
    the operation itself").

    A concrete ``OperationHandle`` implementation's own ``wait()`` method
    is expected to delegate to this helper rather than re-implementing
    backoff by hand -- this is the "same bounded jitter policy" D9
    requires every product client to share.
    """
    effective_jitter = jitter_ms or (lambda _attempt: 0)
    poll_policy = (
        RetryPolicy(
            base_ms=poll_interval_ms,
            cap_ms=retry_policy.cap_ms,
            max_attempts=retry_policy.max_attempts,
            retry_sleep_budget_ms=retry_policy.retry_sleep_budget_ms,
        )
        if poll_interval_ms is not None
        else retry_policy
    )

    started_at = now()
    attempt = 0
    last_snapshot: OperationSnapshot[TResult] | None = None

    while True:
        if cancellation is not None and cancellation.is_cancelled:
            raise AgenticError(
                "cancelled",
                "wait_for_operation cancelled locally",
                retryable=False,
                details={"snapshot": last_snapshot} if last_snapshot is not None else None,
            )

        try:
            snapshot = await handle.get()
        except AgenticError as cause:
            # Poll transient failures consume the wait budget, not the
            # request's own HTTP retry budget (D9) -- a non-retryable
            # failure propagates immediately; a retryable one falls
            # through to the same backoff loop bounded by
            # wait_deadline_ms below.
            if not cause.retryable:
                raise
            if last_snapshot is not None:
                snapshot = last_snapshot
            else:
                snapshot = OperationSnapshot(id="", state="pending", updated_at="")
        last_snapshot = snapshot

        if snapshot.state in _WAIT_TERMINAL_STATES:
            return snapshot

        if wait_deadline_ms is not None and now() - started_at >= wait_deadline_ms:
            raise AgenticError(
                "deadline_exceeded",
                f"wait_for_operation exceeded wait_deadline_ms={wait_deadline_ms} "
                "without reaching a terminal state",
                retryable=False,
                details={"snapshot": last_snapshot},
            )

        delay_ms = equal_jitter_delay_ms(attempt, poll_policy, 0, effective_jitter(attempt))
        await sleep(delay_ms)
        attempt += 1


__all__ = [
    "OperationState",
    "OperationSnapshot",
    "WaitOptions",
    "EventStreamOptions",
    "OperationEvent",
    "OperationHandle",
    "PageRequest",
    "Page",
    "wait_for_operation",
]
