"""Tests for MetaProxyClient construction and the real status()/
capabilities() implementations (issue #61 / M3 start)."""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import CapabilitySet, StaticApiKeyCredentialProvider
from cognitum.agentic.credentials import Credential, CredentialAuthority, RedactedSecret
from cognitum.meta_proxy import MetaProxyClient, MetaProxyClientConfig

ORIGIN = "http://127.0.0.1:11435"

FULL_STATUS_BODY = {
    "product_version": "0.4.0",
    "protocol_version": "1.0",
    "compatible_sdk_range": ">=0.1.0 <1.0.0",
    "process_state": "running",
    "bind": "127.0.0.1:11435",
    "configured_plane": "local",
    "selected_plane": "local",
    "routing_reason": "configured_default",
    "automatic_usage_state": "disabled",
    "workload_policy": "standard",
    "sponsored_available": False,
    "cloud_credential_source": "none",
    "limitations": ["no capabilities endpoint published yet"],
    "request_id": "req_status_1",
}


def _local_bearer_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="mh1.canary-local-token",
        product="meta-proxy",
        normalized_origin=ORIGIN,
        audience=ORIGIN,
        scheme="bearer",
    )


class _SpyCredentialProvider:
    """Spy ``CredentialProvider`` so tests can assert ``acquire()`` call counts."""

    def __init__(self) -> None:
        self.acquire_calls = 0

    async def describe_authority(self, request: object) -> CredentialAuthority:
        return CredentialAuthority(
            provider_fingerprint="spy",
            product="meta-proxy",
            normalized_origin=ORIGIN,
            audience=ORIGIN,
        )

    async def acquire(self, request: object) -> Credential:
        self.acquire_calls += 1
        return Credential(
            scheme="bearer",
            secret=RedactedSecret("mh1.spy-canary"),
            audience=ORIGIN,
            source="spy",
            authority=CredentialAuthority(
                provider_fingerprint="spy",
                product="meta-proxy",
                normalized_origin=ORIGIN,
                audience=ORIGIN,
            ),
        )

    def identity(self) -> str:
        return "spy-credential-provider"

    async def invalidate(self, reason: str) -> None:
        del reason


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_construction_performs_no_io_and_defaults_to_loopback_origin() -> None:
    with respx.mock:
        client = MetaProxyClient(MetaProxyClientConfig())
        assert isinstance(client, MetaProxyClient)
        assert client.config.origin == ORIGIN


def test_accepts_an_explicit_loopback_origin() -> None:
    config = MetaProxyClientConfig(origin="http://127.0.0.1:19999")
    client = MetaProxyClient(config)
    assert client.config.origin == "http://127.0.0.1:19999"


def test_accepts_a_literal_ipv6_loopback_origin() -> None:
    config = MetaProxyClientConfig(origin="http://[::1]:11435")
    client = MetaProxyClient(config)
    assert isinstance(client, MetaProxyClient)


def test_rejects_non_loopback_origin_by_default() -> None:
    with pytest.raises(ValueError):
        MetaProxyClientConfig(origin="http://example.com:11435")


def test_rejects_hostname_resolving_to_loopback() -> None:
    with pytest.raises(ValueError):
        MetaProxyClientConfig(origin="http://localhost:11435")


def test_allows_non_loopback_origin_when_opted_in() -> None:
    config = MetaProxyClientConfig(origin="http://example.com:11435", allow_non_loopback=True)
    client = MetaProxyClient(config)
    assert isinstance(client, MetaProxyClient)


def test_rejects_non_http_origin() -> None:
    with pytest.raises(ValueError):
        MetaProxyClientConfig(origin="ftp://127.0.0.1:11435")


# ---------------------------------------------------------------------------
# status()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_status_returns_parsed_data_on_success() -> None:
    respx.get(f"{ORIGIN}/status").mock(
        return_value=httpx.Response(
            200,
            json=FULL_STATUS_BODY,
            headers={"x-cognitum-request-id": "req_status_1", "x-cognitum-protocol-version": "1.0"},
        )
    )
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )

    result = await client.status()

    assert result.data.product_version == "0.4.0"
    assert result.data.process_state == "running"
    assert result.data.configured_plane == "local"
    assert result.data.selected_plane == "local"
    assert result.data.workload_policy == "standard"
    assert result.data.sponsored_available is False
    assert result.meta.http_status == 200
    request = respx.calls.last.request
    assert request.headers["Authorization"] == "Bearer mh1.canary-local-token"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_status_preserves_unrecognized_fields_verbatim_under_raw() -> None:
    body = {**FULL_STATUS_BODY, "a_brand_new_field_the_sdk_does_not_know_about": "surprise"}
    respx.get(f"{ORIGIN}/status").mock(return_value=httpx.Response(200, json=body))
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )

    result = await client.status()

    assert result.data.raw == {"a_brand_new_field_the_sdk_does_not_know_about": "surprise"}
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_status_captures_a_genuinely_unknown_header_but_excludes_known_ones() -> None:
    respx.get(f"{ORIGIN}/status").mock(
        return_value=httpx.Response(
            200,
            json=FULL_STATUS_BODY,
            headers={
                "x-a-brand-new-header-the-sdk-does-not-know-about": "surprise",
                "content-type": "application/json",
            },
        )
    )
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )

    result = await client.status()

    assert result.meta.unknown_headers is not None
    assert (
        result.meta.unknown_headers["x-a-brand-new-header-the-sdk-does-not-know-about"]
        == "surprise"
    )
    assert "content-type" not in result.meta.unknown_headers
    await client.aclose()


@pytest.mark.asyncio
async def test_status_fails_closed_without_a_local_credential_provider() -> None:
    with respx.mock:
        client = MetaProxyClient(MetaProxyClientConfig())
        with pytest.raises(Exception) as exc_info:
            await client.status()
        assert getattr(exc_info.value, "kind", None) == "authentication"
        await client.aclose()


@pytest.mark.asyncio
async def test_status_never_sends_credentials_for_a_mismatched_origin_provider() -> None:
    mismatched = StaticApiKeyCredentialProvider(
        api_key="mh1.wrong-origin-canary",
        product="meta-proxy",
        normalized_origin="http://127.0.0.1:9",
        audience="http://127.0.0.1:9",
        scheme="bearer",
    )
    with respx.mock:
        client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=mismatched))
        with pytest.raises(Exception) as exc_info:
            await client.status()
        assert getattr(exc_info.value, "kind", None) == "authentication"
        await client.aclose()


@pytest.mark.asyncio
async def test_status_maps_a_connection_failure_to_a_retryable_transport_error() -> None:
    with respx.mock:
        respx.get(f"{ORIGIN}/status").mock(side_effect=httpx.ConnectError("refused"))
        client = MetaProxyClient(
            MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
        )
        with pytest.raises(Exception) as exc_info:
            await client.status()
        assert getattr(exc_info.value, "kind", None) == "transport"
        assert getattr(exc_info.value, "retryable", None) is True
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_status_maps_a_401_to_a_non_retryable_authentication_error() -> None:
    respx.get(f"{ORIGIN}/status").mock(
        return_value=httpx.Response(401, json={"error": "invalid local token"})
    )
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )
    with pytest.raises(Exception) as exc_info:
        await client.status()
    assert getattr(exc_info.value, "kind", None) == "authentication"
    assert getattr(exc_info.value, "retryable", None) is False
    assert getattr(exc_info.value, "status", None) == 401
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_status_maps_a_429_to_a_retryable_rate_limited_error() -> None:
    respx.get(f"{ORIGIN}/status").mock(
        return_value=httpx.Response(
            429, json={"error": "slow down"}, headers={"retry-after": "3"}
        )
    )
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )
    with pytest.raises(Exception) as exc_info:
        await client.status()
    assert getattr(exc_info.value, "kind", None) == "rate_limited"
    assert getattr(exc_info.value, "retryable", None) is True
    assert getattr(exc_info.value, "retry_after_ms", None) == 3000
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_status_maps_a_503_to_a_retryable_transport_error() -> None:
    respx.get(f"{ORIGIN}/status").mock(
        return_value=httpx.Response(503, json={"error": "local backend unavailable"})
    )
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )
    with pytest.raises(Exception) as exc_info:
        await client.status()
    assert getattr(exc_info.value, "kind", None) == "transport"
    assert getattr(exc_info.value, "retryable", None) is True
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_status_acquires_a_credential_exactly_once_per_call() -> None:
    respx.get(f"{ORIGIN}/status").mock(return_value=httpx.Response(200, json=FULL_STATUS_BODY))
    provider = _SpyCredentialProvider()
    client = MetaProxyClient(MetaProxyClientConfig(local_credential_provider=provider))

    await client.status()

    assert provider.acquire_calls == 1
    request = respx.calls.last.request
    assert request.headers["X-Cognitum-Request-Id"]
    await client.aclose()


# ---------------------------------------------------------------------------
# capabilities()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_capabilities_derives_a_capability_set_shaped_result() -> None:
    respx.get(f"{ORIGIN}/status").mock(return_value=httpx.Response(200, json=FULL_STATUS_BODY))
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )

    result = await client.capabilities()

    assert result.data.product == "meta-proxy"
    assert result.data.product_version == "0.4.0"
    assert result.data.protocol == "cognitum.meta-proxy.http"
    assert result.data.source == "server"
    assert result.data.configured_plane == "local"
    assert result.data.selected_plane == "local"
    assert "no capabilities endpoint published yet" in result.data.limitations
    assert len(respx.calls) == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_capabilities_merges_the_configured_snapshot() -> None:
    respx.get(f"{ORIGIN}/status").mock(return_value=httpx.Response(200, json=FULL_STATUS_BODY))
    snapshot = CapabilitySet(
        product="meta-proxy",
        product_version="0.0.0",
        protocol="cognitum.meta-proxy.http",
        protocol_version="1.0",
        source="static-compatibility-table",
        features={"status": True},
        limitations=["pinned-table limitation"],
        auth_methods=["local_bearer"],
    )
    client = MetaProxyClient(
        MetaProxyClientConfig(
            local_credential_provider=_local_bearer_provider(), capabilities_snapshot=snapshot
        )
    )

    result = await client.capabilities()

    assert result.data.features == {"status": True}
    assert result.data.auth_methods == ["local_bearer"]
    assert "pinned-table limitation" in result.data.limitations
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_capabilities_warns_on_expected_proxy_version_mismatch() -> None:
    respx.get(f"{ORIGIN}/status").mock(return_value=httpx.Response(200, json=FULL_STATUS_BODY))
    client = MetaProxyClient(
        MetaProxyClientConfig(
            local_credential_provider=_local_bearer_provider(), expected_proxy_version="9.9.9"
        )
    )

    result = await client.capabilities()

    assert any("9.9.9" in w for w in (result.meta.warnings or []))
    await client.aclose()


@pytest.mark.asyncio
async def test_capabilities_fails_closed_without_a_local_credential_provider() -> None:
    with respx.mock:
        client = MetaProxyClient(MetaProxyClientConfig())
        with pytest.raises(Exception) as exc_info:
            await client.capabilities()
        assert getattr(exc_info.value, "kind", None) == "authentication"
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_capabilities_never_sends_a_prompt_to_discover_support() -> None:
    respx.get(f"{ORIGIN}/status").mock(return_value=httpx.Response(200, json=FULL_STATUS_BODY))
    client = MetaProxyClient(
        MetaProxyClientConfig(local_credential_provider=_local_bearer_provider())
    )

    await client.capabilities()

    for call in respx.calls:
        assert call.request.method == "GET"
        assert not call.request.content
    await client.aclose()
