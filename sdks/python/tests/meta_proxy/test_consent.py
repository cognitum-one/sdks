"""Tests for §D9's tractable consent-gating slice (ADR-0025a §D9, issue #61
/ M3 continuation).

Covers: the pure gate function (:func:`assert_consent_for_routing_intent`),
the non-streaming ``chat.completions()`` integration (must fail BEFORE any
HTTP I/O even though a valid local bearer credential is configured), and the
streaming ``chat.completions_stream()`` integration (must fail on the first
``__anext__()``, before any connection is opened).
"""

from __future__ import annotations

import datetime

import httpx
import pytest
import respx

from cognitum.agentic import ConsentGrant, ConsentRequiredError
from cognitum.meta_llm.types import ChatCompletionRequest, ChatMessage
from cognitum.meta_proxy import (
    CLOUD_ROUTING_CONSENT_KIND,
    LocalBearerTokenCredentialProvider,
    MetaProxyChatCallOptions,
    MetaProxyClient,
    MetaProxyClientConfig,
    RoutingIntent,
    assert_consent_for_routing_intent,
    has_valid_consent_grant,
    intent_touches_plane,
    is_consent_grant_valid,
)

ORIGIN = "http://127.0.0.1:11435"
PRODUCT = "meta-proxy"
LOCAL_TOKEN = "mh1.local-canary"


def _provider() -> LocalBearerTokenCredentialProvider:
    return LocalBearerTokenCredentialProvider(
        normalized_origin=ORIGIN, audience=ORIGIN, token=LOCAL_TOKEN
    )


def _request() -> ChatCompletionRequest:
    return ChatCompletionRequest(model="gpt-4", messages=[ChatMessage(role="user", content="hi")])


def _chat_body(*, selected_plane: str = "cognitum_cloud") -> dict:
    return {
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
        "cognitum_routing_receipt": {
            "request_id": "rr_1",
            "configured_plane": "cognitum_cloud",
            "selected_plane": selected_plane,
            "automatic": False,
            "degraded": False,
            "routing_reason": "explicit",
        },
    }


def _cloud_intent(**overrides: object) -> RoutingIntent:
    kwargs: dict = {"allowed_planes": ["cognitum_cloud"]}
    kwargs.update(overrides)
    return RoutingIntent(**kwargs)


def _grant(**overrides: object) -> ConsentGrant:
    kwargs: dict = {
        "kind": "cloud_fallback",
        "product": PRODUCT,
        "origin": ORIGIN,
        "subject": "test-subject",
        "scope": "chat.completions",
        "issued_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    kwargs.update(overrides)
    return ConsentGrant(**kwargs)


# ---------------------------------------------------------------------------
# Pure unit tests
# ---------------------------------------------------------------------------


def test_no_op_when_intent_is_none() -> None:
    assert_consent_for_routing_intent(None, [], ORIGIN, "chat.completions")


def test_no_op_when_intent_never_touches_cognitum_cloud() -> None:
    intent = RoutingIntent(required_plane="local", allowed_planes=["local"])
    assert_consent_for_routing_intent(intent, [], ORIGIN, "chat.completions")


def test_raises_when_allowed_planes_includes_cognitum_cloud_and_no_grant() -> None:
    with pytest.raises(ConsentRequiredError) as exc_info:
        assert_consent_for_routing_intent(_cloud_intent(), [], ORIGIN, "chat.completions")
    assert exc_info.value.required_kind == CLOUD_ROUTING_CONSENT_KIND
    assert exc_info.value.kind == "consent_required"


def test_raises_when_required_plane_is_cognitum_cloud_and_no_grant() -> None:
    intent = _cloud_intent(required_plane="cognitum_cloud", allowed_planes=[])
    with pytest.raises(ConsentRequiredError):
        assert_consent_for_routing_intent(intent, [], ORIGIN, "chat.completions")


def test_succeeds_with_a_matching_unexpired_grant() -> None:
    assert_consent_for_routing_intent(_cloud_intent(), [_grant()], ORIGIN, "chat.completions")


def test_still_raises_for_a_different_origin_grant() -> None:
    grant = _grant(origin="http://127.0.0.1:9999")
    with pytest.raises(ConsentRequiredError):
        assert_consent_for_routing_intent(_cloud_intent(), [grant], ORIGIN, "chat.completions")


def test_still_raises_for_a_different_kind_grant() -> None:
    grant = _grant(kind="sponsored_inference")
    with pytest.raises(ConsentRequiredError):
        assert_consent_for_routing_intent(_cloud_intent(), [grant], ORIGIN, "chat.completions")


def test_still_raises_for_an_expired_grant() -> None:
    expired = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)
    grant = _grant(expires_at=expired.isoformat())
    with pytest.raises(ConsentRequiredError):
        assert_consent_for_routing_intent(_cloud_intent(), [grant], ORIGIN, "chat.completions")


def test_succeeds_for_a_grant_with_a_future_expiry() -> None:
    future = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=1)
    grant = _grant(expires_at=future.isoformat())
    assert_consent_for_routing_intent(_cloud_intent(), [grant], ORIGIN, "chat.completions")


def test_intent_touches_plane() -> None:
    assert intent_touches_plane(_cloud_intent(), "cognitum_cloud") is True
    assert intent_touches_plane(RoutingIntent(allowed_planes=["local"]), "cognitum_cloud") is False
    assert (
        intent_touches_plane(RoutingIntent(required_plane="cognitum_cloud"), "cognitum_cloud")
        is True
    )


def test_is_consent_grant_valid_rejects_mismatches_and_expiry() -> None:
    now = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    grant = _grant(expires_at="2026-01-02T00:00:00+00:00")
    assert is_consent_grant_valid(grant, "cloud_fallback", PRODUCT, ORIGIN, now) is True
    assert is_consent_grant_valid(grant, "sponsored_inference", PRODUCT, ORIGIN, now) is False
    assert is_consent_grant_valid(grant, "cloud_fallback", "other-product", ORIGIN, now) is False
    other_origin = "http://127.0.0.1:1"
    assert is_consent_grant_valid(grant, "cloud_fallback", PRODUCT, other_origin, now) is False
    later = datetime.datetime(2026, 1, 3, tzinfo=datetime.timezone.utc)
    assert is_consent_grant_valid(grant, "cloud_fallback", PRODUCT, ORIGIN, later) is False


def test_has_valid_consent_grant_finds_a_match_among_several() -> None:
    grants = [
        _grant(kind="sponsored_inference"),
        _grant(origin="http://127.0.0.1:1"),
        _grant(),
    ]
    assert has_valid_consent_grant(grants, "cloud_fallback", PRODUCT, ORIGIN) is True
    assert has_valid_consent_grant(grants[:2], "cloud_fallback", PRODUCT, ORIGIN) is False


# ---------------------------------------------------------------------------
# MetaProxyClient.chat.completions() integration -- fails BEFORE any I/O
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_completions_rejects_with_consent_required_despite_valid_credential() -> None:
    # A perfectly valid local bearer credential IS configured -- the point of
    # this test is that credential presence must NOT be treated as consent
    # (§D9: "Credential presence is not consent").
    with respx.mock:
        route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body())
        )
        client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

        with pytest.raises(ConsentRequiredError) as exc_info:
            await client.chat.completions(
                _request(), MetaProxyChatCallOptions(routing_intent=_cloud_intent())
            )
        assert exc_info.value.required_kind == CLOUD_ROUTING_CONSENT_KIND
        # The whole point of the fail-closed pre-I/O gate: the transport is
        # NEVER invoked.
        assert not route.called
        await client.aclose()


@pytest.mark.asyncio
async def test_chat_completions_rejects_when_required_plane_is_cognitum_cloud() -> None:
    with respx.mock:
        route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body())
        )
        client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))
        intent = _cloud_intent(required_plane="cognitum_cloud", allowed_planes=[])

        with pytest.raises(ConsentRequiredError):
            await client.chat.completions(
                _request(), MetaProxyChatCallOptions(routing_intent=intent)
            )
        assert not route.called
        await client.aclose()


@pytest.mark.asyncio
async def test_chat_completions_succeeds_once_a_matching_grant_is_configured() -> None:
    with respx.mock:
        respx.post(f"{ORIGIN}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body())
        )
        client = MetaProxyClient(
            MetaProxyClientConfig(
                local_credential_provider=_provider(),
                consent_grants=[_grant()],
            )
        )

        result = await client.chat.completions(
            _request(), MetaProxyChatCallOptions(routing_intent=_cloud_intent())
        )
        assert result.data.id == "chatcmpl-1"
        await client.aclose()


@pytest.mark.asyncio
async def test_chat_completions_does_not_require_consent_for_a_local_only_intent() -> None:
    with respx.mock:
        respx.post(f"{ORIGIN}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body(selected_plane="local"))
        )
        client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))
        intent = RoutingIntent(required_plane="local", allowed_planes=["local"])

        result = await client.chat.completions(
            _request(), MetaProxyChatCallOptions(routing_intent=intent)
        )
        assert result.data.id == "chatcmpl-1"
        await client.aclose()


@pytest.mark.asyncio
async def test_chat_completions_does_not_require_consent_when_no_routing_intent() -> None:
    with respx.mock:
        respx.post(f"{ORIGIN}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body(selected_plane="local"))
        )
        client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))
        result = await client.chat.completions(_request())
        assert result.data.id == "chatcmpl-1"
        await client.aclose()


# ---------------------------------------------------------------------------
# MetaProxyClient.chat.completions_stream() integration -- fails on first
# __anext__(), before any connection is opened.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_completions_stream_rejects_on_first_anext_before_any_connection() -> None:
    with respx.mock:
        route = respx.post(f"{ORIGIN}/v1/chat/completions").mock(
            return_value=httpx.Response(200, json=_chat_body())
        )
        client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=_provider()))

        stream = client.chat.completions_stream(
            _request(), MetaProxyChatCallOptions(routing_intent=_cloud_intent())
        )
        with pytest.raises(ConsentRequiredError) as exc_info:
            await stream.__anext__()
        assert exc_info.value.required_kind == CLOUD_ROUTING_CONSENT_KIND
        assert not route.called
        await client.aclose()
