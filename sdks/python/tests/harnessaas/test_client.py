"""Tests for `HarnessaaSClient` construction and the real `health()`/
`solve()`/`lineage()` implementations (issue #67/#68 / M5 start).

Scope note: this pass covers ONLY the real, deployed, synchronous upstream
surface -- no job/poll/SSE/approval/cancel method exists on this client
(ADR-0027a's async "Decision" section is a proposal, not a description of
the running service -- see `cognitum.harnessaas.client`'s module docstring).
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import (
    AgenticError,
    CapabilitySet,
    StaticApiKeyCredentialProvider,
    UnsupportedCapabilityError,
)
from cognitum.agentic.credentials import Credential, CredentialAuthority, RedactedSecret
from cognitum.harnessaas import HarnessaaSClient, HarnessaaSClientConfig, HarnessaaSSolveRequest

BASE_URL = "https://harnessaas.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="cog_test_canary_1234",
        product="harnessaas",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


class _RefreshingCredentialProvider:
    """Credential provider that returns a fresh secret each `acquire()`
    call, so the 401-refresh-once test can distinguish "first credential"
    from "refreshed credential"."""

    def __init__(self) -> None:
        self.acquire_calls = 0
        self.invalidate_calls = 0

    async def describe_authority(self, request: object) -> CredentialAuthority:
        return CredentialAuthority(
            provider_fingerprint="refreshing",
            product="harnessaas",
            normalized_origin=BASE_URL,
            audience=BASE_URL,
        )

    async def acquire(self, request: object) -> Credential:
        secret = "cog_v1" if self.acquire_calls == 0 else "cog_v2"
        self.acquire_calls += 1
        return Credential(
            scheme="X-API-Key",
            secret=RedactedSecret(secret),
            audience=BASE_URL,
            source="refreshing",
            authority=CredentialAuthority(
                provider_fingerprint="refreshing",
                product="harnessaas",
                normalized_origin=BASE_URL,
                audience=BASE_URL,
            ),
        )

    def identity(self) -> str:
        return "refreshing-credential-provider"

    async def invalidate(self, reason: str) -> None:
        del reason
        self.invalidate_calls += 1


def _solve_request() -> HarnessaaSSolveRequest:
    return HarnessaaSSolveRequest(
        repo="https://github.com/acme/widget.git",
        test_command="pytest -k test_widget",
        issue="Widget renders twice",
    )


def _solve_response_body() -> dict:
    return {
        "request_id": "req_abc123",
        "patch": "diff --git a/widget.py b/widget.py\n...",
        "resolved": True,
        "cost_receipt": {
            "request_id": "req_abc123",
            "model": "deepseek/deepseek-chat",
            "mode": "empty-patch-cascade",
            "tokens_in": 220,
            "tokens_out": 90,
            "cost_usd": 0.005,
            "route": "base",
            "escalated": False,
        },
        "lineage_ref": "lineageOf:req_abc123",
        "conformance": {
            "usedOracleDuringSolve": False,
            "statement": "solver saw only the customer test_command output",
            "visibleInputsDigest": "sha256:deadbeef",
        },
    }


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_construction_performs_no_io() -> None:
    with respx.mock:
        client = HarnessaaSClient(HarnessaaSClientConfig(base_url=BASE_URL))
        assert isinstance(client, HarnessaaSClient)


def test_rejects_non_https_base_url_by_default() -> None:
    with pytest.raises(ValueError):
        HarnessaaSClientConfig(base_url="http://127.0.0.1:9999")


def test_allows_non_https_base_url_when_opted_in() -> None:
    config = HarnessaaSClientConfig(base_url="http://127.0.0.1:9999", allow_insecure_http=True)
    client = HarnessaaSClient(config)
    assert isinstance(client, HarnessaaSClient)


def test_rejects_missing_base_url() -> None:
    with pytest.raises(ValueError):
        HarnessaaSClientConfig(base_url="")


def test_allow_insecure_http_rejects_non_loopback_host() -> None:
    with pytest.raises(ValueError):
        HarnessaaSClientConfig(base_url="http://example.com:9999", allow_insecure_http=True)


def test_capabilities_returns_intersection_safe_default() -> None:
    client = HarnessaaSClient(HarnessaaSClientConfig(base_url=BASE_URL))
    caps = client.capabilities()
    assert caps.features == {
        "solve": True,
        "lineage": True,
        "solve.vertical.code-repair": True,
        "solve.vertical.security-remediation": False,
        "solve.vertical.dependency-migration": False,
        "solve.vertical.test-generation": False,
    }
    assert caps.source == "static-compatibility-table"


def test_capabilities_snapshot_override_for_unrecognized_version_is_unsupported() -> None:
    client = HarnessaaSClient(
        HarnessaaSClientConfig(
            base_url=BASE_URL,
            capabilities_snapshot=CapabilitySet(
                product="harnessaas",
                product_version="9.9.9-unknown",
                protocol="cognitum.harnessaas.http",
                protocol_version="1.0",
                source="static-compatibility-table",
                features={},
                limitations=["unrecognized server version — minimum-safe set"],
                auth_methods=[],
            ),
        )
    )
    assert client.capabilities().features == {}


# ---------------------------------------------------------------------------
# solve() -- capability fail-closed (ADR-0019 §D6, issue #74)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_solve_fails_closed_for_unsupported_vertical_before_any_http() -> None:
    with respx.mock:
        # No route mounted -- any HTTP request would raise inside respx.
        client = HarnessaaSClient(
            HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
        )
        request = HarnessaaSSolveRequest(
            repo="https://github.com/acme/widget.git",
            test_command="pytest -k test_widget",
            issue="Widget renders twice",
            vertical="security-remediation",
        )
        with pytest.raises(UnsupportedCapabilityError):
            await client.solve(request)
        assert len(respx.calls) == 0
        await client.aclose()


@pytest.mark.asyncio
async def test_solve_fails_closed_for_every_unmodeled_vertical() -> None:
    for vertical in ("security-remediation", "dependency-migration", "test-generation"):
        with respx.mock:
            client = HarnessaaSClient(
                HarnessaaSClientConfig(
                    base_url=BASE_URL, credential_provider=_credential_provider()
                )
            )
            request = HarnessaaSSolveRequest(
                repo="https://github.com/acme/widget.git",
                test_command="pytest -k test_widget",
                issue="Widget renders twice",
                vertical=vertical,
            )
            with pytest.raises(UnsupportedCapabilityError):
                await client.solve(request)
            assert len(respx.calls) == 0
            await client.aclose()


@pytest.mark.asyncio
async def test_solve_fails_closed_when_snapshot_does_not_mark_solve_supported() -> None:
    with respx.mock:
        client = HarnessaaSClient(
            HarnessaaSClientConfig(
                base_url=BASE_URL,
                credential_provider=_credential_provider(),
                capabilities_snapshot=CapabilitySet(
                    product="harnessaas",
                    product_version="9.9.9-unknown",
                    protocol="cognitum.harnessaas.http",
                    protocol_version="1.0",
                    source="static-compatibility-table",
                    features={},
                    limitations=["unrecognized server version — minimum-safe set"],
                    auth_methods=[],
                ),
            )
        )
        with pytest.raises(UnsupportedCapabilityError):
            await client.solve(_solve_request())
        assert len(respx.calls) == 0
        await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_solve_allows_default_and_explicit_code_repair_vertical() -> None:
    route = respx.post(f"{BASE_URL}/solve").mock(
        return_value=httpx.Response(200, json=_solve_response_body())
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    await client.solve(_solve_request())
    request_with_explicit_vertical = HarnessaaSSolveRequest(
        repo="https://github.com/acme/widget.git",
        test_command="pytest -k test_widget",
        issue="Widget renders twice",
        vertical="code-repair",
    )
    await client.solve(request_with_explicit_vertical)

    assert route.call_count == 2
    await client.aclose()


# ---------------------------------------------------------------------------
# health()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_health_calls_health_not_healthz_without_credential() -> None:
    route = respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(200, json={"status": "ok", "mode": "mock", "backend": "mock"})
    )
    client = HarnessaaSClient(HarnessaaSClientConfig(base_url=BASE_URL))

    result = await client.health()

    assert result.data.status == "ok"
    assert result.data.mode == "mock"
    assert result.meta.http_status == 200
    assert route.call_count == 1
    request = respx.calls.last.request
    assert "X-API-Key" not in request.headers
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_health_maps_500_to_non_retryable_protocol_error() -> None:
    respx.get(f"{BASE_URL}/health").mock(
        return_value=httpx.Response(500, json={"error": "internal"})
    )
    client = HarnessaaSClient(HarnessaaSClientConfig(base_url=BASE_URL))

    with pytest.raises(AgenticError) as exc_info:
        await client.health()
    assert exc_info.value.kind == "protocol"
    assert exc_info.value.retryable is False
    await client.aclose()


# ---------------------------------------------------------------------------
# solve() -- success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_solve_sends_api_key_and_snake_case_body() -> None:
    route = respx.post(f"{BASE_URL}/solve").mock(
        return_value=httpx.Response(200, json=_solve_response_body())
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.solve(_solve_request())

    assert route.call_count == 1
    request = respx.calls.last.request
    assert request.headers.get("X-API-Key") == "cog_test_canary_1234"
    import json

    body = json.loads(request.content)
    assert body == {
        "repo": "https://github.com/acme/widget.git",
        "test_command": "pytest -k test_widget",
        "issue": "Widget renders twice",
    }
    assert result.data.request_id == "req_abc123"
    assert result.data.resolved is True
    assert result.data.cost_receipt.model == "deepseek/deepseek-chat"
    assert result.data.cost_receipt.tokens_in == 220
    assert result.data.conformance.used_oracle_during_solve is False
    assert result.data.lineage_ref == "lineageOf:req_abc123"
    await client.aclose()


@pytest.mark.asyncio
async def test_solve_fails_closed_without_credential_provider() -> None:
    client = HarnessaaSClient(HarnessaaSClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError) as exc_info:
        await client.solve(_solve_request())
    assert exc_info.value.kind == "authentication"
    await client.aclose()


# ---------------------------------------------------------------------------
# solve() -- error mapping and retry safety
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_solve_401_refreshes_credential_exactly_once_then_retries() -> None:
    route = respx.post(f"{BASE_URL}/solve")
    route.side_effect = [
        httpx.Response(401, json={"error": "Invalid API key.", "code": "invalid_api_key"}),
        httpx.Response(200, json=_solve_response_body()),
    ]
    provider = _RefreshingCredentialProvider()
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=provider)
    )

    result = await client.solve(_solve_request())

    assert result.data.request_id == "req_abc123"
    assert route.call_count == 2
    assert provider.acquire_calls == 2
    assert provider.invalidate_calls == 1
    key_1 = respx.calls[0].request.headers.get("X-API-Key")
    key_2 = respx.calls[1].request.headers.get("X-API-Key")
    assert key_1 == "cog_v1"
    assert key_2 == "cog_v2"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_solve_maps_403_insufficient_scope_to_permission_denied() -> None:
    respx.post(f"{BASE_URL}/solve").mock(
        return_value=httpx.Response(
            403, json={"error": "insufficient scope", "code": "insufficient_scope"}
        )
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.solve(_solve_request())
    assert exc_info.value.kind == "permission_denied"
    assert exc_info.value.retryable is False
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_solve_maps_422_to_safety_blocked() -> None:
    respx.post(f"{BASE_URL}/solve").mock(
        return_value=httpx.Response(
            422,
            json={"error": "request blocked by PII/safety pre-flight", "code": "safety_blocked"},
        )
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.solve(_solve_request())
    assert exc_info.value.kind == "safety_blocked"
    assert exc_info.value.retryable is False
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_solve_does_not_auto_retry_429_single_attempt() -> None:
    route = respx.post(f"{BASE_URL}/solve").mock(
        return_value=httpx.Response(
            429, json={"error": "rate limited"}, headers={"retry-after": "2"}
        )
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.solve(_solve_request())
    assert exc_info.value.kind == "rate_limited"
    assert exc_info.value.retryable is True
    assert exc_info.value.retry_after_ms == 2000
    # The critical assertion: exactly ONE HTTP attempt.
    assert route.call_count == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_solve_does_not_auto_retry_503_single_attempt() -> None:
    route = respx.post(f"{BASE_URL}/solve").mock(
        return_value=httpx.Response(503, json={"error": "upstream unavailable"})
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.solve(_solve_request())
    assert exc_info.value.kind == "transport"
    assert route.call_count == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_solve_does_not_auto_retry_transport_failure() -> None:
    route = respx.post(f"{BASE_URL}/solve").mock(side_effect=httpx.ConnectError("connection reset"))
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.solve(_solve_request())
    assert exc_info.value.kind == "transport"
    assert route.call_count == 1
    await client.aclose()


# ---------------------------------------------------------------------------
# lineage()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_lineage_fetches_and_parses_records() -> None:
    route = respx.get(f"{BASE_URL}/lineage/req_abc123").mock(
        return_value=httpx.Response(
            200,
            json={
                "request_id": "req_abc123",
                "records": [
                    {
                        "request_id": "req_abc123",
                        "ts": "2026-07-18T00:00:00.000Z",
                        "prev_hash": "sha256:prev",
                        "hash": "sha256:this",
                        "genome": {"base_tier": "cognitum-low"},
                    }
                ],
            },
        )
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.lineage("req_abc123")

    assert route.call_count == 1
    assert len(result.data.records) == 1
    assert result.data.records[0].hash == "sha256:this"
    assert "genome" in result.data.records[0].raw
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_lineage_maps_404_to_not_found() -> None:
    respx.get(f"{BASE_URL}/lineage/req_unknown").mock(
        return_value=httpx.Response(404, json={"error": "request_id not found"})
    )
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.lineage("req_unknown")
    assert exc_info.value.kind == "not_found"
    assert exc_info.value.retryable is False
    await client.aclose()


@pytest.mark.asyncio
async def test_lineage_fails_closed_without_credential_provider() -> None:
    client = HarnessaaSClient(HarnessaaSClientConfig(base_url=BASE_URL))
    with pytest.raises(AgenticError) as exc_info:
        await client.lineage("req_abc123")
    assert exc_info.value.kind == "authentication"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_lineage_retries_503_bounded_safe_read() -> None:
    route = respx.get(f"{BASE_URL}/lineage/req_abc123")
    route.side_effect = [
        httpx.Response(503, json={"error": "unavailable"}),
        httpx.Response(200, json={"request_id": "req_abc123", "records": []}),
    ]
    client = HarnessaaSClient(
        HarnessaaSClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.lineage("req_abc123")

    assert result.data.request_id == "req_abc123"
    assert route.call_count == 2
    await client.aclose()
