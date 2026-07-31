"""Shared agentic error taxonomy and retry classification (ADR-0023 §D1, §D3).

Type-only scaffolding (issue #52 / M1) -- no network I/O, no retry loop
implementation. Concrete HTTP mapping lands with each product client.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

#: Agentic extension of the ADR-0004 base error kind enumeration
#: (ADR-0023 §D1).
AgenticErrorKind = Literal[
    "configuration",
    "authentication",
    "permission_denied",
    "not_found",
    "validation",
    "conflict",
    "rate_limited",
    "budget_exceeded",
    "safety_blocked",
    "consent_required",
    "unsupported_capability",
    "protocol",
    "integrity",
    "isolation_unavailable",
    "transport",
    "deadline_exceeded",
    "cancelled",
    "process_failed",
    "operation_failed",
    "unknown",
]

#: Operation retry classification (ADR-0023 §D3). A status code alone is
#: never sufficient to decide retry safety.
OperationRetryClass = Literal[
    "safe_read",
    "idempotent_mutation",
    "idempotent_with_key",
    "non_idempotent",
    "streaming",
    "local_process",
]


class AgenticError(Exception):
    """Common failure shape shared by every agentic product (ADR-0023 §D1).

    ``message``, ``details``, and ``cause`` MUST be redacted by the caller
    before this is constructed for exposure -- this base class does not
    perform redaction itself (see :class:`cognitum.agentic.credentials.SecretRedactor`).
    """

    def __init__(
        self,
        kind: AgenticErrorKind,
        message: str,
        *,
        product: str | None = None,
        operation: str | None = None,
        status: int | None = None,
        code: str | None = None,
        request_id: str | None = None,
        correlation_id: str | None = None,
        protocol_version: str | None = None,
        retryable: bool = False,
        retry_after_ms: int | None = None,
        attempt_count: int | None = None,
        details: Any = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.product = product
        self.operation = operation
        self.status = status
        self.code = code
        self.request_id = request_id
        self.correlation_id = correlation_id
        self.protocol_version = protocol_version
        self.retryable = retryable
        self.retry_after_ms = retry_after_ms
        self.attempt_count = attempt_count
        self.details = details
        if cause is not None:
            self.__cause__ = cause

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}(kind={self.kind!r}, "
            f"message={self.message!r}, product={self.product!r}, "
            f"status={self.status!r}, retryable={self.retryable!r})"
        )


class UnsupportedCapabilityError(AgenticError):
    """Fail-closed error for an absent or unknown capability (ADR-0019 §D6).

    MUST be raised before any spend, mutation, consent, or code-execution
    side effect.
    """

    def __init__(
        self,
        product: str,
        operation: str,
        capability: str,
        message: str | None = None,
    ) -> None:
        super().__init__(
            "unsupported_capability",
            message
            or (
                f'capability "{capability}" is unsupported or unknown for '
                f"{product}/{operation}"
            ),
            product=product,
            operation=operation,
            retryable=False,
        )
        self.capability = capability


class PermissionDeniedError(AgenticError):
    """Fail-closed error for an ADR-0022 §D5 scope preflight failure.

    Raised when a credential's KNOWN granted scopes do not include the
    scope an operation requires. "Before a billable or mutating call, a
    provider with known granted scopes is checked locally. Missing scope
    returns ``PermissionDeniedError`` before I/O." Never raised when
    ``granted_scopes`` is absent/unknown -- an unknown scope set is sent
    once and left to the server (§D5).
    """

    def __init__(
        self,
        product: str,
        operation: str,
        required_scope: str,
        granted_scopes: list[str],
        message: str | None = None,
    ) -> None:
        joined = ", ".join(granted_scopes) if granted_scopes else "none"
        super().__init__(
            "permission_denied",
            message
            or (
                f'operation "{operation}" on {product} requires scope '
                f'"{required_scope}", but the credential\'s known granted '
                f"scopes ({joined}) do not include it "
                "(ADR-0022 §D5 scope preflight)"
            ),
            product=product,
            operation=operation,
            retryable=False,
        )
        self.required_scope = required_scope
        self.granted_scopes = granted_scopes


#: ADR-0022 §D7 consent grant kinds. A locally recorded ``ConsentGrant``
#: names exactly one of these -- never a generic boolean -- so consent for
#: one kind never implies another ("Consent for sponsored inference does
#: not imply cloud fallback or training contribution").
ConsentGrantKind = Literal[
    "sponsored_inference",
    "power_saver_routing",
    "cloud_fallback",
    "source_upload",
    "artifact_retention",
    "training_data_contribution",
    "external_webhook_delivery",
]


@dataclass(frozen=True)
class ConsentGrant:
    """A narrow, locally-recorded (or signed) consent grant (ADR-0022 §D7).

    The grant must match product, origin, subject, and action before it
    satisfies a gated call -- the SDK never infers consent from credential
    presence, a prior operation on another origin, environment variables, or
    a retry policy.

    Type-only scaffolding: this class does not verify signatures or attest
    server-persisted grants (§D7's "consequential kind" re-check
    requirement) -- it only defines the shape and the presence/expiry check
    that product clients (starting with ``MetaProxyClient``, ADR-0025a §D9)
    apply before a gated call.
    """

    kind: ConsentGrantKind
    product: str
    origin: str
    subject: str
    scope: str
    issued_at: str
    #: ``None`` means the grant does not expire.
    expires_at: str | None = None
    #: Present when the grant is signed or attested by the issuing service.
    #: §D7: consequential kinds (``sponsored_inference``,
    #: ``training_data_contribution``, ``source_upload``,
    #: ``artifact_retention``, ``external_webhook_delivery``) require this;
    #: the low-stakes kinds (``power_saver_routing``, ``cloud_fallback``) may
    #: be an unsigned local record without one.
    evidence_id: str | None = None


class ConsentRequiredError(AgenticError):
    """Fail-closed error raised when a gated operation requires an
    ADR-0022 §D7 consent grant that is absent, expired, or does not match
    the call (product/origin/subject/action).

    Credential presence is never a substitute for consent (§D7/ADR-0025a
    §D9): "Headless clients return ``ConsentRequiredError`` rather than
    prompt." Carries a machine-readable ``required_kind`` per §D7 ("Headless
    SDKs return ``ConsentRequiredError`` with a machine-readable required
    kind").
    """

    def __init__(
        self,
        product: str,
        operation: str,
        required_kind: ConsentGrantKind,
        message: str | None = None,
    ) -> None:
        super().__init__(
            "consent_required",
            message
            or (
                f'operation "{operation}" on {product} requires an unexpired ADR-0022 '
                f'consent grant of kind "{required_kind}" -- credential presence alone '
                "is not consent"
            ),
            product=product,
            operation=operation,
            retryable=False,
        )
        self.required_kind = required_kind


@dataclass(frozen=True)
class RetryPolicy:
    """Retry-policy shape (ADR-0023 §D4).

    Values MUST match ADR-0005's equal-jitter formula verbatim; agentic
    modules MUST NOT diverge from it.
    """

    base_ms: int = 500
    cap_ms: int = 30_000
    max_attempts: int = 4
    retry_sleep_budget_ms: int = 60_000


#: Canonical default retry policy (500 ms base, 30 s cap, 4 attempts, 60 s budget).
DEFAULT_RETRY_POLICY = RetryPolicy()


def equal_jitter_delay_ms(
    attempt: int,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    server_hint_ms: int = 0,
    jitter_ms: int = 0,
) -> int:
    """Pure equal-jitter backoff calculation, ADR-0005/ADR-0023 verbatim::

        delay_ms(attempt) = min(cap_ms, max(server_hint_ms, base_ms * 2**attempt + jitter))

    ``jitter_ms`` is caller-injected (rather than internally randomized) so
    cross-language conformance fixtures can assert exact values with a fixed
    seed, per ADR-0023's compliance note on injected clocks/randomness.
    """
    expo = policy.base_ms * (2**attempt)
    clamped_jitter = min(max(jitter_ms, 0), policy.base_ms)
    computed = expo + clamped_jitter
    floor = max(server_hint_ms, computed)
    return min(policy.cap_ms, floor)


@dataclass(frozen=True)
class IdempotencyBindingV1:
    """Idempotency-key binding contract (ADR-0023 §D5)."""

    authenticated_principal: str
    http_method: str
    normalized_route_identity: str
    canonical_request_sha256: str
    idempotency_key: str
    contract_major: int
    tenant_context: str | None = None
    delegated_subtenant_context: str | None = None


#: Why a cancellation token was cancelled (ADR-0023 §D7).
CancellationReason = Literal["caller", "deadline", "shutdown"]


class CancellationToken:
    """Transport-neutral cancellation contract.

    Distinct from "cancel remote operation" and "terminate local process" --
    see :class:`cognitum.agentic.operations.OperationHandle`. This base
    implementation is never-cancelled; concrete tokens override
    ``is_cancelled``/``reason``.
    """

    @property
    def is_cancelled(self) -> bool:
        return False

    @property
    def reason(self) -> CancellationReason | None:
        return None


@dataclass(frozen=True)
class TimeBudget:
    """Time-budget model (ADR-0023 §D8).

    Timeouts are separate values -- never one shared 30s default for
    streaming, inference, and long-running operations.
    """

    connect_timeout_ms: int | None = None
    first_byte_timeout_ms: int | None = None
    idle_timeout_ms: int | None = None
    request_deadline_ms: int | None = None
    wait_deadline_ms: int | None = None
    cancel_grace_ms: int | None = None
    retry_sleep_budget_ms: int | None = None


__all__ = [
    "AgenticErrorKind",
    "OperationRetryClass",
    "AgenticError",
    "UnsupportedCapabilityError",
    "PermissionDeniedError",
    "ConsentGrantKind",
    "ConsentGrant",
    "ConsentRequiredError",
    "RetryPolicy",
    "DEFAULT_RETRY_POLICY",
    "equal_jitter_delay_ms",
    "IdempotencyBindingV1",
    "CancellationReason",
    "CancellationToken",
    "TimeBudget",
]
