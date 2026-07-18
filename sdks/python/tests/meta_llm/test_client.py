"""Tests for MetaLlmClient construction and the real health/whoami/models
implementations (issue #58 / M2)."""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import AgenticError, CapabilitySet, StaticApiKeyCredentialProvider
from cognitum.agentic.credentials import Credential, CredentialAuthority, RedactedSecret
from cognitum.meta_llm import MetaLlmClient, MetaLlmClientConfig

BASE_URL = "https://meta-llm.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="sk-test-canary-1234",
        product="meta-llm",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


class _SpyCredentialProvider:
    """Spy ``CredentialProvider`` so tests can assert ``acquire()`` call
    counts (FIX 3 regression test: ADR-0024a §D1 says ``health()`` is
    process-level response only)."""

    def __init__(self) -> None:
        self.acquire_calls = 0

    async def describe_authority(self, request: object) -> CredentialAuthority:
        return CredentialAuthority(
            provider_fingerprint="spy",
            product="meta-llm",
            normalized_origin=BASE_URL,
            audience=BASE_URL,
        )

    async def acquire(self, request: object) -> Credential:
        self.acquire_calls += 1
        return Credential(
            scheme="X-API-Key",
            secret=RedactedSecret("sk-spy-canary"),
            audience=BASE_URL,
            source="spy",
            authority=CredentialAuthority(
                provider_fingerprint="spy",
                product="meta-llm",
                normalized_origin=BASE_URL,
                audience=BASE_URL,
            ),
        )

    def identity(self) -> str:
        return "spy-credential-provider"

    async def invalidate(self, reason: str) -> None:
        del reason


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


def test_allow_insecure_http_rejects_non_loopback_host() -> None:
    # ADR-0022 §D3: disabling TLS is allowed only for loopback development.
    with pytest.raises(ValueError):
        MetaLlmClientConfig(base_url="http://example.com:9999", allow_insecure_http=True)


def test_allow_insecure_http_rejects_hostname_resolving_to_loopback() -> None:
    # ADR-0022 §D3: hostname resolution to loopback (e.g. "localhost") is
    # insufficient -- only a literal IPv4/IPv6 loopback address qualifies.
    with pytest.raises(ValueError):
        MetaLlmClientConfig(base_url="http://localhost:9999", allow_insecure_http=True)


def test_allow_insecure_http_accepts_literal_ipv6_loopback() -> None:
    config = MetaLlmClientConfig(base_url="http://[::1]:9999", allow_insecure_http=True)
    client = MetaLlmClient(config)
    assert isinstance(client, MetaLlmClient)


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
async def test_health_never_acquires_a_credential_even_when_a_provider_is_configured() -> None:
    # FIX 3 regression test: before the fix, ``_get_json`` called
    # ``_resolve_credential`` (and thus ``provider.acquire()``)
    # unconditionally regardless of ``require_credential``, only discarding
    # the result for health(). A spy provider proves acquire() is now
    # skipped entirely rather than acquired-and-discarded.
    respx.get(f"{BASE_URL}/v1/health").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    spy = _SpyCredentialProvider()
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL, credential_provider=spy))

    result = await client.health()

    assert result.data.status == "ok"
    assert spy.acquire_calls == 0, "health() must not acquire a credential when one is configured"
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
async def test_whoami_rejects_credential_provider_bound_to_a_different_origin() -> None:
    # FIX 4 regression test: a CredentialProvider constructed for a
    # DIFFERENT origin than the client's own base_url must be refused
    # (ADR-0022 §D3: "Credential providers are bound to the normalized
    # origin selected during client construction"). Asserts the request
    # never reached the wire either, proving no credential leaked to the
    # wrong origin.
    with respx.mock:
        mismatched_provider = StaticApiKeyCredentialProvider(
            api_key="sk-wrong-origin-canary",
            product="meta-llm",
            normalized_origin="https://a-completely-different-origin.example.com",
            audience="https://a-completely-different-origin.example.com",
        )
        client = MetaLlmClient(
            MetaLlmClientConfig(base_url=BASE_URL, credential_provider=mismatched_provider)
        )
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


# `chat.completions` and `messages.create` now have real HTTP call logic
# (issue #58 / M2 continuation) -- see `test_nonstream.py`. The other
# three protocol operations remain follow-up-issue placeholders.


@pytest.mark.asyncio
async def test_completions_not_implemented() -> None:
    from cognitum.meta_llm import LegacyCompletionRequest

    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError):
        await client.completions(LegacyCompletionRequest(model="m", prompt="hi"))


@pytest.mark.asyncio
async def test_messages_count_tokens_not_implemented() -> None:
    from cognitum.meta_llm import CountTokensRequest

    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL))
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
