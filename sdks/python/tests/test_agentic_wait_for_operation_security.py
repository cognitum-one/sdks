"""Security-boundary tests for wait_for_operation."""

from __future__ import annotations

import pytest

from cognitum.agentic import AgenticError
from cognitum.agentic.operations import OperationSnapshot, wait_for_operation


@pytest.mark.asyncio
async def test_permission_denial_is_never_retried() -> None:
    class AlwaysDenied:
        def __init__(self) -> None:
            self.calls = 0

        async def get(self) -> OperationSnapshot[object]:
            self.calls += 1
            raise AgenticError("permission_denied", "denied", retryable=False)

    denied = AlwaysDenied()
    with pytest.raises(AgenticError) as exc_info:
        await wait_for_operation(denied)
    assert exc_info.value.kind == "permission_denied"
    assert denied.calls == 1


@pytest.mark.asyncio
async def test_retryable_polling_is_bounded_by_deadline() -> None:
    class AlwaysRetryable:
        async def get(self) -> OperationSnapshot[object]:
            raise AgenticError("transport", "retry", retryable=True)

    clock = {"now": 0.0}

    async def sleep(ms: float) -> None:
        clock["now"] += ms

    with pytest.raises(AgenticError) as exc_info:
        await wait_for_operation(
            AlwaysRetryable(),
            wait_deadline_ms=10,
            poll_interval_ms=5,
            jitter_ms=lambda _attempt: 0,
            now=lambda: clock["now"],
            sleep=sleep,
        )
    assert exc_info.value.kind == "deadline_exceeded"
