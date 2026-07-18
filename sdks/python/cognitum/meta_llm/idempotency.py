"""Idempotency-key generation and ``IdempotencyBindingV1`` construction
(ADR-0024a §D7, ADR-0023 §D5) for the two "direct nonstream call[s] whose
accepted contract declares safe replay" this pass lands: ``chat.completions``
and ``messages.create``. See ``nonstream.py`` for the retry loop that
actually sends these.

This is the exact ADR-0023 §D5 ``IdempotencyBindingV1`` type and binding
shape (re-exported from ``cognitum.agentic``), not a Meta LLM-specific
approximation (ADR-0024a §D7).
"""

from __future__ import annotations

from typing import Any

from cognitum.agentic import (
    Credential,
    IdempotencyBindingV1,
    TenantContext,
    canonical_json,
    sha256_hex,
)

#: Contract major for the nonstream serving surface this pass lands
#: (ADR-0023 §D5 ``contract_major``). Bump only alongside a documented
#: breaking change to one of these two operations' request/response wire
#: shape.
CONTRACT_MAJOR = 1


def canonical_request_sha256(body: Any) -> str:
    """``sha256_hex(canonical_json(body))``.

    Reuses the same ``cognitum-canonical-json-v1`` scheme as
    ``cognitum.agentic.receipt_verification`` (recursively sorted object
    keys, no whitespace) rather than a separate RFC 8785 implementation of
    ADR-0023 §D5's canonicalization paragraph. This pass's per-language
    conformance does not require cross-language byte-identical digests
    (that lands with the ADR-0024a §D9 GA gates) -- only a digest that is
    stable within one client for one logical call, so a retry reuses the
    same key/body pair and a changed body is detectable.
    """
    return sha256_hex(canonical_json(body))


def build_idempotency_binding(
    operation: str,
    path: str,
    credential: Credential,
    tenant: TenantContext | None,
    canonical_request_sha256_value: str,
    idempotency_key: str,
) -> IdempotencyBindingV1:
    """Build the exact ADR-0023 §D5 binding for one logical nonstream call.

    ``authenticated_principal`` falls back to the credential's non-secret
    provider fingerprint when the provider does not populate
    ``CredentialAuthority.principal`` -- the binding's principal field is
    required (not optional), and the fingerprint is still a stable,
    non-secret per-credential-identity value suitable for that role.
    """
    authenticated_principal = (
        credential.authority.principal or credential.authority.provider_fingerprint
    )
    tenant_context = (tenant.tenant_id if tenant else None) or credential.authority.tenant
    delegated_subtenant_context = (
        tenant.delegated_subtenant_id if tenant else None
    ) or credential.authority.delegated_subtenant
    return IdempotencyBindingV1(
        authenticated_principal=authenticated_principal,
        tenant_context=tenant_context,
        delegated_subtenant_context=delegated_subtenant_context,
        http_method="POST",
        # ADR-0023 §D5: "the contract operation ID plus normalized path
        # parameters [...] canonically sorted, percent-encoded query
        # pairs". Neither route has path parameters or a query string, so
        # this reduces to exactly ``"{operation} {path}"``.
        normalized_route_identity=f"{operation} {path}",
        canonical_request_sha256=canonical_request_sha256_value,
        idempotency_key=idempotency_key,
        contract_major=CONTRACT_MAJOR,
    )


__all__ = ["CONTRACT_MAJOR", "canonical_request_sha256", "build_idempotency_binding"]
