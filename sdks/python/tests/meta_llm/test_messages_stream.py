"""``messages.create_stream()`` tests (ADR-0024a §D5) -- issue #58 M2
continuation, item 2 of the tracked "what's left" list. Mirrors
``test_chat_completions_stream.py``'s scope and helpers exactly,
substituting the Anthropic Messages wire protocol: ``message_start``
through ``message_stop`` (the wire terminal condition -- there is no
``[DONE]`` sentinel), ``ping`` decoding to a real event (not ``unknown``),
malformed-JSON tolerance, early termination without ``message_stop``, no
retry after the first byte, an idle-timeout budget case, and confirmation
that no ``Idempotency-Key`` header is ever sent.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import httpx
import pytest

from cognitum.agentic import (
    AgenticError,
    RequestContext,
    StaticApiKeyCredentialProvider,
    TimeBudget,
)
from cognitum.meta_llm import (
    AnthropicMessageParam,
    AnthropicMessageRequest,
    MetaLlmClient,
    MetaLlmClientConfig,
)

BASE_URL = "https://meta-llm.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="sk-test-canary-1234",
        product="meta-llm",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


def _message_request() -> AnthropicMessageRequest:
    return AnthropicMessageRequest(
        model="meta-llm-large",
        messages=[AnthropicMessageParam(role="user", content="hello")],
        max_tokens=256,
    )


def _sse_frame(event: str, data: dict) -> bytes:
    """``event: X\\ndata: {...}\\n\\n`` -- the real Anthropic wire shape (an
    explicit ``event:`` field, unlike OpenAI).
    """
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


class _ByteStream(httpx.AsyncByteStream):
    """Same helper as ``test_chat_completions_stream.py``'s -- httpx's
    internal ``_send_single_request`` asserts
    ``isinstance(response.stream, AsyncByteStream)``, so a bare async
    generator is not accepted directly.
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
    """Yields ``chunks`` (possibly none) and then hangs forever -- never
    closes, never raises.
    """

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk
        await asyncio.Event().wait()  # never set -- hangs until cancelled


def _chunks_then_hang(chunks: list[bytes]) -> _HangingByteStream:
    return _HangingByteStream(chunks)


def _make_client(handler) -> tuple[MetaLlmClient, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    async def recording_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return await handler(request)

    transport = httpx.AsyncClient(transport=httpx.MockTransport(recording_handler))
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=_credential_provider(),
            transport=transport,
        )
    )
    return client, requests


async def _collect(stream: AsyncIterator) -> tuple[list, Exception | None]:
    values = []
    try:
        async for value in stream:
            values.append(value)
    except Exception as error:  # noqa: BLE001 - intentionally broad, this is the collector
        return values, error
    return values, None


@pytest.mark.asyncio
async def test_full_successful_stream_ends_in_message_stop() -> None:
    chunks = [
        _sse_frame(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": "m",
                    "stop_reason": None,
                    "usage": {"input_tokens": 10, "output_tokens": 0},
                },
            },
        ),
        _sse_frame(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        _sse_frame(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hello"},
            },
        ),
        _sse_frame(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": " world"},
            },
        ),
        _sse_frame("content_block_stop", {"type": "content_block_stop", "index": 0}),
        _sse_frame(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 5},
            },
        ),
        _sse_frame("message_stop", {"type": "message_stop"}),
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_close(chunks)
        )

    client, requests = _make_client(handler)

    values, error = await _collect(client.messages.create_stream(_message_request()))

    assert error is None
    assert len(requests) == 1

    kinds = [v.event.type for v in values]
    assert kinds == [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]

    message_start = values[0].event
    assert message_start.message.usage.input_tokens == 10
    assert message_start.message.usage.output_tokens == 0

    message_delta = values[5].event
    assert message_delta.delta["stop_reason"] == "end_turn"
    assert message_delta.usage["output_tokens"] == 5

    sequences = [v.sequence for v in values]
    assert sequences == sorted(sequences)
    assert len(set(sequences)) == len(sequences)

    # No Idempotency-Key header for a stream call (ADR-0024a §D7 stream exclusion).
    assert "idempotency-key" not in {k.lower() for k in requests[0].headers}


@pytest.mark.asyncio
async def test_ping_decodes_to_a_real_event() -> None:
    chunks = [
        _sse_frame(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": "m",
                    "stop_reason": None,
                    "usage": {"input_tokens": 1, "output_tokens": 0},
                },
            },
        ),
        _sse_frame("ping", {"type": "ping"}),
        _sse_frame("message_stop", {"type": "message_stop"}),
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_close(chunks)
        )

    client, _requests = _make_client(handler)

    values, error = await _collect(client.messages.create_stream(_message_request()))

    assert error is None
    ping_events = [v for v in values if v.event.type == "ping"]
    assert len(ping_events) == 1
    unknown_events = [v for v in values if v.event.type == "unknown"]
    assert unknown_events == []


@pytest.mark.asyncio
async def test_malformed_payload_decodes_to_unknown_without_raising() -> None:
    chunks = [
        _sse_frame(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": "m",
                    "stop_reason": None,
                    "usage": {"input_tokens": 1, "output_tokens": 0},
                },
            },
        ),
        b"event: weird\ndata: not-json-at-all{{{\n\n",
        _sse_frame("message_stop", {"type": "message_stop"}),
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_close(chunks)
        )

    client, _requests = _make_client(handler)

    values, error = await _collect(client.messages.create_stream(_message_request()))

    assert error is None
    unknown_events = [v for v in values if v.event.type == "unknown"]
    assert len(unknown_events) == 1


@pytest.mark.asyncio
async def test_early_termination_preserves_partial_state_and_raises_terminal_error() -> None:
    chunks = [
        _sse_frame(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": "m",
                    "stop_reason": None,
                    "usage": {"input_tokens": 1, "output_tokens": 0},
                },
            },
        ),
        _sse_frame(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "partial"},
            },
        ),
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_close(chunks)
        )

    client, _requests = _make_client(handler)

    values, error = await _collect(client.messages.create_stream(_message_request()))

    assert any(v.event.type == "content_block_delta" for v in values)

    assert isinstance(error, AgenticError)
    assert error.kind == "protocol"
    assert error.code == "stream_ended_without_terminal_event"
    assert error.retryable is False
    assert error.details is not None
    assert error.details["partial"] is True


@pytest.mark.asyncio
async def test_no_retry_after_first_byte_on_mid_stream_disconnect() -> None:
    chunks = [
        _sse_frame(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "one event then drop"},
            },
        ),
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_chunks_then_fail(chunks),
        )

    client, requests = _make_client(handler)

    _values, error = await _collect(client.messages.create_stream(_message_request()))

    assert len(requests) == 1
    assert isinstance(error, AgenticError)
    assert error.kind == "transport"
    assert error.code == "stream_disconnected"
    assert error.retryable is False


@pytest.mark.asyncio
async def test_idle_timeout_preserves_partial_state_and_raises() -> None:
    """Two valid events land immediately, then the server goes silent
    forever without closing the socket.
    """
    chunks = [
        _sse_frame(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "before the hang"},
            },
        ),
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_hang(chunks)
        )

    client, _requests = _make_client(handler)

    context = RequestContext(
        request_id="test-idle-timeout",
        normalized_origin=BASE_URL,
        time_budget=TimeBudget(idle_timeout_ms=30),
    )
    values, error = await asyncio.wait_for(
        _collect(client.messages.create_stream(_message_request(), request_context=context)),
        timeout=5,
    )

    assert any(v.event.type == "content_block_delta" for v in values)

    assert isinstance(error, AgenticError)
    assert error.kind == "deadline_exceeded"
    assert error.code == "idle_timeout"
    assert error.retryable is False
    assert error.details is not None
    assert error.details["partial"] is True


@pytest.mark.asyncio
async def test_first_byte_timeout_raises_when_no_byte_ever_arrives() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_chunks_then_hang([])
        )

    client, _requests = _make_client(handler)

    context = RequestContext(
        request_id="test-first-byte-timeout",
        normalized_origin=BASE_URL,
        time_budget=TimeBudget(first_byte_timeout_ms=30),
    )
    values, error = await asyncio.wait_for(
        _collect(client.messages.create_stream(_message_request(), request_context=context)),
        timeout=5,
    )

    assert values == []
    assert isinstance(error, AgenticError)
    assert error.kind == "deadline_exceeded"
    assert error.code == "first_byte_timeout"
    assert error.retryable is False
