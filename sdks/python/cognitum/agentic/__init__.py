"""Shared agentic-platform contract shapes (ADR-0019 §D5).

This package is the SMALL shared surface used by the four bounded-context
clients (Meta LLM, Meta Proxy, MetaHarness, HarnessaaS). Per ADR-0019 §D4,
those product modules depend on ``cognitum.agentic``; this package MUST NOT
import any product module (``cognitum.meta_llm``, ``cognitum.meta_proxy``,
``cognitum.metaharness``, ``cognitum.harnessaas``).

Most of this package is **type-only scaffolding** (issue #52 / M1): there is
still no network I/O, retry loop, or product routing/consent/scaffold
logic -- those remain product-specific per §D5.
``StaticApiKeyCredentialProvider`` (issue #53) is the first concrete
implementation landing on top of this contract; secret-redaction (#54) and
receipt/lineage verification (#56) remain follow-up issues.

Sources:

- docs/adr/0019-agentic-platform-bounded-contexts.md (D2, D3, D5, D6)
- docs/adr/0022-agentic-auth-tenant-budget-secret-and-consent-isolation.md (D1, D6, D10)
- docs/adr/0023-agentic-errors-retries-idempotency-cancellation-and-time-budgets.md (D1, D3-D9)
- docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md (D7-D9)
- docs/adr/0005-cross-cutting-retry-backoff.md (equal-jitter formula)

This package is imported eagerly by callers of ``cognitum.agentic`` but is
NOT imported by ``cognitum/__init__.py`` itself, preserving the cold-start
import graph fix from issue #20 -- cloud-only and seed-only callers never
pay for this module's (small) import cost.
"""

from __future__ import annotations

from cognitum.agentic.capability import CapabilitySet, CapabilitySource
from cognitum.agentic.context import (
    BudgetPolicy,
    OnUnknownEstimate,
    RequestContext,
    TenantContext,
)
from cognitum.agentic.credentials import (
    Credential,
    CredentialAuthority,
    CredentialProvider,
    CredentialRequest,
    RedactedSecret,
    SecretClassification,
    SecretRedactor,
)
from cognitum.agentic.errors import (
    DEFAULT_RETRY_POLICY,
    AgenticError,
    AgenticErrorKind,
    CancellationReason,
    CancellationToken,
    IdempotencyBindingV1,
    OperationRetryClass,
    RetryPolicy,
    TimeBudget,
    UnsupportedCapabilityError,
    equal_jitter_delay_ms,
)
from cognitum.agentic.operations import (
    EventStreamOptions,
    OperationEvent,
    OperationHandle,
    OperationSnapshot,
    OperationState,
    Page,
    PageRequest,
    WaitOptions,
)
from cognitum.agentic.receipts import (
    CostFinality,
    CostObservation,
    ExecutionReceipt,
    LineageReference,
    LineageSubject,
    ReceiptSubject,
    VerificationLevel,
    VerificationResult,
)
from cognitum.agentic.static_api_key_provider import (
    DEFAULT_API_KEY_ENV_VAR,
    StaticApiKeyCredentialProvider,
)
from cognitum.agentic.sentinel import D12Category, SentinelSecretRedactor

__all__ = [
    # Capability negotiation
    "CapabilitySet",
    "CapabilitySource",
    # Errors / retry classification
    "AgenticError",
    "AgenticErrorKind",
    "UnsupportedCapabilityError",
    "OperationRetryClass",
    "RetryPolicy",
    "DEFAULT_RETRY_POLICY",
    "equal_jitter_delay_ms",
    "IdempotencyBindingV1",
    "CancellationReason",
    "CancellationToken",
    "TimeBudget",
    # Request context / budget
    "RequestContext",
    "TenantContext",
    "BudgetPolicy",
    "OnUnknownEstimate",
    # Credential provider / secret redaction
    "CredentialRequest",
    "CredentialAuthority",
    "Credential",
    "CredentialProvider",
    "RedactedSecret",
    "SecretClassification",
    "SecretRedactor",
    "D12Category",
    "SentinelSecretRedactor",
    # Operations / pagination
    "OperationState",
    "OperationSnapshot",
    "OperationHandle",
    "WaitOptions",
    "EventStreamOptions",
    "OperationEvent",
    "PageRequest",
    "Page",
    # Receipts / lineage (ADR-0028, issue #56 builds these out further)
    "VerificationLevel",
    "VerificationResult",
    "CostFinality",
    "CostObservation",
    "ReceiptSubject",
    "ExecutionReceipt",
    "LineageSubject",
    "LineageReference",
    # Concrete credential provider (issue #53)
    "StaticApiKeyCredentialProvider",
    "DEFAULT_API_KEY_ENV_VAR",
]
