"""Meta Proxy authentication types and the local-bearer credential provider
(ADR-0025a §D6).

Two credential shapes exist in D6's ``ProxyCredential = LocalBearerToken |
WorkloadCapability`` union:

- :class:`LocalBearerToken` -- the raw ``mh1.<payload>.<hmac>`` local proxy
  token. This pass ships a real, constructable provider for it
  (:class:`LocalBearerTokenCredentialProvider`), mirroring M1's
  ``StaticApiKeyCredentialProvider`` exactly (construction-time fail-closed,
  exact product/origin/audience matching) but defaulting to the ``"bearer"``
  scheme and the ``COGNITUM_META_PROXY_TOKEN`` env var.
- :class:`WorkloadCapability` -- a scoped, short-lived capability minted FROM
  the local bearer. It is **type-only** here: minting requires an injected
  ``MetaProxyLifecycleProvider`` (ADR-0025b) that advertises the exact scoped
  operation, and ADR-0026a defines the MetaHarness-backed adapter. The SDK
  "may validate non-secret claims but does not mint capabilities itself"
  (§D6), so this module deliberately ships NO constructor/factory that
  produces a ``WorkloadCapability`` from a token.

The bearer is sent only to literal loopback through a direct transport
(§D6/§D10); that transport-level enforcement lives in
:mod:`cognitum.meta_proxy.client` / :mod:`cognitum.meta_proxy.config`, not
here -- this module only produces credentials, it does not send them.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Literal

from cognitum.agentic.credentials import (
    Credential,
    CredentialAuthority,
    CredentialRequest,
    RedactedSecret,
)
from cognitum.agentic.errors import AgenticError

_PRODUCT = "meta-proxy"

#: Env var the local proxy token is read from when no explicit ``token`` is
#: passed. Chosen to mirror the Node/Rust siblings' local-bearer variable.
DEFAULT_META_PROXY_TOKEN_ENV_VAR = "COGNITUM_META_PROXY_TOKEN"


@dataclass(frozen=True)
class LocalBearerToken:
    """The raw local proxy bearer variant of ``ProxyCredential`` (ADR-0025a §D6).

    A tagged marker: the secret itself lives inside a
    :class:`~cognitum.agentic.credentials.RedactedSecret` held by the
    credential provider, never on this shape.
    """

    kind: Literal["local_bearer_token"] = "local_bearer_token"


@dataclass(frozen=True)
class WorkloadCapabilityClaims:
    """Non-secret claims carried by a workload capability (ADR-0025a §D6).

    The current wire format is ``mh1.<payload>.<hmac>`` signed with the local
    proxy token, expiring at most 12 hours ahead. The SDK may validate these
    non-secret claims but never mints the capability itself.
    """

    version: str
    policy: str
    worktree_id: str
    expires_at: str


@dataclass(frozen=True)
class WorkloadCapability:
    """The scoped-capability variant of ``ProxyCredential`` (ADR-0025a §D6).

    TYPE-ONLY this pass. Minting requires an injected
    ``MetaProxyLifecycleProvider`` (ADR-0025b) / the MetaHarness adapter
    (ADR-0026a); there is deliberately no constructor/factory here that
    produces one from a token.
    """

    claims: WorkloadCapabilityClaims
    kind: Literal["workload_capability"] = "workload_capability"


#: D6's ``ProxyCredential = LocalBearerToken | WorkloadCapability``
#: discriminated union (tagged by the ``kind`` field).
ProxyCredential = LocalBearerToken | WorkloadCapability


def _resolve_token(
    token: str | None,
    env_var: str,
    env: dict[str, str] | None,
) -> str:
    if token:
        return token
    source = env if env is not None else os.environ
    from_env = source.get(env_var)
    if from_env:
        return from_env
    raise AgenticError(
        "configuration",
        f"local proxy token is required — pass token or set {env_var}",
        product=_PRODUCT,
    )


def _fingerprint_of(product: str, token: str) -> str:
    """Non-secret, non-reversible-in-practice fingerprint of a token value."""
    digest = hashlib.sha256(f"{product}:{token}".encode()).hexdigest()
    return digest[:16]


class LocalBearerTokenCredentialProvider:
    """Concrete ``CredentialProvider`` wrapping one local proxy bearer token
    (ADR-0025a §D6, following M1's ``StaticApiKeyCredentialProvider`` pattern).

    Construction fails closed if no token is supplied (explicit ``token`` arg
    or the ``COGNITUM_META_PROXY_TOKEN`` env var). Hands the token out only
    for the exact ``product`` / ``normalized_origin`` / ``audience`` it was
    constructed for -- exact string equality, no wildcard or suffix matching
    (ADR-0022 §D1/§D3). Uses the ``"bearer"`` scheme so
    ``MetaProxyClient`` places it in the ``Authorization`` header.

    Satisfies :class:`cognitum.agentic.credentials.CredentialProvider`
    structurally.
    """

    def __init__(
        self,
        *,
        normalized_origin: str,
        audience: str,
        token: str | None = None,
        env_var: str = DEFAULT_META_PROXY_TOKEN_ENV_VAR,
        scheme: str = "bearer",
        product: str = _PRODUCT,
        env: dict[str, str] | None = None,
    ) -> None:
        resolved = _resolve_token(token, env_var, env)
        self._secret = RedactedSecret(resolved)
        self._product = product
        self._normalized_origin = normalized_origin
        self._audience = audience
        self._scheme = scheme
        self._fingerprint = _fingerprint_of(product, resolved)
        self._invalidated = False

    def identity(self) -> str:
        """Non-secret stable provider identity, safe to log."""
        return f"local-proxy-bearer:{self._product}:{self._fingerprint}"

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
        """Fail-closed match check (ADR-0022 §D1/§D3), exact equality only."""
        if request.product != self._product:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} is bound to product "
                f'"{self._product}", refusing request for product "{request.product}"',
                product=self._product,
                operation=request.operation,
            )
        if request.normalized_origin != self._normalized_origin:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} is bound to origin "
                f'"{self._normalized_origin}", refusing request for origin '
                f'"{request.normalized_origin}" (ADR-0022 §D3: a redirect to another '
                "origin is not followed with credentials)",
                product=self._product,
                operation=request.operation,
            )
        if request.audience != self._audience:
            raise AgenticError(
                "authentication",
                f"credential provider {self.identity()} is bound to audience "
                f'"{self._audience}", refusing request for audience "{request.audience}"',
                product=self._product,
                operation=request.operation,
            )


__all__ = [
    "DEFAULT_META_PROXY_TOKEN_ENV_VAR",
    "LocalBearerToken",
    "WorkloadCapabilityClaims",
    "WorkloadCapability",
    "ProxyCredential",
    "LocalBearerTokenCredentialProvider",
]
