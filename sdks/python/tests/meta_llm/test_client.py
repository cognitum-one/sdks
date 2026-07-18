"""Tests for MetaLlmClient construction and the real health/whoami/models
implementations (issue #58 / M2)."""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import AgenticError, CapabilitySet, StaticApiKeyCredentialProvider
from cognitum.meta_llm import MetaLlmClient, MetaLlmClientConfig

BASE_URL = "https://meta-llm.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="sk-test-canary-1234",
        product="meta-llm",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_construction_performs_no_io() -> None:
    with respx.mock:
        client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
        assert isinstance(client, MetaLlmClient)
        # respx.mock with no routes registered will raise on any request, so
        # constructing the client without triggering a request proves no I/O.


def test_rejects_non_https_base_url_by_default() -> None:
    with pytest.raises(ValueError):
        MetaLlmClientConfig(base_url="http://127.0.0.1:9999")


def test_allows_non_https_base_url_when_opted_in() -> None:
    config = MetaLlmClientConfig(base_url="http://127.0.0.1:9999", allow_insecure_http=True)
    client = MetaLlmClient(config)
    assert isinstance(client, MetaLlmClient)


def test_rejects_missing_base_url() -> None:
    with pytest.raises(ValueError):
        MetaLlmClientConfig(base_url="")


# ---------------------------------------------------------------------------
# health()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_health_returns_data_without_credential_provider() -> None:
    respx.get(f"{BASE_URL}/v1/health").mock(
        return_value=httpx.Response(200, json={"status": "ok", "version": "0.0.1"})
    )
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))

    result = await client.health()

    assert result.data.status == "ok"
    assert result.data.version == "0.0.1"
    assert result.meta.http_status == 200
    request = respx.calls.last.request
    assert "X-API-Key" not in request.headers
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_health_maps_503_to_retryable_transport_error() -> None:
    respx.get(f"{BASE_URL}/v1/health").mock(
        return_value=httpx.Response(503, json={"error": "upstream unavailable"})
    )
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))

    with pytest.raises(AgenticError) as exc_info:
        await client.health()

    assert exc_info.value.kind == "transport"
    assert exc_info.value.retryable is True
    assert exc_info.value.status == 503
    await client.aclose()


# ---------------------------------------------------------------------------
# whoami()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_whoami_sends_credential_as_x_api_key() -> None:
    respx.get(f"{BASE_URL}/v1/whoami").mock(
        return_value=httpx.Response(
            200, json={"account_id": "acct_1", "credential_type": "api_key"}
        )
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.whoami()

    assert result.data.account_id == "acct_1"
    request = respx.calls.last.request
    assert request.headers["X-API-Key"] == "sk-test-canary-1234"
    await client.aclose()


@pytest.mark.asyncio
async def test_whoami_fails_closed_without_credential_provider() -> None:
    with respx.mock:
        client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
        with pytest.raises(AgenticError) as exc_info:
            await client.whoami()
        assert exc_info.value.kind == "authentication"
        assert len(respx.calls) == 0
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_whoami_maps_401_to_non_retryable_authentication_error() -> None:
    respx.get(f"{BASE_URL}/v1/whoami").mock(
        return_value=httpx.Response(401, json={"error": "invalid key"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.whoami()

    assert exc_info.value.kind == "authentication"
    assert exc_info.value.retryable is False
    assert exc_info.value.status == 401
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_whoami_maps_429_to_retryable_rate_limited_with_retry_after() -> None:
    respx.get(f"{BASE_URL}/v1/whoami").mock(
        return_value=httpx.Response(429, json={"error": "slow down"}, headers={"retry-after": "2"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.whoami()

    assert exc_info.value.kind == "rate_limited"
    assert exc_info.value.retryable is True
    assert exc_info.value.retry_after_ms == 2000
    await client.aclose()


# ---------------------------------------------------------------------------
# models()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_models_returns_model_list() -> None:
    respx.get(f"{BASE_URL}/v1/models").mock(
        return_value=httpx.Response(200, json={"models": [{"id": "meta-llm-large"}]})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.models()

    assert len(result.data.models) == 1
    assert result.data.models[0].id == "meta-llm-large"
    await client.aclose()


# ---------------------------------------------------------------------------
# capabilities()
# ---------------------------------------------------------------------------


def test_capabilities_returns_configured_snapshot_without_io() -> None:
    with respx.mock:
        snapshot = CapabilitySet(
            product="meta-llm",
            product_version="0.0.1",
            protocol="cognitum.meta-llm.http",
            protocol_version="1.0",
            source="static-compatibility-table",
            features={"chat": True},
            auth_methods=["api_key"],
        )
        client = MetaLlmClient(
            MetaLlmClientConfig(base_url=BASE_URL, capabilities_snapshot=snapshot)
        )
        assert client.capabilities() == snapshot
        assert len(respx.calls) == 0


def test_capabilities_falls_back_to_intersection_safe_default() -> None:
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    caps = client.capabilities()
    assert caps.features == {}
    assert caps.source == "static-compatibility-table"


# ---------------------------------------------------------------------------
# ready()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ready_fails_closed() -> None:
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError) as exc_info:
        await client.ready("chat")
    assert exc_info.value.kind == "unsupported_capability"


# ---------------------------------------------------------------------------
# Protocol placeholders
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_chat_completions_not_implemented() -> None:
    from cognitum.meta_llm import ChatCompletionRequest

    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(ChatCompletionRequest(model="m", messages=[]))
    assert exc_info.value.kind == "unsupported_capability"


@pytest.mark.asyncio
async def test_completions_not_implemented() -> None:
    from cognitum.meta_llm import LegacyCompletionRequest

    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError):
        await client.completions(LegacyCompletionRequest(model="m", prompt="hi"))


@pytest.mark.asyncio
async def test_messages_create_and_count_tokens_not_implemented() -> None:
    from cognitum.meta_llm import AnthropicMessageRequest, CountTokensRequest

    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError):
        await client.messages.create(
            AnthropicMessageRequest(model="m", messages=[], max_tokens=16)
        )
    with pytest.raises(AgenticError):
        await client.messages.count_tokens(CountTokensRequest(model="m", messages=[]))


@pytest.mark.asyncio
async def test_responses_not_implemented() -> None:
    from cognitum.meta_llm import ResponsesRequest

    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError):
        await client.responses(ResponsesRequest(model="m", input="hi"))


@pytest.mark.asyncio
async def test_embeddings_not_implemented() -> None:
    from cognitum.meta_llm import EmbeddingRequest

    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError):
        await client.embeddings(EmbeddingRequest(model="m", input="hi"))
