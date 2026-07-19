"""``wait_for_operation`` tests (ADR-0023 §D8/§D9)."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from cognitum.agentic import AgenticError
from cognitum.agentic.operations import OperationSnapshot, OperationState, wait_for_operation


def snapshot(state: OperationState) -> OperationSnapshot:
    return OperationSnapshot(id="op-1", state=state, updated_at="2026-01-01T00:00:00Z")


@dataclass
class _FakeHandle:
    states: list[OperationState]
    call_count: int = 0

    async def get(self) -> OperationSnapshot:
        state = self.states[self.call_count]
        self.call_count += 1
        return snapshot(state)


async def _fail_sleep(_ms: float) -> None:
    raise AssertionError("must not sleep")


@pytest.mark.asyncio
async def test_returns_immediately_when_first_snapshot_is_terminal() -> None:
    handle = _FakeHandle(states=["completed"])
    result = await wait_for_operation(handle, sleep=_fail_sleep)
    assert result.state == "completed"


@pytest.mark.asyncio
async def test_polls_through_pending_and_running_and_returns_on_completed() -> None:
    handle = _FakeHandle(states=["pending", "running", "running", "completed"])
    sleeps: list[float] = []

    async def record_sleep(ms: float) -> None:
        sleeps.append(ms)

    result = await wait_for_operation(handle, sleep=record_sleep)
    assert result.state == "completed"
    assert handle.call_count == 4
    assert len(sleeps) == 3


@pytest.mark.asyncio
async def test_returns_on_approval_required_without_throwing() -> None:
    handle = _FakeHandle(states=["approval_required"])
    result = await wait_for_operation(handle, sleep=_fail_sleep)
    assert result.state == "approval_required"


@pytest.mark.asyncio
async def test_keeps_polling_through_cancellation_requested_until_real_terminal_state() -> None:
    handle = _FakeHandle(states=["cancellation_requested", "completed"])

    async def sleep(_ms: float) -> None:
        return None

    result = await wait_for_operation(handle, sleep=sleep)
    assert result.state == "completed"


@pytest.mark.asyncio
async def test_deadline_exceeded_carries_latest_snapshot_never_marks_op_failed() -> None:
    handle = _FakeHandle(states=["running"] * 10)
    clock = {"now": 0.0}

    def now() -> float:
        return clock["now"]

    async def sleep(ms: float) -> None:
        clock["now"] += ms

    with pytest.raises(AgenticError) as exc_info:
        await wait_for_operation(handle, wait_deadline_ms=1000, now=now, sleep=sleep)

    err = exc_info.value
    assert err.kind == "deadline_exceeded"
    assert err.details["snapshot"].state == "running"


@pytest.mark.asyncio
async def test_uses_caller_injected_jitter_and_poll_interval_ms() -> None:
    handle = _FakeHandle(states=["running", "completed"])
    sleeps: list[float] = []

    async def record_sleep(ms: float) -> None:
        sleeps.append(ms)

    await wait_for_operation(
        handle,
        poll_interval_ms=100,
        jitter_ms=lambda _attempt: 7,
        sleep=record_sleep,
    )
    # attempt 0: base 100 * 2**0 + jitter 7 = 107, floor(server_hint=0) => 107, cap 30000 => 107
    assert sleeps == [107]


@pytest.mark.asyncio
async def test_retries_retryable_agentic_error_but_propagates_non_retryable() -> None:
    class FlakyThenOk:
        def __init__(self) -> None:
            self.calls = 0

        async def get(self) -> OperationSnapshot:
            self.calls += 1
            if self.calls == 1:
                raise AgenticError("transport", "transient blip", retryable=True)
            return snapshot("completed")

    async def sleep(_ms: float) -> None:
        return None

    flaky = FlakyThenOk()
    result = await wait_for_operation(flaky, sleep=sleep)
    assert result.state == "completed"
    assert flaky.calls == 2

    class AlwaysDenied:
        async def get(self) -> OperationSnapshot:
            raise AgenticError("permission_denied", "nope", retryable=False)

    with pytest.raises(AgenticError) as exc_info:
        await wait_for_operation(AlwaysDenied(), sleep=_fail_sleep)
    assert exc_info.value.kind == "permission_denied"


@pytest.mark.asyncio
async def test_cancelled_locally_never_calls_remote_cancel() -> None:
    @dataclass
    class _Cancellation:
        is_cancelled: bool = True

    handle = _FakeHandle(states=["running"])
    with pytest.raises(AgenticError) as exc_info:
        await wait_for_operation(handle, cancellation=_Cancellation(), sleep=_fail_sleep)
    assert exc_info.value.kind == "cancelled"
