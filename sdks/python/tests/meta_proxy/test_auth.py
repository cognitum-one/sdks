"""Tests for the §D6 local-bearer credential provider and ProxyCredential
types (issue #61 / M3 D5-D7)."""

from __future__ import annotations

import pytest

from cognitum.agentic import AgenticError
from cognitum.agentic.credentials import CredentialRequest
from cognitum.meta_proxy import (
    LocalBearerToken,
    LocalBearerTokenCredentialProvider,
    WorkloadCapability,
    WorkloadCapabilityClaims,
)
from cognitum.meta_proxy.auth import DEFAULT_META_PROXY_TOKEN_ENV_VAR

ORIGIN = "http://127.0.0.1:11435"


def _request(
    *,
    product: str = "meta-proxy",
    origin: str = ORIGIN,
    audience: str = ORIGIN,
) -> CredentialRequest:
    return CredentialRequest(
        product=product,
        normalized_origin=origin,
        audience=audience,
        required_scopes=["meta-proxy.inference"],
        operation="chat.completions",
        interactive_allowed=False,
    )


def test_construction_fails_closed_without_a_token() -> None:
    with pytest.raises(AgenticError) as exc_info:
        LocalBearerTokenCredentialProvider(
            normalized_origin=ORIGIN, audience=ORIGIN, env={}
        )
    assert exc_info.value.kind == "configuration"


def test_reads_token_from_the_env_var() -> None:
    provider = LocalBearerTokenCredentialProvider(
        normalized_origin=ORIGIN,
        audience=ORIGIN,
        env={DEFAULT_META_PROXY_TOKEN_ENV_VAR: "mh1.env-canary"},
    )
    assert provider.identity().startswith("local-proxy-bearer:meta-proxy:")


@pytest.mark.asyncio
async def test_acquire_returns_a_bearer_credential() -> None:
    provider = LocalBearerTokenCredentialProvider(
        normalized_origin=ORIGIN, audience=ORIGIN, token="mh1.explicit-canary"
    )
    credential = await provider.acquire(_request())
    assert credential.scheme == "bearer"
    assert credential.secret.reveal() == "mh1.explicit-canary"


@pytest.mark.asyncio
async def test_acquire_fails_closed_on_origin_mismatch() -> None:
    provider = LocalBearerTokenCredentialProvider(
        normalized_origin=ORIGIN, audience=ORIGIN, token="mh1.canary"
    )
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request(origin="http://127.0.0.1:9"))
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_acquire_fails_closed_after_invalidate() -> None:
    provider = LocalBearerTokenCredentialProvider(
        normalized_origin=ORIGIN, audience=ORIGIN, token="mh1.canary"
    )
    await provider.invalidate("rotated")
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request())
    assert exc_info.value.kind == "authentication"


def test_proxy_credential_union_variants_are_tagged() -> None:
    bearer = LocalBearerToken()
    assert bearer.kind == "local_bearer_token"

    capability = WorkloadCapability(
        claims=WorkloadCapabilityClaims(
            version="mh1",
            policy="standard",
            worktree_id="wt-1",
            expires_at="2026-07-18T12:00:00Z",
        )
    )
    assert capability.kind == "workload_capability"
    assert capability.claims.worktree_id == "wt-1"
