"""``chat.completions_stream()`` tests (ADR-0025a §D8, M3 continuation of
issue #61). Mirrors ``meta_llm/test_chat_completions_stream.py``'s (PR #88)
style and ``meta_proxy/test_client.py``'s (PR #93) fixtures. Scoped per the
task: a full successful stream (terminal event + receipt decoded), the
idle-stream-timeout race (real race, not a pre-check), the required_plane
mismatch check firing on a streaming terminal receipt, no-retry-after-
first-byte on a mid-stream disconnect, and sponsored-stream-fails-locally.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest

from cognitum.agentic import AgenticError, UnsupportedCapabilityError
from cognitum.meta_llm.stream import ChatCompletionsStreamAccumulator
from cognitum.meta_llm.types import ChatCompletionRequest, ChatMessage
from cognitum.meta_proxy import (
    LocalBearerTokenCredentialProvider,
    MetaProxyChatCallOptions,
    MetaProxyClient,
    MetaProxyClientConfig,
    ProxyTimeBudget,
    RoutingIntent,
)

ORIGIN = "http://127.0.0.1:11435"


def _bearer_provider() -> LocalBearerTokenCredentialProvider:
    return LocalBearerTokenCredentialProvider(
        normalized_origin=ORIGIN, audience=ORIGIN, token="mh1.canary-local-token"
    )


def _chat_request() -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model="gpt-proxy", messages=[ChatMessage(role="user", content="hello")]
    )


class _ByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], *, fail_after_all_chunks: bool = False) -> None:
        self._chunks = chunks
        self._fail_after_all_chunks = fail_after_all_chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk
        if self._fail_after_all_chunks:
            raise httpx.ReadError("simulated socket reset")


class _HangingByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk
        await asyncio.Event().wait()  # never set -- hangs until cancelled


def _routing_receipt_chunk(selected_plane: str) -> bytes:
    return (
        b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
        b'"cognitum_routing_receipt":{"request_id":"rr-1","configured_plane":"local",'
        b'"selected_plane":"'
        + selected_plane.encode()
        + b'","routing_reason":"configured_default",'
        b'"automatic":false,"workload_policy":"standard","degraded":false},'
        b'"cognitum_upstream_receipt":{"provider":"cognitum","cost":"0.001"}}\n\n'
    )


def _make_client(handler) -> tuple[MetaProxyClient, list[int]]:
    call_count = [0]

    async def counted_handler(request: httpx.Request) -> httpx.Response:
        call_count[0] += 1
        return await handler(request)

    transport = httpx.AsyncClient(transport=httpx.MockTransport(counted_handler))
    config = MetaProxyClientConfig(
        origin=ORIGIN, local_credential_provider=_bearer_provider(), transport=transport
    )
    return MetaProxyClient(config), call_count


async def _collect(stream: AsyncIterator) -> tuple[list, Exception | None]:
    values = []
    try:
        async for value in stream:
            values.append(value)
    except Exception as error:  # noqa: BLE001 - intentionally broad, this is the collector
        return values, error
    return values, None


@pytest.mark.asyncio
async def test_full_successful_stream_decodes_receipt_and_version_metadata() -> None:
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        _routing_receipt_chunk("local"),
        b"data: [DONE]\n\n",
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                "content-type": "text/event-stream",
                "x-cognitum-product-version": "0.4.0",
                "x-cognitum-protocol-version": "1.0",
            },
            stream=_ByteStream(chunks),
        )

    client, call_count = _make_client(handler)

    values, error = await _collect(client.chat.completions_stream(_chat_request()))
    assert error is None
    assert call_count[0] == 1

    accumulator = ChatCompletionsStreamAccumulator()
    for envelope in values:
        accumulator.absorb(envelope.inner)
    snapshot = accumulator.snapshot()
    assert snapshot.role == "assistant"
    assert snapshot.content_by_choice[0] == "Hello"
    assert snapshot.finish_reason_by_choice[0] == "stop"
    assert snapshot.completed is True

    last = values[-1]
    assert last.proxy_meta.product_version == "0.4.0"
    assert last.proxy_meta.protocol_version == "1.0"
    assert last.proxy_meta.routing_receipt is not None
    assert last.proxy_meta.routing_receipt.selected_plane == "local"
    assert last.proxy_meta.upstream_receipt == {"provider": "cognitum", "cost": "0.001"}


@pytest.mark.asyncio
async def test_request_body_sets_stream_true() -> None:
    seen_body = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen_body.update(json.loads(request.content))
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_ByteStream([_routing_receipt_chunk("local"), b"data: [DONE]\n\n"]),
        )

    client, _call_count = _make_client(handler)
    await _collect(client.chat.completions_stream(_chat_request()))
    assert seen_body.get("stream") is True


@pytest.mark.asyncio
async def test_required_plane_mismatch_on_streaming_terminal_receipt() -> None:
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        _routing_receipt_chunk("cognitum_cloud"),
        b"data: [DONE]\n\n",
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_ByteStream(chunks)
        )

    client, _call_count = _make_client(handler)

    intent = RoutingIntent(required_plane="local")
    options = MetaProxyChatCallOptions(routing_intent=intent)
    _values, error = await _collect(client.chat.completions_stream(_chat_request(), options))

    assert isinstance(error, AgenticError)
    assert error.kind == "protocol"
    assert error.retryable is False


@pytest.mark.asyncio
async def test_required_plane_match_succeeds_on_streaming_terminal_receipt() -> None:
    chunks = [_routing_receipt_chunk("local"), b"data: [DONE]\n\n"]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_ByteStream(chunks)
        )

    client, _call_count = _make_client(handler)

    intent = RoutingIntent(required_plane="local")
    options = MetaProxyChatCallOptions(routing_intent=intent)
    _values, error = await _collect(client.chat.completions_stream(_chat_request(), options))
    assert error is None


@pytest.mark.asyncio
async def test_required_plane_with_no_receipt_ever_observed_is_a_protocol_violation() -> None:
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}\n\n',
        b"data: [DONE]\n\n",
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_ByteStream(chunks)
        )

    client, _call_count = _make_client(handler)

    intent = RoutingIntent(required_plane="local")
    options = MetaProxyChatCallOptions(routing_intent=intent)
    _values, error = await _collect(client.chat.completions_stream(_chat_request(), options))
    assert isinstance(error, AgenticError)
    assert error.kind == "protocol"


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
            stream=_ByteStream(chunks, fail_after_all_chunks=True),
        )

    client, call_count = _make_client(handler)
    _values, error = await _collect(client.chat.completions_stream(_chat_request()))

    assert call_count[0] == 1
    assert isinstance(error, AgenticError)
    assert error.kind == "transport"
    assert error.code == "stream_disconnected"
    assert error.retryable is False


@pytest.mark.asyncio
async def test_pre_byte_5xx_and_429_are_single_terminal_errors_never_auto_retried() -> None:
    for status in (503, 429, 502):

        async def handler(request: httpx.Request, status=status) -> httpx.Response:
            return httpx.Response(
                status, headers={"retry-after": "7"}, json={"error": "unavailable"}
            )

        client, call_count = _make_client(handler)
        _values, error = await _collect(client.chat.completions_stream(_chat_request()))
        assert call_count[0] == 1
        assert isinstance(error, AgenticError)
        assert error.status == status
        assert error.retryable is True
        assert error.retry_after_ms == 7000


@pytest.mark.asyncio
async def test_idle_stream_timeout_races_the_blocking_read() -> None:
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":'
        b'{"content":"before the hang"},"finish_reason":null}]}\n\n',
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_HangingByteStream(chunks)
        )

    client, _call_count = _make_client(handler)

    values, error = await asyncio.wait_for(
        _collect(
            client.chat.completions_stream(
                _chat_request(), time_budget=ProxyTimeBudget(idle_stream_timeout_ms=30)
            )
        ),
        timeout=5,
    )

    accumulator = ChatCompletionsStreamAccumulator()
    for envelope in values:
        accumulator.absorb(envelope.inner)
    assert accumulator.snapshot().content_by_choice[0] == "before the hang"

    assert isinstance(error, AgenticError)
    assert error.kind == "deadline_exceeded"
    assert error.code == "idle_stream_timeout"
    assert error.retryable is False
    assert error.details is not None
    assert error.details["partial"] is True


@pytest.mark.asyncio
async def test_first_byte_timeout_races_the_blocking_read() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_HangingByteStream([])
        )

    client, _call_count = _make_client(handler)

    values, error = await asyncio.wait_for(
        _collect(
            client.chat.completions_stream(
                _chat_request(), time_budget=ProxyTimeBudget(first_byte_timeout_ms=30)
            )
        ),
        timeout=5,
    )
    assert values == []
    assert isinstance(error, AgenticError)
    assert error.kind == "deadline_exceeded"
    assert error.code == "first_byte_timeout"
    assert error.retryable is False


@pytest.mark.asyncio
async def test_sponsored_stream_fails_locally_before_any_http_io() -> None:
    call_count = [0]

    async def handler(request: httpx.Request) -> httpx.Response:
        call_count[0] += 1
        return httpx.Response(200, json={})

    transport = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    config = MetaProxyClientConfig(
        origin=ORIGIN, local_credential_provider=_bearer_provider(), transport=transport
    )
    client = MetaProxyClient(config)

    request = ChatCompletionRequest(
        model="gpt-proxy", messages=[ChatMessage(role="user", content="hi")], stream=True
    )
    with pytest.raises(UnsupportedCapabilityError) as exc_info:
        await client.preview.sponsored.chat.completions(request)
    assert exc_info.value.kind == "unsupported_capability"
    assert exc_info.value.capability == "sponsored-inference-streaming"
    assert call_count[0] == 0


@pytest.mark.asyncio
async def test_sponsored_nonstream_also_fails_locally() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    transport = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    config = MetaProxyClientConfig(
        origin=ORIGIN, local_credential_provider=_bearer_provider(), transport=transport
    )
    client = MetaProxyClient(config)

    with pytest.raises(UnsupportedCapabilityError) as exc_info:
        await client.preview.sponsored.chat.completions(_chat_request())
    assert exc_info.value.kind == "unsupported_capability"
    assert exc_info.value.capability == "sponsored-inference"
