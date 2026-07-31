"""``chat_completions_stream`` HTTP + SSE orchestration (ADR-0024a §D5).
Issue #58 / M2 continuation -- the first (and, this pass, only) protocol
wired onto the generic :mod:`cognitum.sse` parser. Anthropic Messages
streaming and Responses streaming are explicitly DEFERRED to follow-up
work; they reuse the same generic parser.

Pre-byte behavior mirrors ``nonstream.post_json_idempotent`` (credential
acquisition, 401-refresh-once, bounded 429/502/503 retry) with one
deliberate difference: ADR-0024a §D7 generates an SDK idempotency key only
for "a direct nonstream call" -- streams are excluded -- so no
``Idempotency-Key`` header is sent here.

Post-byte behavior is the ADR-0023 §D6 / ADR-0024a §D5 contract: once any
response byte has been read, there is NO retry, period -- a mid-stream
disconnect, parse failure, cancellation, or timeout all surface as a typed
terminal error raised out of the async generator, with whatever events
were already ``yield``ed standing as the partial result (the SDK never
synthesizes a fake terminal event or claims rollback happened).

Idle/first-byte/total-time budgets come from the frozen ADR-0023
``TimeBudget`` dataclass (:mod:`cognitum.agentic`), read from
``request_context.time_budget``; cancellation from
``request_context.cancellation`` (``CancellationToken``) -- both
already-existing ``RequestContext`` fields, no new plumbing needed.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import DEFAULT_RETRY_POLICY, AgenticError, equal_jitter_delay_ms
from cognitum.agentic.wire import request_body
from cognitum.meta_llm.http_errors import map_meta_llm_http_error
from cognitum.meta_llm.nonstream import _apply_auth, _require_credential
from cognitum.meta_llm.stream.envelope import MetaLlmStreamEnvelope
from cognitum.meta_llm.stream.openai_events import OpenAiStreamEvent, decode_openai_sse_event
from cognitum.sse import SseEvent, SseParseError, SseParser

if TYPE_CHECKING:
    from cognitum.agentic import RequestContext
    from cognitum.meta_llm.config import MetaLlmClientConfig
    from cognitum.meta_llm.types import ChatCompletionRequest

_PRODUCT = "meta-llm"
_OPERATION = "chat.completions_stream"


def _new_request_id() -> str:
    return str(uuid.uuid4())


def _deadline_error(code: str, message: str, sequence: int) -> AgenticError:
    return AgenticError(
        "deadline_exceeded",
        message,
        product=_PRODUCT,
        operation=_OPERATION,
        retryable=False,
        code=code,
        details={"partial": True, "events_received": sequence},
    )


async def _open_stream_with_pre_byte_retry(
    config: MetaLlmClientConfig,
    transport: httpx.AsyncClient,
    request: dict[str, Any],
    request_id: str,
) -> tuple[httpx.Response, Any]:
    """The pre-byte phase: acquire a credential, send the request, and retry
    per the same bounded policy as ``post_json_idempotent`` for 401 (once)
    and 429/502/503 (bounded) -- all BEFORE any response bytes are read. No
    ``Idempotency-Key`` header (ADR-0024a §D7 excludes streams). Returns the
    entered response plus its context manager (the caller is responsible for
    exiting it once streaming is done).
    """
    credential = await _require_credential(config, _OPERATION)
    body = {**request, "stream": True}

    retry_policy = DEFAULT_RETRY_POLICY
    attempt = 0
    sleep_budget_used_ms = 0.0
    refreshed_once = False

    while True:
        headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            "X-Cognitum-Request-Id": request_id,
        }
        _apply_auth(headers, credential)
        url = f"{config.base_url}/v1/chat/completions"

        cm = transport.stream("POST", url, headers=headers, json=body)
        try:
            response = await cm.__aenter__()
        except httpx.HTTPError as cause:
            raise AgenticError(
                "transport",
                f"{_OPERATION} request failed: {cause}",
                product=_PRODUCT,
                operation=_OPERATION,
                request_id=request_id,
                retryable=True,
                cause=cause,
            ) from cause

        if response.status_code < 400:
            return response, cm

        try:
            await response.aread()
            err = map_meta_llm_http_error(response, _OPERATION, request_id)
        finally:
            await cm.__aexit__(None, None, None)

        if err.status == 401 and not refreshed_once:
            refreshed_once = True
            if config.credential_provider is not None:
                await config.credential_provider.invalidate("401 challenge from meta-llm")
            credential = await _require_credential(config, _OPERATION)
            continue

        is_bounded_retryable = err.status in (429, 502, 503)
        if is_bounded_retryable and attempt + 1 < retry_policy.max_attempts:
            server_hint_ms = err.retry_after_ms or 0
            jitter_ms = random.uniform(0, retry_policy.base_ms)
            delay_ms = equal_jitter_delay_ms(attempt, retry_policy, server_hint_ms, int(jitter_ms))
            if sleep_budget_used_ms + delay_ms > retry_policy.retry_sleep_budget_ms:
                raise err
            sleep_budget_used_ms += delay_ms
            await asyncio.sleep(delay_ms / 1000)
            attempt += 1
            continue

        raise err


def _build_envelopes(
    raw_event: SseEvent, request_id: str, sequence_box: list[int]
) -> list[MetaLlmStreamEnvelope[OpenAiStreamEvent]]:
    decoded = decode_openai_sse_event(raw_event)
    envelopes = []
    for event in decoded.events:
        sequence_box[0] += 1
        envelopes.append(
            MetaLlmStreamEnvelope(
                event=event,
                sequence=sequence_box[0],
                received_at=_now_iso(),
                request_id=request_id,
                raw_event_name=raw_event.event,
                unknown_fields=decoded.unknown_fields,
            )
        )
    return envelopes


def _now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat()


async def _read_sse_body(
    response: httpx.Response,
    request_id: str,
    time_budget: Any,
    cancellation: Any,
) -> AsyncIterator[MetaLlmStreamEnvelope[OpenAiStreamEvent]]:
    """Post-byte phase: read the SSE body, applying idle/first-byte/total
    budgets and cooperative cancellation.
    """
    parser = SseParser()
    sequence_box = [0]
    saw_terminal = False
    stream_started_at = time.monotonic()
    last_byte_at = stream_started_at
    received_first_byte = False

    body_iter = response.aiter_bytes().__aiter__()

    try:
        while True:
            if cancellation is not None and cancellation.is_cancelled:
                raise AgenticError(
                    "cancelled",
                    f"{_OPERATION} was cancelled locally",
                    product=_PRODUCT,
                    operation=_OPERATION,
                    request_id=request_id,
                    retryable=False,
                    code="local_cancellation",
                    details={"partial": True, "events_received": sequence_box[0]},
                )

            now = time.monotonic()
            if time_budget is not None and time_budget.request_deadline_ms is not None:
                elapsed_ms = (now - stream_started_at) * 1000
                if elapsed_ms > time_budget.request_deadline_ms:
                    raise _deadline_error(
                        "request_deadline_exceeded",
                        f"{_OPERATION} exceeded request_deadline_ms "
                        f"({time_budget.request_deadline_ms}ms)",
                        sequence_box[0],
                    )

            idle_limit_ms = None
            if time_budget is not None:
                idle_limit_ms = (
                    time_budget.idle_timeout_ms
                    if received_first_byte
                    else time_budget.first_byte_timeout_ms
                )
            if idle_limit_ms is not None:
                silence_ms = (now - last_byte_at) * 1000
                if silence_ms > idle_limit_ms:
                    raise _deadline_error(
                        "idle_timeout" if received_first_byte else "first_byte_timeout",
                        f"{_OPERATION} exceeded "
                        f"{'idle_timeout_ms' if received_first_byte else 'first_byte_timeout_ms'} "
                        f"({idle_limit_ms}ms)",
                        sequence_box[0],
                    )

            # Bound the otherwise-unbounded `body_iter.__anext__()` await
            # against whichever budget is smallest, so a server that accepts
            # the connection and then goes silent without closing the
            # socket cannot hang this generator forever. Previously this
            # only raced against `idle_limit_ms` -- a caller who set ONLY
            # `request_deadline_ms` (no idle/first-byte timeout) got no
            # race at all and could hang past their configured deadline.
            remaining_wait_candidates: list[float] = []
            if idle_limit_ms is not None:
                idle_remaining = idle_limit_ms / 1000 - (now - last_byte_at)
                remaining_wait_candidates.append(max(0.0, idle_remaining))
            if time_budget is not None and time_budget.request_deadline_ms is not None:
                remaining_wait_candidates.append(
                    max(0.0, time_budget.request_deadline_ms / 1000 - (now - stream_started_at))
                )
            remaining_wait = min(remaining_wait_candidates) if remaining_wait_candidates else None

            try:
                if remaining_wait is not None:
                    chunk = await asyncio.wait_for(
                        body_iter.__anext__(), timeout=remaining_wait or 0.001
                    )
                else:
                    chunk = await body_iter.__anext__()
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                continue  # loop back around; the top-of-loop deadline check will raise precisely
            except httpx.HTTPError as cause:
                raise AgenticError(
                    "transport",
                    f"{_OPERATION} stream read failed: {cause}",
                    product=_PRODUCT,
                    operation=_OPERATION,
                    request_id=request_id,
                    retryable=False,
                    code="stream_disconnected",
                    details={"partial": True, "events_received": sequence_box[0]},
                    cause=cause,
                ) from cause

            received_first_byte = True
            last_byte_at = time.monotonic()

            try:
                raw_events = parser.feed(chunk)
            except SseParseError as cause:
                raise AgenticError(
                    "protocol",
                    f"{_OPERATION} SSE parse failure: {cause}",
                    product=_PRODUCT,
                    operation=_OPERATION,
                    request_id=request_id,
                    retryable=False,
                    code="sse_parse_error",
                    details={"partial": True, "events_received": sequence_box[0]},
                    cause=cause,
                ) from cause

            for raw_event in raw_events:
                for envelope in _build_envelopes(raw_event, request_id, sequence_box):
                    if envelope.event.type in ("done", "finish_reason"):
                        saw_terminal = True
                    yield envelope

        try:
            finish_result = parser.finish()
        except SseParseError as cause:
            raise AgenticError(
                "protocol",
                f"{_OPERATION} SSE parse failure at end of stream: {cause}",
                product=_PRODUCT,
                operation=_OPERATION,
                request_id=request_id,
                retryable=False,
                code="sse_parse_error",
                details={"partial": True, "events_received": sequence_box[0]},
                cause=cause,
            ) from cause

        for raw_event in finish_result.events:
            for envelope in _build_envelopes(raw_event, request_id, sequence_box):
                if envelope.event.type in ("done", "finish_reason"):
                    saw_terminal = True
                yield envelope
    except GeneratorExit:
        # The caller stopped iterating early (e.g. `break`d out of a `for
        # await`) without us ever raising -- nothing further to clean up
        # here (the response/context-manager close is the outer
        # `chat_completions_stream`'s job), just let the generator close.
        raise

    if not saw_terminal:
        raise AgenticError(
            "protocol",
            f"{_OPERATION} stream ended without ever observing a terminal event",
            product=_PRODUCT,
            operation=_OPERATION,
            request_id=request_id,
            retryable=False,
            code="stream_ended_without_terminal_event",
            details={"partial": True, "events_received": sequence_box[0]},
        )


async def chat_completions_stream(
    config: MetaLlmClientConfig,
    transport: httpx.AsyncClient,
    request: ChatCompletionRequest,
    request_context: RequestContext | None = None,
) -> AsyncIterator[MetaLlmStreamEnvelope[OpenAiStreamEvent]]:
    """``POST /v1/chat/completions`` with ``stream=True``. Async-generator
    function -- iterate with ``async for``. Completes normally only after
    observing the OpenAI wire terminal condition (``[DONE]`` or a
    ``finish_reason``); any other end-of-iteration raises an
    :class:`AgenticError` describing exactly why, per ADR-0024a §D5.
    """

    time_budget = request_context.time_budget if request_context is not None else None
    cancellation = request_context.cancellation if request_context is not None else None
    request_id = request_context.request_id if request_context is not None else _new_request_id()

    body = request_body(request)
    response, cm = await _open_stream_with_pre_byte_retry(config, transport, body, request_id)
    try:
        async for envelope in _read_sse_body(response, request_id, time_budget, cancellation):
            yield envelope
    finally:
        await cm.__aexit__(None, None, None)


__all__ = ["chat_completions_stream"]
