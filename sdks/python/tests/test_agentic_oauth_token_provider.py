"""Tests for ``OAuthTokenCredentialProvider`` (ADR-0022 §D1/§D2/§D3,
ADR-0024a §D8).

Covers:

- successful ``acquire``/``describe_authority`` with an explicit token and
  with a lazily-invoked ``token_provider`` callback;
- expiry handling: refresh-once via ``token_provider``, fail-closed
  without one, and fail-closed when the callback itself returns an
  already-expired token;
- fail-closed construction with neither ``access_token`` nor
  ``token_provider``;
- fail-closed refusal on origin/audience/product mismatch (mirrors the
  static-api-key-provider tests);
- that the returned secret is genuinely wrapped in ``RedactedSecret`` and
  does not leak through ``repr``/``str``/pickling/exception formatting;
- Bearer scheme (not ``X-API-Key``);
- ``invalidate()`` makes subsequent ``acquire()`` fail permanently.
"""

from __future__ import annotations

import pickle
from datetime import datetime, timedelta, timezone

import pytest

from cognitum.agentic import AgenticError, CredentialRequest, RedactedSecret
from cognitum.agentic.oauth_token_provider import (
    OAuthTokenCredentialProvider,
    OAuthTokenSourceResult,
)

CANARY = "oauth-canary-9f3aQzL0m1"
REFRESHED = "oauth-refreshed-CT9f3aQ"


def _request(**overrides: object) -> CredentialRequest:
    fields: dict[str, object] = {
        "product": "meta-llm",
        "normalized_origin": "https://meta-llm.test.cognitum.one",
        "audience": "https://meta-llm.test.cognitum.one",
        "operation": "chat.completions",
        "interactive_allowed": False,
        "required_scopes": [],
    }
    fields.update(overrides)
    return CredentialRequest(**fields)  # type: ignore[arg-type]


def _provider(**overrides: object) -> OAuthTokenCredentialProvider:
    fields: dict[str, object] = {
        "access_token": CANARY,
        "product": "meta-llm",
        "normalized_origin": "https://meta-llm.test.cognitum.one",
        "audience": "https://meta-llm.test.cognitum.one",
    }
    fields.update(overrides)
    return OAuthTokenCredentialProvider(**fields)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_acquires_credential_for_matching_origin_and_audience() -> None:
    provider = _provider()
    credential = await provider.acquire(_request())

    assert credential.scheme == "Bearer"
    assert credential.audience == "https://meta-llm.test.cognitum.one"
    assert credential.authority.normalized_origin == "https://meta-llm.test.cognitum.one"
    assert credential.authority.product == "meta-llm"
    assert isinstance(credential.secret, RedactedSecret)
    assert credential.secret.reveal() == CANARY


@pytest.mark.asyncio
async def test_uses_bearer_scheme_not_api_key() -> None:
    provider = _provider()
    credential = await provider.acquire(_request())
    assert credential.scheme.lower() == "bearer"
    assert credential.scheme != "X-API-Key"


@pytest.mark.asyncio
async def test_describe_authority_succeeds_for_matching_request() -> None:
    provider = _provider()
    authority = await provider.describe_authority(_request())
    assert authority.audience == "https://meta-llm.test.cognitum.one"
    assert authority.normalized_origin == "https://meta-llm.test.cognitum.one"


@pytest.mark.asyncio
async def test_acquires_initial_token_lazily_from_token_provider() -> None:
    calls = 0

    async def token_provider() -> OAuthTokenSourceResult:
        nonlocal calls
        calls += 1
        return OAuthTokenSourceResult(access_token=CANARY)

    provider = OAuthTokenCredentialProvider(
        product="meta-llm",
        normalized_origin="https://meta-llm.test.cognitum.one",
        audience="https://meta-llm.test.cognitum.one",
        token_provider=token_provider,
    )
    credential = await provider.acquire(_request())
    assert credential.secret.reveal() == CANARY
    assert calls == 1

    # Second acquire reuses the cached (non-expired) token -- no refresh.
    await provider.acquire(_request())
    assert calls == 1


@pytest.mark.asyncio
async def test_refreshes_expired_explicit_token_exactly_once_via_callback() -> None:
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    calls = 0

    async def token_provider() -> OAuthTokenSourceResult:
        nonlocal calls
        calls += 1
        return OAuthTokenSourceResult(access_token=REFRESHED)

    provider = OAuthTokenCredentialProvider(
        access_token=CANARY,
        expires_at=past,
        product="meta-llm",
        normalized_origin="https://meta-llm.test.cognitum.one",
        audience="https://meta-llm.test.cognitum.one",
        token_provider=token_provider,
    )
    credential = await provider.acquire(_request())
    assert credential.secret.reveal() == REFRESHED
    assert calls == 1


@pytest.mark.asyncio
async def test_fails_closed_when_expired_and_no_token_provider() -> None:
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    provider = OAuthTokenCredentialProvider(
        access_token=CANARY,
        expires_at=past,
        product="meta-llm",
        normalized_origin="https://meta-llm.test.cognitum.one",
        audience="https://meta-llm.test.cognitum.one",
    )
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request())
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_fails_closed_when_token_provider_returns_expired_token() -> None:
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    calls = 0

    async def token_provider() -> OAuthTokenSourceResult:
        nonlocal calls
        calls += 1
        return OAuthTokenSourceResult(access_token=REFRESHED, expires_at=past)

    provider = OAuthTokenCredentialProvider(
        product="meta-llm",
        normalized_origin="https://meta-llm.test.cognitum.one",
        audience="https://meta-llm.test.cognitum.one",
        token_provider=token_provider,
    )
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request())
    assert exc_info.value.kind == "authentication"
    assert calls == 1


def test_fails_at_construction_without_token_or_provider() -> None:
    with pytest.raises(AgenticError):
        OAuthTokenCredentialProvider(
            product="meta-llm",
            normalized_origin="https://meta-llm.test.cognitum.one",
            audience="https://meta-llm.test.cognitum.one",
        )


@pytest.mark.asyncio
async def test_refuses_acquire_for_different_origin() -> None:
    provider = _provider()
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(
            _request(normalized_origin="https://evil.example.com")
        )
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_refuses_audience_mismatch() -> None:
    provider = _provider()
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request(audience="meta-proxy-api"))
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_refuses_product_mismatch() -> None:
    provider = _provider()
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request(product="meta-proxy"))
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_secret_does_not_leak_via_repr_str_or_pickle() -> None:
    provider = _provider()
    credential = await provider.acquire(_request())

    assert CANARY not in repr(credential.secret)
    assert CANARY not in str(credential.secret)
    assert "[REDACTED]" in repr(credential.secret)

    pickled = pickle.dumps(credential.secret)
    assert CANARY.encode("utf-8") not in pickled
    restored = pickle.loads(pickled)
    assert isinstance(restored, RedactedSecret)
    assert restored.reveal() == "[REDACTED]"

    assert CANARY not in repr(credential)


@pytest.mark.asyncio
async def test_secret_does_not_leak_via_raised_error() -> None:
    provider = _provider()
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(
            _request(normalized_origin="https://evil.example.com")
        )
    err = exc_info.value
    assert CANARY not in str(err)
    assert CANARY not in repr(err)


def test_identity_is_stable_non_secret() -> None:
    provider = _provider()
    identity = provider.identity()
    assert CANARY not in identity
    assert identity == provider.identity()


@pytest.mark.asyncio
async def test_refuses_acquire_after_invalidate() -> None:
    provider = _provider()
    await provider.invalidate("rotated")
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request())
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_carries_granted_scopes_through_when_known() -> None:
    provider = _provider(granted_scopes=["meta-llm.inference"])
    credential = await provider.acquire(_request())
    assert credential.granted_scopes == ["meta-llm.inference"]


@pytest.mark.asyncio
async def test_leaves_granted_scopes_none_when_unknown() -> None:
    provider = _provider()
    credential = await provider.acquire(_request())
    assert credential.granted_scopes is None
