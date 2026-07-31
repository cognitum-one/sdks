"""Concrete ``CredentialProvider`` for a delegated Cognitum OAuth access
token (ADR-0022 §D1, §D2, §D3; ADR-0024a §D8). Closes the gap left by PR
#83's ``StaticApiKeyCredentialProvider``: ADR-0022 §D2's credential/header
matrix names Meta LLM as accepting "Product-declared ``cog_`` key OR a
delegated OAuth token" ("Never send both; route scope and auth method are
negotiated"), but until this provider, only the ``cog_``-key half of that
row had an implementation.

This provider does NOT implement an OAuth authorization-code/PKCE browser
login flow -- that is out of scope here, exactly as
``StaticApiKeyCredentialProvider`` accepts an already-resolved API key
rather than minting one. It accepts either:

- an explicit, already-acquired access token (optionally with its own
  expiry/granted-scopes), or
- an injectable async ``token_provider`` callback the caller wires to
  their own OAuth refresh-token flow, invoked lazily on first
  ``acquire()`` and again -- at most once per ``acquire()`` call -- when
  the current token is expired.

Wire scheme is ``"Bearer"`` (not ``"X-API-Key"``), per ADR-0022 §D2's
"delegated OAuth token" row and ADR-0024a §D8's OAuth-uses-bearer
convention; ``_apply_auth`` in ``cognitum.meta_llm.nonstream``/``client``
already special-cases ``scheme.lower() == "bearer"`` to write the standard
``Authorization`` header instead of a literal header named after the
scheme string, so this provider only has to supply that scheme name.

Origin/audience/product binding mirrors ``StaticApiKeyCredentialProvider``
exactly (ADR-0022 §D1/§D3): exact string equality only, no wildcard origin
or suffix matching. The returned secret is wrapped in the same
``RedactedSecret`` type -- ``repr``, ``str``, dataclass conversion, and
pickle-by-default MUST NOT reveal it.

No HTTP request is made or shaped here -- this class produces credentials,
it does not send them.
"""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone

from cognitum.agentic.credentials import (
    Credential,
    CredentialAuthority,
    CredentialRequest,
    RedactedSecret,
)
from cognitum.agentic.errors import AgenticError


#: Result of an :data:`OAuthTokenSource` invocation.
@dataclass(frozen=True)
class OAuthTokenSourceResult:
    access_token: str
    #: ``None`` means the token does not expire (or expiry is unknown).
    expires_at: datetime | None = None
    #: Scopes the identity service actually granted, if the caller's
    #: refresh flow surfaces them. Left ``None`` (rather than guessed)
    #: when the caller's OAuth flow doesn't expose this -- ADR-0022 §D5
    #: requires the SDK never assume a broader-looking string implies
    #: permission.
    granted_scopes: list[str] | None = None


#: Caller-supplied async callback wired to an already-implemented OAuth
#: refresh-token flow. This provider calls it to obtain an initial token
#: (when no explicit ``access_token`` is given) and to refresh an expired
#: one -- it never performs the authorization-code/PKCE exchange itself.
OAuthTokenSource = Callable[[], Awaitable[OAuthTokenSourceResult]]


@dataclass
class _ResolvedToken:
    access_token: str
    expires_at: datetime | None = None
    granted_scopes: list[str] | None = None


def _is_expired(token: _ResolvedToken, now: Callable[[], datetime]) -> bool:
    return token.expires_at is not None and token.expires_at <= now()


def _fingerprint_of_token(product: str, token: str) -> str:
    """Non-secret, non-reversible-in-practice fingerprint of a token value."""
    digest = hashlib.sha256(f"{product}:{token}".encode()).hexdigest()
    return digest[:16]


def _fingerprint_of_pending(product: str) -> str:
    """Non-secret per-instance fingerprint when no token is known yet."""
    nonce = secrets.token_hex(16)
    digest = hashlib.sha256(f"{product}:oauth-pending:{nonce}".encode()).hexdigest()
    return digest[:16]


def _default_now() -> datetime:
    return datetime.now(timezone.utc)


class OAuthTokenCredentialProvider:
    """Concrete ``CredentialProvider`` wrapping one delegated Cognitum
    OAuth access token (ADR-0022 §D1/§D2/§D3, ADR-0024a §D8).

    Fails closed on any product, origin, or audience mismatch (mirrors
    ``StaticApiKeyCredentialProvider._assert_match``), on an expired token
    with no refresh callback, and on any use after ``invalidate()``.
    Satisfies :class:`cognitum.agentic.credentials.CredentialProvider`
    structurally (duck-typed ``Protocol``).
    """

    def __init__(
        self,
        *,
        product: str,
        normalized_origin: str,
        audience: str,
        access_token: str | None = None,
        expires_at: datetime | None = None,
        granted_scopes: list[str] | None = None,
        token_provider: OAuthTokenSource | None = None,
        scheme: str = "Bearer",
        _now: Callable[[], datetime] = _default_now,
    ) -> None:
        if not access_token and token_provider is None:
            raise AgenticError(
                "configuration",
                "OAuthTokenCredentialProvider requires either an explicit "
                "access_token or a token_provider callback",
                product=product,
            )
        self._product = product
        self._normalized_origin = normalized_origin
        self._audience = audience
        self._scheme = scheme
        self._token_provider = token_provider
        self._now = _now
        self._invalidated = False

        if access_token:
            self._current: _ResolvedToken | None = _ResolvedToken(
                access_token=access_token,
                expires_at=expires_at,
                granted_scopes=granted_scopes,
            )
            self._fingerprint = _fingerprint_of_token(product, access_token)
        else:
            # No token is known yet -- the first `acquire()` call fetches
            # one from `token_provider`. `identity()` still needs a
            # stable, non-secret value before that happens.
            self._current = None
            self._fingerprint = _fingerprint_of_pending(product)

    def identity(self) -> str:
        """Non-secret stable provider identity, safe to log."""
        return f"oauth-token:{self._product}:{self._fingerprint}"

    async def describe_authority(self, request: CredentialRequest) -> CredentialAuthority:
        self._assert_match(request)
        return self._authority()

    async def acquire(self, request: CredentialRequest) -> Credential:
        self._assert_match(request)
        if self._invalidated:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} has been invalidated",
                product=self._product,
                operation=request.operation,
            )

        token = self._current
        if token is None or _is_expired(token, self._now):
            if self._token_provider is None:
                raise AgenticError(
                    "authentication",
                    f"credential provider {self.identity()} has no valid access "
                    "token (expired and no token_provider callback was "
                    "configured to refresh it)",
                    product=self._product,
                    operation=request.operation,
                )
            refreshed = await self._token_provider()
            token = _ResolvedToken(
                access_token=refreshed.access_token,
                expires_at=refreshed.expires_at,
                granted_scopes=refreshed.granted_scopes,
            )
            if _is_expired(token, self._now):
                raise AgenticError(
                    "authentication",
                    f"credential provider {self.identity()}'s token_provider "
                    "returned an already-expired access token",
                    product=self._product,
                    operation=request.operation,
                )
            self._current = token
            self._fingerprint = _fingerprint_of_token(self._product, token.access_token)

        return Credential(
            scheme=self._scheme,
            secret=RedactedSecret(token.access_token),
            expires_at=token.expires_at.isoformat() if token.expires_at else None,
            granted_scopes=token.granted_scopes,
            audience=self._audience,
            source=self.identity(),
            authority=self._authority(),
        )

    async def invalidate(self, reason: str) -> None:
        del reason  # not persisted; concrete providers may log/audit this
        self._invalidated = True

    def _authority(self) -> CredentialAuthority:
        return CredentialAuthority(
            provider_fingerprint=self._fingerprint,
            product=self._product,
            normalized_origin=self._normalized_origin,
            audience=self._audience,
            effective_scopes=self._current.granted_scopes if self._current else None,
        )

    def _assert_match(self, request: CredentialRequest) -> None:
        """Fail-closed match check (ADR-0022 §D1/§D3).

        Exact string equality only -- no wildcard origin, suffix matching,
        or DNS-parent trust.
        """
        if request.product != self._product:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} is bound to product "
                f'"{self._product}", refusing request for product '
                f'"{request.product}"',
                product=self._product,
                operation=request.operation,
            )
        if request.normalized_origin != self._normalized_origin:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} is bound to origin "
                f'"{self._normalized_origin}", refusing request for origin '
                f'"{request.normalized_origin}" (ADR-0022 §D3: a redirect to '
                "another origin is not followed with credentials)",
                product=self._product,
                operation=request.operation,
            )
        if request.audience != self._audience:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} is bound to audience "
                f'"{self._audience}", refusing request for audience '
                f'"{request.audience}"',
                product=self._product,
                operation=request.operation,
            )


__all__ = [
    "OAuthTokenSource",
    "OAuthTokenSourceResult",
    "OAuthTokenCredentialProvider",
]
