//! Idempotency-key generation and `IdempotencyBindingV1` construction
//! (ADR-0024a §D7, ADR-0023 §D5) for the two "direct nonstream call[s]
//! whose accepted contract declares safe replay" this pass lands:
//! `chat.completions` and `messages.create`. See `./nonstream.rs` for the
//! retry loop that actually sends these.
//!
//! This is the exact ADR-0023 §D5 `IdempotencyBindingV1` type and binding
//! shape (re-exported from `crate::agentic`), not a Meta LLM-specific
//! approximation (ADR-0024a §D7).

use crate::agentic::{canonical_json, sha256_hex, Credential, IdempotencyBindingV1, TenantContext};

/// Contract major for the nonstream serving surface this pass lands
/// (ADR-0023 §D5 `contract_major`). Bump only alongside a documented
/// breaking change to one of these two operations' request/response wire
/// shape.
pub(super) const CONTRACT_MAJOR: u32 = 1;

/// `sha256_hex(canonical_json(body))`, reusing the same
/// `cognitum-canonical-json-v1` scheme as `agentic::receipt_verification`
/// (recursively sorted object keys, JS-compatible number formatting)
/// rather than a separate RFC 8785 implementation of ADR-0023 §D5's
/// canonicalization paragraph. This pass's per-language conformance does
/// not require cross-language byte-identical digests (that lands with the
/// ADR-0024a §D9 GA gates) — only a digest that is stable within one
/// client for one logical call, so a retry reuses the same key/body pair
/// and a changed body is detectable.
pub(super) fn canonical_request_sha256(body: &serde_json::Value) -> String {
    sha256_hex(&canonical_json(body))
}

/// Build the exact ADR-0023 §D5 binding for one logical nonstream call.
///
/// `authenticated_principal` falls back to the credential's non-secret
/// provider fingerprint when the provider does not populate
/// `CredentialAuthority.principal` — the binding's principal field is
/// required (not optional), and the fingerprint is still a stable,
/// non-secret per-credential-identity value suitable for that role.
pub(super) fn build_idempotency_binding(
    operation: &str,
    path: &str,
    credential: &Credential,
    tenant: Option<&TenantContext>,
    canonical_request_sha256: String,
    idempotency_key: String,
) -> IdempotencyBindingV1 {
    let authenticated_principal = credential
        .authority
        .principal
        .clone()
        .unwrap_or_else(|| credential.authority.provider_fingerprint.clone());
    let tenant_context = tenant
        .and_then(|t| t.tenant_id.clone())
        .or_else(|| credential.authority.tenant.clone());
    let delegated_subtenant_context = tenant
        .and_then(|t| t.delegated_subtenant_id.clone())
        .or_else(|| credential.authority.delegated_subtenant.clone());
    IdempotencyBindingV1 {
        authenticated_principal,
        tenant_context,
        delegated_subtenant_context,
        http_method: "POST".to_owned(),
        // ADR-0023 §D5: "the contract operation ID plus normalized path
        // parameters [...] canonically sorted, percent-encoded query
        // pairs". Neither route has path parameters or a query string, so
        // this reduces to exactly `"{operation} {path}"`.
        normalized_route_identity: format!("{operation} {path}"),
        canonical_request_sha256,
        idempotency_key,
        contract_major: CONTRACT_MAJOR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::CredentialAuthority;

    fn credential(principal: Option<&str>) -> Credential {
        Credential {
            scheme: "X-API-Key".to_owned(),
            secret: crate::agentic::RedactedSecret::new("sk-test"),
            expires_at: None,
            granted_scopes: None,
            audience: "https://meta-llm.test".to_owned(),
            source: "test".to_owned(),
            authority: CredentialAuthority {
                provider_fingerprint: "fp-1234".to_owned(),
                product: "meta-llm".to_owned(),
                normalized_origin: "https://meta-llm.test".to_owned(),
                audience: "https://meta-llm.test".to_owned(),
                principal: principal.map(str::to_owned),
                tenant: None,
                delegated_subtenant: None,
                effective_scopes: None,
                plan: None,
            },
        }
    }

    #[test]
    fn canonical_request_sha256_is_stable_for_the_same_body() {
        let body = serde_json::json!({"model": "m", "messages": []});
        assert_eq!(
            canonical_request_sha256(&body),
            canonical_request_sha256(&body)
        );
    }

    #[test]
    fn canonical_request_sha256_differs_for_a_changed_body() {
        let a = serde_json::json!({"model": "m", "n": 1});
        let b = serde_json::json!({"model": "m", "n": 2});
        assert_ne!(canonical_request_sha256(&a), canonical_request_sha256(&b));
    }

    #[test]
    fn build_idempotency_binding_falls_back_to_provider_fingerprint() {
        let cred = credential(None);
        let binding = build_idempotency_binding(
            "chat.completions",
            "/v1/chat/completions",
            &cred,
            None,
            "deadbeef".to_owned(),
            "key-1".to_owned(),
        );
        assert_eq!(binding.authenticated_principal, "fp-1234");
        assert_eq!(binding.http_method, "POST");
        assert_eq!(
            binding.normalized_route_identity,
            "chat.completions /v1/chat/completions"
        );
        assert_eq!(binding.contract_major, CONTRACT_MAJOR);
    }

    #[test]
    fn build_idempotency_binding_prefers_explicit_principal() {
        let cred = credential(Some("acct_42"));
        let binding = build_idempotency_binding(
            "messages.create",
            "/v1/messages",
            &cred,
            None,
            "deadbeef".to_owned(),
            "key-1".to_owned(),
        );
        assert_eq!(binding.authenticated_principal, "acct_42");
    }
}
