"""``chat.completions_stream()`` tests (ADR-0024a §D5) -- issue #58
streaming pass. Scoped per the task: a full successful stream, an early
termination with a typed terminal error (partial state preserved), and
confirmation that no retry occurs after the first response byte.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest

from cognitum.agentic import (
    AgenticError,
    RequestContext,
    StaticApiKeyCredentialProvider,
    TimeBudget,
)
from cognitum.meta_llm import ChatCompletionRequest, ChatMessage, MetaLlmClient, MetaLlmClientConfig
from cognitum.meta_llm.stream import ChatCompletionsStreamAccumulator

BASE_URL = "https://meta-llm.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="sk-test-canary-1234",
        product="meta-llm",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


def _chat_request() -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model="meta-llm-large", messages=[ChatMessage(role="user", content="hello")]
    )


class _ByteStream(httpx.AsyncByteStream):
    """Minimal `httpx.AsyncByteStream` subclass wrapping an async chunk
    iterable -- httpx's internal `_send_single_request` asserts
    `isinstance(response.stream, AsyncByteStream)`, so a bare async
    generator (which only duck-types `__aiter__`) is not accepted directly.

    When `fail_after_all_chunks` is set, a simulated socket reset is raised
    immediately after every chunk in `chunks` has already been yielded --
    i.e. "one (or more) events land, then the connection drops."
    """

    def __init__(self, chunks: list[bytes], *, fail_after_all_chunks: bool = False) -> None:
        self._chunks = chunks
        self._fail_after_all_chunks = fail_after_all_chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk
        if self._fail_after_all_chunks:
            raise httpx.ReadError("simulated socket reset")


def _chunks_then_close(chunks: list[bytes]) -> _ByteStream:
    return _ByteStream(chunks)


def _chunks_then_fail(chunks: list[bytes]) -> _ByteStream:
    return _ByteStream(chunks, fail_after_all_chunks=True)


class _HangingByteStream(httpx.AsyncByteStream):
    """Yields `chunks` (possibly none) and then hangs forever -- never
    closes, never raises -- simulating a server that accepted the
    connection, sent some bytes (or none at all), and then went silent
    without ever closing the socket. This is exactly the bug under test:
    without racing the read against a configured budget, the SDK's
    `body_iter.__anext__()` await blocks on this forever.
    """

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk
        await asyncio.Event().wait()  # never set -- hangs until cancelled


def _chunks_then_hang(chunks: list[bytes]) -> _HangingByteStream:
    return _HangingByteStream(chunks)


def _make_client(handler) -> tuple[MetaLlmClient, list[int]]:
    call_count = [0]

    async def counted_handler(request: httpx.Request) -> httpx.Response:
        call_count[0] += 1
        return await handler(request)

    transport = httpx.AsyncClient(transport=httpx.MockTransport(counted_handler))
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=_credential_provider(),
            transport=transport,
        )
    )
    return client, call_count


async def _collect(stream: AsyncIterator) -> tuple[list, Exception | None]:
    values = []
    try:
        async for value in stream:
            values.append(value)
    except Exception as error:  # noqa: BLE001 - intentionally broad, this is the collector
        return values, error
    return values, None


@pytest.mark.asyncio
async def test_full_successful_stream_ends_in_done() -> None:
    chunks = [
        b'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m",'
        b'"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
        b'"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        b"data: [DONE]\n\n",
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_close(chunks)
        )

    client, call_count = _make_client(handler)

    values, error = await _collect(client.chat.completions_stream(_chat_request()))

    assert error is None
    assert call_count[0] == 1

    accumulator = ChatCompletionsStreamAccumulator()
    for envelope in values:
        accumulator.absorb(envelope)
    snapshot = accumulator.snapshot()

    assert snapshot.role == "assistant"
    assert snapshot.content_by_choice[0] == "Hello world"
    assert snapshot.finish_reason_by_choice[0] == "stop"
    assert snapshot.usage.prompt_tokens == 3
    assert snapshot.usage.completion_tokens == 2
    assert snapshot.usage.total_tokens == 5
    assert snapshot.completed is True

    sequences = [v.sequence for v in values]
    assert sequences == sorted(sequences)
    assert len(set(sequences)) == len(sequences)


@pytest.mark.asyncio
async def test_early_termination_preserves_partial_state_and_raises_terminal_error() -> None:
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_close(chunks)
        )

    client, _call_count = _make_client(handler)

    values, error = await _collect(client.chat.completions_stream(_chat_request()))

    accumulator = ChatCompletionsStreamAccumulator()
    for envelope in values:
        accumulator.absorb(envelope)
    snapshot = accumulator.snapshot()
    assert snapshot.content_by_choice[0] == "partial"
    assert snapshot.completed is False

    assert isinstance(error, AgenticError)
    assert error.kind == "protocol"
    assert error.code == "stream_ended_without_terminal_event"
    assert error.retryable is False
    assert error.details is not None
    assert error.details["partial"] is True


@pytest.mark.asyncio
async def test_no_retry_after_first_byte_on_mid_stream_disconnect() -> None:
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":'
        b'{"content":"one event then drop"},"finish_reason":null}]}\n\n',
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_chunks_then_fail(chunks),
        )

    client, call_count = _make_client(handler)

    _values, error = await _collect(client.chat.completions_stream(_chat_request()))

    assert call_count[0] == 1
    assert isinstance(error, AgenticError)
    assert error.kind == "transport"
    assert error.code == "stream_disconnected"
    assert error.retryable is False


@pytest.mark.asyncio
async def test_idle_timeout_preserves_partial_state_and_raises() -> None:
    """Two valid events land immediately, then the server goes silent
    forever without closing the socket. Without racing the read against
    `idle_timeout_ms`, this hangs forever regardless of the configured
    budget.
    """
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":'
        b'{"content":"before the hang"},"finish_reason":null}]}\n\n',
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_hang(chunks)
        )

    client, _call_count = _make_client(handler)

    context = RequestContext(
        request_id="test-idle-timeout",
        normalized_origin=BASE_URL,
        time_budget=TimeBudget(idle_timeout_ms=30),
    )
    values, error = await asyncio.wait_for(
        _collect(client.chat.completions_stream(_chat_request(), request_context=context)),
        timeout=5,
    )

    accumulator = ChatCompletionsStreamAccumulator()
    for envelope in values:
        accumulator.absorb(envelope)
    snapshot = accumulator.snapshot()
    assert snapshot.content_by_choice[0] == "before the hang"
    assert snapshot.completed is False

    assert isinstance(error, AgenticError)
    assert error.kind == "deadline_exceeded"
    assert error.code == "idle_timeout"
    assert error.retryable is False
    assert error.details is not None
    assert error.details["partial"] is True


@pytest.mark.asyncio
async def test_first_byte_timeout_raises_when_no_byte_ever_arrives() -> None:
    """No chunks at all -- the connection is accepted but the server never
    sends a single byte.
    """

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_hang([])
        )

    client, _call_count = _make_client(handler)

    context = RequestContext(
        request_id="test-first-byte-timeout",
        normalized_origin=BASE_URL,
        time_budget=TimeBudget(first_byte_timeout_ms=30),
    )
    values, error = await asyncio.wait_for(
        _collect(client.chat.completions_stream(_chat_request(), request_context=context)),
        timeout=5,
    )

    assert values == []
    assert isinstance(error, AgenticError)
    assert error.kind == "deadline_exceeded"
    assert error.code == "first_byte_timeout"
    assert error.retryable is False


@pytest.mark.asyncio
async def test_request_deadline_ms_alone_raises_when_exceeded() -> None:
    """The specific gap this bug fixed: a caller who sets ONLY
    `request_deadline_ms` (no `idle_timeout_ms`/`first_byte_timeout_ms`)
    must still have the read bounded -- previously `remaining_wait` was
    only ever derived from `idle_limit_ms`, so a deadline-only budget was
    never raced against at all and this would hang forever.
    """
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_hang(chunks)
        )

    client, _call_count = _make_client(handler)

    context = RequestContext(
        request_id="test-deadline-only",
        normalized_origin=BASE_URL,
        time_budget=TimeBudget(request_deadline_ms=30),
    )
    values, error = await asyncio.wait_for(
        _collect(client.chat.completions_stream(_chat_request(), request_context=context)),
        timeout=5,
    )

    accumulator = ChatCompletionsStreamAccumulator()
    for envelope in values:
        accumulator.absorb(envelope)
    assert accumulator.snapshot().completed is False

    assert isinstance(error, AgenticError)
    assert error.kind == "deadline_exceeded"
    assert error.code == "request_deadline_exceeded"
    assert error.retryable is False
