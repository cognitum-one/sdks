"""Canonical 12-variant exception taxonomy (ADR-0004 + ADR-0013b §4).

This module is the single source of truth. ``cognitum.errors`` re-exports these
for backward compatibility with 0.1.x callers.
"""

from __future__ import annotations

from enum import Enum
from typing import Literal


class AuthReason(str, Enum):
    """Wire-form values MUST match all three SDKs (ADR-0004 §Canonical names)."""

    NO_CREDENTIALS = "no_credentials"
    INVALID_CREDENTIALS = "invalid_credentials"
    NOT_PAIRED = "not_paired"
    PAIRING_WINDOW_CLOSED = "pairing_window_closed"
    LOCKDOWN_MTLS_REQUIRED = "lockdown_mtls_required"
    TRUST_SCORE_BLOCKED = "trust_score_blocked"

    # Back-compat aliases tolerated during the 0.2.x series — the PascalCase
    # names in ADR-0013a §2.3 appear in docstrings and examples.
    @classmethod
    def _missing_(cls, value: object) -> AuthReason | None:  # pragma: no cover
        if isinstance(value, str):
            low = value.lower()
            for member in cls:
                if member.value == low:
                    return member
        return None


TimeoutPhase = Literal["connect", "read", "total"]


class CognitumError(Exception):
    """Base of the taxonomy. Always inspectable."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        request_id: str | None = None,
        retriable: bool = False,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.request_id = request_id
        self.retriable = retriable
        self.raw_body = raw_body
        self.correlation_id = correlation_id
        if cause is not None:
            self.__cause__ = cause

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}("
            f"message={self.message!r}, status_code={self.status_code!r}, "
            f"correlation_id={self.correlation_id!r})"
        )


class AuthError(CognitumError):
    """401/403 — caller must re-authenticate or re-pair."""

    def __init__(
        self,
        message: str = "Authentication failed",
        *,
        reason: AuthReason = AuthReason.INVALID_CREDENTIALS,
        status_code: int | None = None,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(
            message,
            code="auth_error",
            status_code=status_code,
            request_id=request_id,
            retriable=False,
            raw_body=raw_body,
            correlation_id=correlation_id,
            cause=cause,
        )
        self.reason = reason


class TrustScoreBlockedError(AuthError):
    """Per-peer client-side abort after 3 consecutive 401/403 responses.

    ADR-0007 §Trust-score protection requires SDKs to stop before the
    seed's own 3-strike counter bans the caller's IP for 5 minutes. The
    counter lives on the transport instance keyed by peer URL (issue #16
    / audit finding P-D1); reaching 3 raises this hard-abort exception.

    Never retriable; mesh failover MUST NOT cycle to the next peer on it
    (it's an SDK-side policy violation signal, not a per-peer transport
    failure).
    """

    def __init__(
        self,
        message: str = "trust-score blocked: 3 consecutive auth failures",
        *,
        peer_url: str,
        status_code: int | None = None,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(
            message,
            reason=AuthReason.TRUST_SCORE_BLOCKED,
            status_code=status_code,
            request_id=request_id,
            raw_body=raw_body,
            correlation_id=correlation_id,
            cause=cause,
        )
        # AuthError sets retriable=False and code="auth_error"; override
        # the code so callers can distinguish on the wire marker without
        # matching the class tree.
        self.code = "trust_score_blocked"
        self.peer_url = peer_url


class RateLimitError(CognitumError):
    """429 — honours Retry-After / retry_after_us / english-language hints."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        *,
        retry_after_ms: int = 1000,
        retry_after_seconds: float | None = None,
        tier: Literal["unpaired", "paired", "localhost", "lockdown"] = "unpaired",
        status_code: int | None = 429,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="rate_limited",
            status_code=status_code,
            request_id=request_id,
            retriable=True,
            raw_body=raw_body,
            correlation_id=correlation_id,
        )
        # Allow seconds input for 0.1.x callers while normalising to ms.
        if retry_after_seconds is not None:
            retry_after_ms = int(retry_after_seconds * 1000)
        self.retry_after_ms = retry_after_ms
        self.tier = tier
        self.retry_after_seconds: float = retry_after_ms / 1000.0


class ValidationError(CognitumError):
    """400/405/422 — client-side issue."""

    def __init__(
        self,
        message: str = "Validation error",
        *,
        field: str | None = None,
        status_code: int | None = None,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="validation_error",
            status_code=status_code,
            request_id=request_id,
            retriable=False,
            raw_body=raw_body,
            correlation_id=correlation_id,
        )
        self.field = field


class NotFoundError(CognitumError):
    """404 — unknown endpoint or missing resource."""

    def __init__(
        self,
        message: str = "Not found",
        *,
        resource: str | None = None,
        status_code: int | None = 404,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="not_found",
            status_code=status_code,
            request_id=request_id,
            retriable=False,
            raw_body=raw_body,
            correlation_id=correlation_id,
        )
        self.resource = resource


class NotImplementedError(CognitumError):  # noqa: A001 — intentional shadow of builtin
    """501 — SDK shim for seed SSE placeholder endpoints.

    Distinct from :class:`builtins.NotImplementedError` by inheritance. Callers
    who need to distinguish them should use ``isinstance(exc, CognitumError)``.
    """

    def __init__(
        self,
        message: str = "Not implemented by this seed firmware",
        *,
        endpoint: str = "",
        status_code: int | None = 501,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="not_implemented",
            status_code=status_code,
            retriable=False,
            correlation_id=correlation_id,
        )
        self.endpoint = endpoint


class ConflictError(CognitumError):
    """409 — reserved for cloud ``POST /orders`` first producer (ADR-0004)."""

    def __init__(
        self,
        message: str = "Conflict",
        *,
        status_code: int | None = 409,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="conflict",
            status_code=status_code,
            request_id=request_id,
            retriable=False,
            raw_body=raw_body,
            correlation_id=correlation_id,
        )


class ServiceUnavailableError(CognitumError):
    """503 — lockdown / restart in progress; retriable per ADR-0005."""

    def __init__(
        self,
        message: str = "Service unavailable",
        *,
        retry_after_ms: int | None = None,
        status_code: int | None = 503,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="service_unavailable",
            status_code=status_code,
            request_id=request_id,
            retriable=True,
            raw_body=raw_body,
            correlation_id=correlation_id,
        )
        self.retry_after_ms = retry_after_ms


class ApiError(CognitumError):
    """Generic catch-all for other 5xx / unknown 4xx."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: str | None = None,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code=code or f"http_{status_code}",
            status_code=status_code,
            request_id=request_id,
            retriable=status_code >= 500,
            raw_body=raw_body,
            correlation_id=correlation_id,
        )


class NetworkError(CognitumError):
    """TCP/TLS/DNS failure. Always retriable per ADR-0005."""

    def __init__(
        self,
        message: str = "Transport error",
        *,
        cause: BaseException | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="network_error",
            retriable=True,
            correlation_id=correlation_id,
            cause=cause,
        )


class TimeoutError(CognitumError):  # noqa: A001 — intentional shadow of builtin
    """Per-request timeout. Connect-phase retriable, read-phase case-by-case."""

    def __init__(
        self,
        message: str = "Request timed out",
        *,
        phase: TimeoutPhase = "total",
        correlation_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        retriable = phase == "connect"
        super().__init__(
            message,
            code="timeout",
            retriable=retriable,
            correlation_id=correlation_id,
            cause=cause,
        )
        self.phase = phase


class ParseError(CognitumError):
    """JSON parse / schema mismatch. Never retriable."""

    def __init__(
        self,
        message: str,
        *,
        expected: str = "json",
        got: str = "",
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="parse_error",
            retriable=False,
            raw_body=raw_body,
            correlation_id=correlation_id,
        )
        self.expected = expected
        self.got = got


class ConfigError(ValidationError):
    """Raised at construction when the SDK is mis-configured (ADR-0007).

    Subclasses :class:`ValidationError` so callers that catch validation
    errors at construction continue to work; adds a dedicated class for the
    "mesh mode not yet supported" case called out in ADR-0016.
    """

    def __init__(
        self,
        message: str = "Invalid SDK configuration",
        *,
        field: str | None = None,
    ) -> None:
        super().__init__(message, field=field)
        self.code = "config_error"


class UnsupportedError(CognitumError):
    """Requested feature is not implementable against this backend (ADR-0016b).

    Distinct from :class:`NotImplementedError` (a 501 from the seed) — this
    is raised by the SDK itself when the caller asks for a capability the
    seed protocol does not offer, e.g. ``consistency="strong"``.
    """

    def __init__(
        self,
        message: str = "Feature unsupported by this backend",
        *,
        feature: str | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code="unsupported",
            retriable=False,
            correlation_id=correlation_id,
        )
        self.feature = feature


__all__ = [
    "ApiError",
    "AuthError",
    "AuthReason",
    "CognitumError",
    "ConfigError",
    "ConflictError",
    "NetworkError",
    "NotFoundError",
    "NotImplementedError",
    "ParseError",
    "RateLimitError",
    "ServiceUnavailableError",
    "TimeoutError",
    "TimeoutPhase",
    "TrustScoreBlockedError",
    "UnsupportedError",
    "ValidationError",
]
