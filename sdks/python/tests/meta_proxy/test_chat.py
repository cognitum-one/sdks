"""Tests for MetaProxyClient.chat.completions forwarding (ADR-0025a §D5-§D7,
issue #61 / M3 D5-D7)."""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import AgenticError
from cognitum.meta_llm.types import ChatCompletionRequest, ChatMessage
from cognitum.meta_proxy import (
    LocalBearerTokenCredentialProvider,
    MetaProxyChatCallOptions,
    MetaProxyClient,
    MetaProxyClientConfig,
    RoutingIntent,
)

ORIGIN = "http://127.0.0.1:11435"
LOCAL_TOKEN = "mh1.local-canary"


def _provider(origin: str = ORIGIN) -> LocalBearerTokenCredentialProvider:
    return LocalBearerTokenCredentialProvider(
        normalized_origin=origin, audience=origin, token=LOCAL_TOKEN
    )


def _request() -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model="gpt-4",
        messages=[ChatMessage(role="user", content="hi")],
    )


def _chat_body(*, selected_plane: str = "local", with_receipt: bool = True) -> dict:
    body: dict = {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "gpt-4",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "hello"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    if with_receipt:
        body["cognitum_routing_receipt"] = {
            "request_id": "rr_1",
            "configured_plane": "local",
            "selected_plane": selected_plane,
            "automatic": False,
            "degraded": False,
            "routing_reason": "configured_default",
        }
        body["cognitum_upstream_receipt"] = {"upstream_request_id": "up_1"}
    return body


# ---------------------------------------------------------------------------
# Happy path + receipt decode
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_returns_parsed_data_and_decodes_receipts() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body(selected_plane="local"))
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    result = await client.chat.completions(_request())

    assert result.data.id == "chatcmpl-1"
    assert result.data.choices[0].message.content == "hello"
    assert result.meta.http_status == 200
    assert result.meta.routing_receipt is not None
    assert result.meta.routing_receipt.selected_plane == "local"
    assert result.meta.upstream_receipt == {"upstream_request_id": "up_1"}
    request = respx.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {LOCAL_TOKEN}"
    assert request.headers["Idempotency-Key"]  # generated when caller omits it
    await client.aclose()


# ---------------------------------------------------------------------------
# §D7 header forwarding allowlist
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_forbidden_headers_never_reach_the_wire() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body())
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    await client.chat.completions(
        _request(),
        MetaProxyChatCallOptions(
            forward_headers={
                # Forbidden: an Authorization override must NOT reach the wire.
                "Authorization": "Bearer HACKER-OVERRIDE",
                "Host": "evil.example.com",
                "X-Cognitum-Sub-Tenant": "tenant-a",  # allowlisted
                "traceparent": "00-trace-01",  # allowlisted
            },
        ),
    )

    request = respx.calls.last.request
    # The bearer is the validated local one, not the caller's override.
    assert request.headers["Authorization"] == f"Bearer {LOCAL_TOKEN}"
    assert "HACKER-OVERRIDE" not in request.headers["Authorization"]
    # httpx sets Host to the real target origin, never the caller's value.
    assert request.headers["host"] == "127.0.0.1:11435"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_allowlisted_headers_are_forwarded() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body())
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    await client.chat.completions(
        _request(),
        MetaProxyChatCallOptions(
            forward_headers={
                "X-Request-ID": "rid-123",
                "traceparent": "00-trace-01",
                "X-Cognitum-Safety": "strict",
                "anthropic-version": "2023-06-01",
            },
        ),
    )

    request = respx.calls.last.request
    assert request.headers["X-Request-ID"] == "rid-123"
    assert request.headers["traceparent"] == "00-trace-01"
    assert request.headers["X-Cognitum-Safety"] == "strict"
    assert request.headers["anthropic-version"] == "2023-06-01"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_caller_supplied_idempotency_key_is_reused() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body())
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    await client.chat.completions(
        _request(),
        MetaProxyChatCallOptions(forward_headers={"Idempotency-Key": "idem-abc"}),
    )

    assert respx.calls.last.request.headers["Idempotency-Key"] == "idem-abc"
    await client.aclose()


# ---------------------------------------------------------------------------
# §D5 rule 7: required_plane mismatch is a protocol error even on a 200
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_required_plane_mismatch_raises_even_on_a_valid_200() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body(selected_plane="cognitum_cloud"))
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(
            _request(),
            MetaProxyChatCallOptions(routing_intent=RoutingIntent(required_plane="local")),
        )
    err = exc_info.value
    assert err.kind == "protocol"
    assert err.retryable is False
    assert "cognitum_cloud" in err.message
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_required_plane_without_a_receipt_fails_closed() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body(with_receipt=False))
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(
            _request(),
            MetaProxyChatCallOptions(routing_intent=RoutingIntent(required_plane="local")),
        )
    assert exc_info.value.kind == "protocol"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_required_plane_match_succeeds() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body(selected_plane="local"))
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    result = await client.chat.completions(
        _request(),
        MetaProxyChatCallOptions(routing_intent=RoutingIntent(required_plane="local")),
    )
    assert result.data.id == "chatcmpl-1"
    await client.aclose()


# ---------------------------------------------------------------------------
# Auth fail-closed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_fails_closed_without_a_credential_provider_before_any_http() -> None:
    with respx.mock:
        route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body())
        )
        client = MetaProxyClient(MetaProxyClientConfig())
        with pytest.raises(AgenticError) as exc_info:
            await client.chat.completions(_request())
        assert exc_info.value.kind == "authentication"
        assert not route.called  # fails before any network I/O
        await client.aclose()


# ---------------------------------------------------------------------------
# §D10 transport hardening: no ambient proxy, no redirects
# ---------------------------------------------------------------------------


def test_default_transport_ignores_env_proxies_and_rejects_redirects() -> None:
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))
    # trust_env=False => ambient HTTP_PROXY/HTTPS_PROXY are ignored (§D6).
    assert client._transport.trust_env is False
    # follow_redirects=False, pinned explicitly (§D10).
    assert client._transport.follow_redirects is False


@pytest.mark.asyncio
@respx.mock
async def test_call_goes_straight_to_loopback_despite_ambient_proxy_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://canary-proxy.invalid:3128")
    monkeypatch.setenv("http_proxy", "http://canary-proxy.invalid:3128")
    route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_body())
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    await client.chat.completions(_request())

    assert route.called
    assert respx.calls.last.request.url.host == "127.0.0.1"
    assert client._transport.trust_env is False
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_redirect_is_rejected_not_followed() -> None:
    respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(
            302, headers={"location": "http://evil.example.com/v1/chat/completions"}
        )
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(_request())
    err = exc_info.value
    assert err.kind == "protocol"
    assert err.retryable is False
    assert err.status == 302
    await client.aclose()


# ---------------------------------------------------------------------------
# Bearer-attachment loopback guard (§D6/§D10)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bearer_is_attached_for_an_opted_in_non_loopback_origin() -> None:
    import warnings

    remote = "http://10.0.0.5:11435"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        config = MetaProxyClientConfig(
            origin=remote,
            allow_non_loopback=True,
            local_credential_provider=_provider(origin=remote),
        )
    with respx.mock:
        respx.post(f"{remote}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body())
        )
        client = MetaProxyClient(config)
        await client.chat.completions(_request())
        assert respx.calls.last.request.headers["Authorization"] == f"Bearer {LOCAL_TOKEN}"
        await client.aclose()


def test_construction_blocks_non_loopback_bearer_target_without_opt_in() -> None:
    # The only way to reach a non-loopback origin is the explicit opt-in;
    # without it, construction refuses, so a bearer can never be attached to
    # a non-loopback origin unless allow_non_loopback was set.
    with pytest.raises(ValueError):
        MetaProxyClientConfig(origin="http://10.0.0.5:11435")


# ---------------------------------------------------------------------------
# §D8 — no automatic POST retry on 429/502/503 (duplicate-spend risk)
# ---------------------------------------------------------------------------
#
# ADR-0025a §D8: "No Proxy POST is automatically retried while it drops
# `Idempotency-Key`". That sentence is about the *Proxy server* dropping the
# header for dedup (confirmed by the currently-deployed Proxy) -- the SDK
# attaching one client-side does not make a retry safe. The
# Alternatives-considered table rejects "Retry Proxy POSTs" outright
# ("Idempotency is dropped and spend can duplicate"). A 429/502/503 must
# therefore result in exactly ONE HTTP attempt and a single terminal error,
# preserving whatever `retry_after` hint the response carried so the CALLER
# can retry manually.


@pytest.mark.asyncio
@respx.mock
async def test_a_503_is_a_single_attempt_terminal_error_with_retry_after_preserved() -> None:
    route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(
            503, json={"error": "warming up"}, headers={"retry-after": "7"}
        )
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(_request())
    err = exc_info.value
    assert err.status == 503
    # `retryable=True` is the generic HTTP-error classification (a caller MAY
    # retry a 503) -- it does not mean the SDK retried automatically, which
    # is exactly the bug this guards against.
    assert err.retryable is True
    assert err.retry_after_ms == 7000
    assert route.call_count == 1, "the SDK must make exactly ONE HTTP attempt (§D8)"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_a_429_is_a_single_attempt_terminal_error_with_retry_after_preserved() -> None:
    route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(
            429, json={"error": "rate limited"}, headers={"retry-after": "2"}
        )
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(_request())
    err = exc_info.value
    assert err.status == 429
    assert err.retryable is True
    assert err.retry_after_ms == 2000
    assert route.call_count == 1, "no automatic retry on 429 (§D8)"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_a_502_is_a_single_attempt_terminal_error() -> None:
    route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
        return_value=httpx.Response(502, json={"error": "bad gateway"})
    )
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(_request())
    err = exc_info.value
    assert err.status == 502
    assert err.retryable is True
    assert route.call_count == 1, "no automatic retry on 502 (§D8)"
    await client.aclose()
