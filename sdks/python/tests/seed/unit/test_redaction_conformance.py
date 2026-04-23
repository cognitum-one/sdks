"""End-to-end redaction conformance (issue #21 / audit §C).

With :class:`SecretString` wrapping :class:`PairCreateResponse.token`
and :class:`SeedAuth.__repr__` redacting the configured pairing token,
no formatter path in the seed SDK should leak a sentinel secret. This
test fires a sentinel token through the config, triggers representative
error paths (401/403/429/500), and asserts the sentinel never appears in
``str(exc)``, ``repr(exc)``, or ``traceback.format_exception(...)``.
"""

from __future__ import annotations

import traceback

import httpx
import pytest
import respx

from cognitum._errors import (
    AuthError,
    RateLimitError,
)
from cognitum.seed import (
    ApiError,
    AsyncSeedClient,
    SeedAuth,
    SeedClient,
    SeedTLS,
)
from cognitum.seed._models import PairCreateResponse
from cognitum.seed._token_book import SecretString


BASE = "https://localhost:18443"
SENTINEL = "redact-me-9f3a2bc81d7e4fa65ceb0f12-SENTINEL"


def _format_all(exc: BaseException) -> str:
    return "\n".join(
        [
            str(exc),
            repr(exc),
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
        ]
    )


def _client() -> SeedClient:
    return SeedClient(
        BASE,
        auth=SeedAuth(pairing_token=SENTINEL),
        tls=SeedTLS(insecure=True),
        max_retries=0,
        max_elapsed_ms=1_000,
    )


def test_seed_auth_repr_does_not_leak_token() -> None:
    auth = SeedAuth(pairing_token=SENTINEL, api_key=SENTINEL + "-api")
    assert SENTINEL not in repr(auth)
    assert SENTINEL not in str(auth)
    assert "redacted" in repr(auth).lower()
    # Value still accessible for the request path.
    assert auth.pairing_token == SENTINEL


def test_seed_auth_repr_inside_f_string() -> None:
    auth = SeedAuth(pairing_token=SENTINEL)
    rendered = f"auth={auth}"
    assert SENTINEL not in rendered


@respx.mock
def test_401_error_does_not_leak_configured_token() -> None:
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "unauthorised"})
    )
    with _client() as c:
        try:
            c.status()
        except AuthError as exc:
            blob = _format_all(exc)
            assert SENTINEL not in blob, (
                f"Token sentinel leaked via AuthError formatter: {blob!r}"
            )
        else:
            pytest.fail("expected AuthError")


@respx.mock
def test_403_error_does_not_leak_configured_token() -> None:
    respx.post(f"{BASE}/api/v1/store/query").mock(
        return_value=httpx.Response(403, json={"error": "not paired"})
    )
    with _client() as c:
        try:
            c.store.query(vector=[0.1], k=1)
        except AuthError as exc:
            blob = _format_all(exc)
            assert SENTINEL not in blob
        else:
            pytest.fail("expected AuthError")


@respx.mock
def test_429_error_does_not_leak_configured_token() -> None:
    # 429 → RateLimitError; with max_retries=0 it surfaces after the
    # first response.
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(
            429, json={"error": "rate limited"}, headers={"Retry-After": "30"}
        )
    )
    with _client() as c:
        try:
            c.status()
        except RateLimitError as exc:
            blob = _format_all(exc)
            assert SENTINEL not in blob
        else:
            pytest.fail("expected RateLimitError")


@respx.mock
def test_500_error_does_not_leak_configured_token() -> None:
    respx.post(f"{BASE}/api/v1/store/ingest").mock(
        return_value=httpx.Response(500, json={"error": "boom"})
    )
    with _client() as c:
        from cognitum.seed import VectorUpsert

        try:
            c.store.ingest(vectors=[VectorUpsert(id="a", values=(1.0,))])
        except Exception as exc:
            blob = _format_all(exc)
            assert SENTINEL not in blob
            assert isinstance(exc, ApiError)
        else:
            pytest.fail("expected ApiError / 5xx")


def test_pair_create_response_repr_does_not_leak() -> None:
    # Paranoia check — covered more thoroughly in
    # test_pair_token_redaction.py; included here to lock the contract
    # in at the conformance level.
    resp = PairCreateResponse.from_wire(
        {"paired": True, "token": SENTINEL, "client_name": "t"}
    )
    assert SENTINEL not in repr(resp)
    assert SENTINEL not in str(resp)
    assert SENTINEL not in f"{resp}"


def test_secret_string_alone_does_not_leak() -> None:
    s = SecretString(SENTINEL)
    assert SENTINEL not in repr(s)
    assert SENTINEL not in str(s)
    # Value accessible on the request path.
    assert s.as_str() == SENTINEL


def test_async_client_config_repr_does_not_leak() -> None:
    # Construction alone must not render the secret. AsyncSeedClient
    # stores the normalised SeedClientOptions (which contains SeedAuth)
    # on self._options.
    client = AsyncSeedClient(
        BASE,
        auth=SeedAuth(pairing_token=SENTINEL),
        tls=SeedTLS(insecure=True),
    )
    try:
        assert SENTINEL not in repr(client.options.auth)
        assert SENTINEL not in str(client.options.auth)
    finally:
        # No event loop running — use asyncio.run for the cleanup.
        import asyncio

        asyncio.new_event_loop().run_until_complete(client.close())
