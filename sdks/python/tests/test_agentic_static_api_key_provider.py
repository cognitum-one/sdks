"""Tests for ``StaticApiKeyCredentialProvider`` (ADR-0022 §D1/§D2/§D3,
issue #53).

Covers:

- successful ``acquire``/``describe_authority`` for the matching
  product/origin/audience;
- fail-closed refusal on origin mismatch (the "redirect is not followed
  with credentials" behaviour required by ADR-0022 §D3), audience
  mismatch, and product mismatch;
- that the returned secret is genuinely wrapped in ``RedactedSecret`` and
  does not leak through ``repr``/``str``/pickling/exception formatting.
"""

from __future__ import annotations

import pickle

import pytest

from cognitum.agentic import (
    AgenticError,
    CredentialRequest,
    RedactedSecret,
)
from cognitum.agentic.static_api_key_provider import (
    DEFAULT_API_KEY_ENV_VAR,
    StaticApiKeyCredentialProvider,
)

CANARY = "sk-canary-CT9f3aQzL0m1"


def _request(**overrides: object) -> CredentialRequest:
    fields: dict[str, object] = {
        "product": "cognitum-cloud",
        "normalized_origin": "https://api.cognitum.one",
        "audience": "cognitum-cloud-api",
        "operation": "catalog.browse",
        "interactive_allowed": False,
        "required_scopes": [],
    }
    fields.update(overrides)
    return CredentialRequest(**fields)  # type: ignore[arg-type]


def _provider(**overrides: object) -> StaticApiKeyCredentialProvider:
    fields: dict[str, object] = {
        "api_key": CANARY,
        "product": "cognitum-cloud",
        "normalized_origin": "https://api.cognitum.one",
        "audience": "cognitum-cloud-api",
    }
    fields.update(overrides)
    return StaticApiKeyCredentialProvider(**fields)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_acquires_credential_for_matching_origin_and_audience() -> None:
    provider = _provider()
    credential = await provider.acquire(_request())

    assert credential.scheme == "X-API-Key"
    assert credential.audience == "cognitum-cloud-api"
    assert credential.authority.normalized_origin == "https://api.cognitum.one"
    assert credential.authority.product == "cognitum-cloud"
    assert isinstance(credential.secret, RedactedSecret)
    assert credential.secret.reveal() == CANARY


@pytest.mark.asyncio
async def test_describe_authority_succeeds_for_matching_request() -> None:
    provider = _provider()
    authority = await provider.describe_authority(_request())
    assert authority.audience == "cognitum-cloud-api"
    assert authority.normalized_origin == "https://api.cognitum.one"


@pytest.mark.asyncio
async def test_refuses_acquire_for_different_origin() -> None:
    """ADR-0022 §D3: "a redirect to another origin is not followed with
    credentials" -- exercised here as a direct provider-level refusal."""
    provider = _provider()
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(
            _request(normalized_origin="https://evil.example.com")
        )
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_refuses_describe_authority_for_different_origin() -> None:
    provider = _provider()
    with pytest.raises(AgenticError):
        await provider.describe_authority(
            _request(normalized_origin="https://evil.example.com")
        )


@pytest.mark.asyncio
async def test_refuses_subdomain_suffix_match_origin() -> None:
    """No wildcard origin, suffix matching, or DNS-parent trust (ADR-0022 §D3)."""
    provider = _provider()
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(
            _request(normalized_origin="https://sub.api.cognitum.one")
        )
    assert exc_info.value.kind == "authentication"


@pytest.mark.asyncio
async def test_refuses_audience_mismatch() -> None:
    provider = _provider()
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request(audience="meta-llm-api"))
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

    # dataclass repr of the whole Credential must not embed the raw value.
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
async def test_resolves_key_from_env_var_when_no_explicit_key() -> None:
    provider = StaticApiKeyCredentialProvider(
        product="cognitum-cloud",
        normalized_origin="https://api.cognitum.one",
        audience="cognitum-cloud-api",
        env={DEFAULT_API_KEY_ENV_VAR: CANARY},
    )
    credential = await provider.acquire(_request())
    assert credential.secret.reveal() == CANARY


def test_fails_at_construction_without_key_or_env_var() -> None:
    with pytest.raises(AgenticError):
        StaticApiKeyCredentialProvider(
            product="cognitum-cloud",
            normalized_origin="https://api.cognitum.one",
            audience="cognitum-cloud-api",
            env={},
        )


@pytest.mark.asyncio
async def test_refuses_acquire_after_invalidate() -> None:
    provider = _provider()
    await provider.invalidate("rotated")
    with pytest.raises(AgenticError) as exc_info:
        await provider.acquire(_request())
    assert exc_info.value.kind == "authentication"
