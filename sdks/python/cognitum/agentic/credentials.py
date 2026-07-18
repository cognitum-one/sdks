"""Credential-provider contract and secret redaction (ADR-0022 §D1, §D10).

Type-only scaffolding (issue #52 / M1) -- no HTTP implementation ships in
this pass. Concrete providers land in issue #53; redaction logic in #54.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable


@dataclass(frozen=True)
class CredentialRequest:
    """Parameters describing the credential a caller is about to request."""

    product: str
    normalized_origin: str
    audience: str
    operation: str
    interactive_allowed: bool
    required_scopes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class CredentialAuthority:
    """Non-secret authority descriptor used to partition capability/cache state."""

    provider_fingerprint: str
    product: str
    normalized_origin: str
    audience: str
    principal: str | None = None
    tenant: str | None = None
    delegated_subtenant: str | None = None
    effective_scopes: list[str] | None = None
    plan: str | None = None


class RedactedSecret:
    """Redacting wrapper around a secret value (ADR-0022 §D1/§D10).

    ``repr``, ``str``, dataclass conversion, and pickle-by-default MUST NOT
    reveal the wrapped value -- only :meth:`reveal` does.
    """

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        """Explicit, auditable access to the underlying secret."""
        return self._value

    def __repr__(self) -> str:
        return "RedactedSecret('[REDACTED]')"

    def __str__(self) -> str:
        return "[REDACTED]"

    def __reduce__(self) -> tuple[Any, ...]:
        # Prevent naive pickling from round-tripping the raw secret through
        # a log/cache without an explicit reveal() call.
        return (RedactedSecret, ("[REDACTED]",))

    def __eq__(self, other: object) -> bool:
        return isinstance(other, RedactedSecret) and self._value == other._value

    def __hash__(self) -> int:
        return hash(("RedactedSecret", self._value))


@dataclass(frozen=True)
class Credential:
    """A credential acquired from a :class:`CredentialProvider`."""

    scheme: str
    secret: RedactedSecret
    audience: str
    source: str
    authority: CredentialAuthority
    expires_at: str | None = None
    granted_scopes: list[str] | None = None


@runtime_checkable
class CredentialProvider(Protocol):
    """Product clients accept a credential provider, not an untyped reusable
    header map (ADR-0022 §D1). No HTTP implementation ships in this pass.
    """

    async def describe_authority(
        self, request: CredentialRequest
    ) -> CredentialAuthority: ...

    async def acquire(self, request: CredentialRequest) -> Credential: ...

    def identity(self) -> str:
        """Non-secret stable provider identity, safe to log."""
        ...

    async def invalidate(self, reason: str) -> None: ...


#: Coarse secret-classification tiers used to drive redaction (ADR-0022 §D10).
SecretClassification = Literal["secret", "sensitive", "public"]


@runtime_checkable
class SecretRedactor(Protocol):
    """Applies recursive, schema- and key-name-based redaction to a value
    before it is formatted or handed to a caller telemetry hook
    (ADR-0022 §D10). No concrete implementation ships in this pass --
    lands in issue #54.
    """

    def classify(self, field_name: str, value: Any) -> SecretClassification: ...

    def redact(self, value: Any) -> Any: ...


__all__ = [
    "CredentialRequest",
    "CredentialAuthority",
    "RedactedSecret",
    "Credential",
    "CredentialProvider",
    "SecretClassification",
    "SecretRedactor",
]
