"""Concrete ``CredentialProvider`` for a static Cognitum-cloud API key
(ADR-0022 §D1, §D2, §D3). Issue #53 / M1 follow-up -- the frozen
``CredentialProvider`` protocol from issue #52 (``./credentials.py``) gets
its first real implementation here.

This wraps a caller-supplied API key (or ``COGNITUM_API_KEY``, per
ADR-0003's §"Credential provisioning" resolution order, mirroring the Node
SDK's ``resolveApiKey`` in ``../client.ts``) and hands it out only for the
exact ``product`` / ``normalized_origin`` / ``audience`` the provider was
constructed for (ADR-0022 §D1/§D3: "The provider MUST refuse an audience or
origin mismatch" / "Credential providers are bound to the normalized origin
selected during client construction. A redirect to another origin is not
followed with credentials."). There is no wildcard origin or suffix
matching -- every check below is exact string equality.

No HTTP request is made or shaped here -- this class produces credentials,
it does not send them.
"""

from __future__ import annotations

import hashlib
import os

from cognitum.agentic.credentials import (
    Credential,
    CredentialAuthority,
    CredentialRequest,
    RedactedSecret,
)
from cognitum.agentic.errors import AgenticError

#: Canonical env var per ADR-0003 §"Credential provisioning" / ``../client.py``.
DEFAULT_API_KEY_ENV_VAR = "COGNITUM_API_KEY"


def _resolve_key(
    api_key: str | None,
    env_var: str,
    env: dict[str, str] | None,
    product: str,
) -> str:
    if api_key:
        return api_key
    source = env if env is not None else os.environ
    from_env = source.get(env_var)
    if from_env:
        return from_env
    raise AgenticError(
        "configuration",
        f"api_key is required — pass api_key or set {env_var}",
        product=product,
    )


def _fingerprint_of(product: str, key: str) -> str:
    """Non-secret, non-reversible-in-practice fingerprint of a key value."""
    digest = hashlib.sha256(f"{product}:{key}".encode()).hexdigest()
    return digest[:16]


class StaticApiKeyCredentialProvider:
    """Concrete ``CredentialProvider`` wrapping one static Cognitum-cloud
    API key (ADR-0022 §D1/§D2/§D3).

    Fails closed on any product, origin, or audience mismatch -- see
    :meth:`_assert_match`. Satisfies
    :class:`cognitum.agentic.credentials.CredentialProvider` structurally
    (duck-typed ``Protocol``, verified via ``isinstance`` in tests).
    """

    def __init__(
        self,
        *,
        product: str,
        normalized_origin: str,
        audience: str,
        api_key: str | None = None,
        env_var: str = DEFAULT_API_KEY_ENV_VAR,
        scheme: str = "X-API-Key",
        env: dict[str, str] | None = None,
    ) -> None:
        key = _resolve_key(api_key, env_var, env, product)
        self._secret = RedactedSecret(key)
        self._product = product
        self._normalized_origin = normalized_origin
        self._audience = audience
        self._scheme = scheme
        self._fingerprint = _fingerprint_of(product, key)
        self._invalidated = False

    def identity(self) -> str:
        """Non-secret stable provider identity, safe to log."""
        return f"static-api-key:{self._product}:{self._fingerprint}"

    async def describe_authority(
        self, request: CredentialRequest
    ) -> CredentialAuthority:
        self._assert_match(request)
        return self._authority()

    async def acquire(self, request: CredentialRequest) -> Credential:
        self._assert_match(request)
        if self._invalidated:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} has been invalidated",
                product=self._product,
            )
        return Credential(
            scheme=self._scheme,
            secret=self._secret,
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
    "DEFAULT_API_KEY_ENV_VAR",
    "StaticApiKeyCredentialProvider",
]
