//! Internal HTTP glue for [`super::client::MetaLlmClient`]'s `health()`,
//! `whoami()`, and `models()` — credential acquisition, auth header
//! placement, JSON parsing, and HTTP-status-to-`AgenticError` mapping
//! (ADR-0024a §D1, §D6, §D8).
//!
//! Split out of `client.rs` to keep that file focused on the public
//! operation surface; nothing here is part of the public API (this module
//! is private — see `super`'s `mod http;`).

use std::collections::HashMap;
use std::time::Instant;

use serde_json::Value;
use uuid::Uuid;

use crate::agentic::{
    assert_scope_granted, AgenticError, AgenticErrorKind, Credential, CredentialRequest,
};

use super::client::MetaLlmClient;
use super::config::MetaLlmTelemetryEvent;
use super::envelope::MetaLlmResponseMeta;
use super::PRODUCT;

/// Generic fail-closed `unsupported_capability` error, product/operation-scoped.
/// Still used by `ready()` (ADR-0024a §D1: "when published" — no readiness
/// endpoint is published yet). The five protocol operations all have real
/// HTTP call logic now (`chat_completions`/`messages_create` in PR #86;
/// `completions`/`responses`/`embeddings`/`messages_count_tokens` this
/// pass), so the sibling `not_implemented()` placeholder helper that used
/// to wrap this for them was removed.
pub(super) fn unsupported(operation: &str, message: impl Into<String>) -> AgenticError {
    AgenticError::new(AgenticErrorKind::UnsupportedCapability, message.into())
        .with_product_operation(PRODUCT, operation)
}

/// Best-effort JSON object view, tolerant of a non-object body (returns empty).
pub(super) fn as_object(value: &Value) -> HashMap<String, Value> {
    value
        .as_object()
        .map(|m| m.clone().into_iter().collect())
        .unwrap_or_default()
}

/// Remove and return `key` as a `String` if present and string-typed;
/// otherwise leaves the map untouched (including re-inserting a
/// non-string value it had to remove to inspect).
pub(super) fn take_string(map: &mut HashMap<String, Value>, key: &str) -> Option<String> {
    map.remove(key).and_then(|v| match v {
        Value::String(s) => Some(s),
        other => {
            map.insert(key.to_owned(), other);
            None
        }
    })
}

fn non_empty<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() {
        fallback
    } else {
        value
    }
}

// Small local helper trait so error construction can attach
// product/operation without repeating struct-update syntax everywhere.
trait WithProductOperation {
    fn with_product_operation(self, product: &str, operation: &str) -> Self;
}

impl WithProductOperation for AgenticError {
    fn with_product_operation(mut self, product: &str, operation: &str) -> Self {
        self.product = Some(product.to_owned());
        self.operation = Some(operation.to_owned());
        self
    }
}

trait AgenticErrorBuilderExt {
    fn with_retryable(self, retryable: bool) -> Self;
    fn with_request_id(self, request_id: &str) -> Self;
    fn with_status(self, status: u16) -> Self;
}

impl AgenticErrorBuilderExt for AgenticError {
    fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    fn with_request_id(mut self, request_id: &str) -> Self {
        self.request_id = Some(request_id.to_owned());
        self
    }

    fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

}

/// `Retry-After` from a response, per RFC 9110 (both legal forms).
///
/// Previously this product never read the header at all: `map_http_error`
/// took only the body, so `retry_after_ms` was always `None` and the retry
/// loop's `unwrap_or(0)` silently discarded the server's backoff request --
/// this SDK retried a rate-limited gateway sooner than Node or Python did.
/// Found by the cross-language conformance corpus (issue #75).
pub(super) fn retry_after_ms_of(response: &reqwest::Response) -> Option<u64> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    crate::agentic::parse_retry_after_ms(
        response.headers().get("retry-after").and_then(|v| v.to_str().ok()),
        now_ms,
    )
}

impl MetaLlmClient {
    pub(super) async fn resolve_credential(
        &self,
        operation: &str,
    ) -> Result<Option<Credential>, AgenticError> {
        let Some(provider) = self.config.credential_provider.as_ref() else {
            return Ok(None);
        };
        let request = CredentialRequest {
            product: PRODUCT.to_owned(),
            normalized_origin: self.config.base_url.clone(),
            audience: self.config.base_url.clone(),
            required_scopes: vec!["meta-llm.read".to_owned()],
            operation: operation.to_owned(),
            interactive_allowed: false,
        };
        provider.acquire(&request).await.map(Some)
    }

    pub(super) fn apply_auth(
        &self,
        headers: &mut reqwest::header::HeaderMap,
        credential: &Credential,
    ) {
        // The SDK sends exactly one contracted placement per operation
        // (ADR-0024a §D8). `credential.scheme` is either the literal header
        // name (e.g. `StaticApiKeyCredentialProvider`'s default
        // "X-API-Key") or "bearer", mapped to the standard `Authorization`
        // header.
        let (name, value) = if credential.scheme.eq_ignore_ascii_case("bearer") {
            (
                "Authorization".to_owned(),
                format!("Bearer {}", credential.secret.reveal()),
            )
        } else {
            (
                credential.scheme.clone(),
                credential.secret.reveal().to_owned(),
            )
        };
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    }

    #[allow(clippy::result_large_err)]
    pub(super) async fn get_json(
        &self,
        path: &str,
        operation: &str,
        require_credential: bool,
    ) -> Result<(Value, MetaLlmResponseMeta), AgenticError> {
        let request_id = Uuid::new_v4().to_string();
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_start(operation, &request_id);
        }
        let started_at = Instant::now();

        // ADR-0024a §D1: `health()` is process-level response only — never
        // identity or readiness — so it must not acquire (or attempt to
        // acquire) a credential at all when `require_credential` is false.
        // Only `whoami`/`models` (both `require_credential: true`) touch
        // `credential_provider` here.
        let credential = if require_credential {
            let credential = self.resolve_credential(operation).await.map_err(|mut e| {
                if e.product.is_none() {
                    e.product = Some(PRODUCT.to_owned());
                }
                e
            })?;
            if credential.is_none() {
                return Err(AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!("MetaLlmClient::{operation} requires a credential_provider"),
                )
                .with_product_operation(PRODUCT, operation));
            }
            // ADR-0022 §D5 scope preflight, before any I/O below. Also
            // serves ADR-0024a §D8's "does not assume OAuth platform
            // access": an `OAuthTokenCredentialProvider` whose granted
            // scopes are known and cover only completion-family scopes
            // (e.g. `meta-llm.inference`) is refused here for
            // `usage`/`whoami`/`models` rather than silently sent through
            // — it never reaches "meta-llm.read".
            if let Some(cred) = credential.as_ref() {
                assert_scope_granted(PRODUCT, operation, "meta-llm.read", cred)?;
            }
            credential
        } else {
            None
        };

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&request_id) {
            headers.insert("X-Cognitum-Request-Id", value);
        }
        if let Some(credential) = credential.as_ref() {
            self.apply_auth(&mut headers, credential);
        }

        let url = format!("{}{}", self.config.base_url, path);
        let response = self
            .http
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|cause| {
                AgenticError::new(
                    AgenticErrorKind::Transport,
                    format!("{operation} request failed: {cause}"),
                )
                .with_product_operation(PRODUCT, operation)
                .with_retryable(true)
                .with_request_id(&request_id)
            })?;

        let status = response.status();
        let duration_ms = started_at.elapsed().as_millis() as u64;
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_end(&MetaLlmTelemetryEvent {
                operation: operation.to_owned(),
                request_id: request_id.clone(),
                http_status: Some(status.as_u16()),
                duration_ms: Some(duration_ms),
                retry_after_ms: None,
                idempotent_replay: None,
            });
        }

        let protocol_version = response
            .headers()
            .get("x-cognitum-protocol-version")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let response_request_id = response
            .headers()
            .get("x-cognitum-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .unwrap_or_else(|| request_id.clone());

        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(Self::map_http_error(
                status,
                &body_text,
                operation,
                &response_request_id,
            ));
        }

        let data: Value = response.json().await.map_err(|cause| {
            AgenticError::new(
                AgenticErrorKind::Protocol,
                format!("{operation} response body was not valid JSON: {cause}"),
            )
            .with_product_operation(PRODUCT, operation)
            .with_request_id(&response_request_id)
        })?;

        let meta = MetaLlmResponseMeta {
            request_id: response_request_id,
            http_status: status.as_u16(),
            protocol_version,
            retry_after_ms: None,
            idempotent_replay: None,
            receipt: None,
            warnings: None,
            unknown_headers: None,
        };
        Ok((data, meta))
    }

    /// HTTP-status -> `AgenticErrorKind` mapping (ADR-0024a §D6's full table).
    /// Shared by every operation's error path — GET (`health`/`whoami`/
    /// `models`) and the idempotent-with-key POSTs in `./nonstream.rs`
    /// alike, since none of these statuses are protocol-specific. `pub(super)`
    /// so `./nonstream.rs` (a sibling submodule of `meta_llm`) can reuse it
    /// rather than duplicating the table.
    pub(super) fn map_http_error(
        status: reqwest::StatusCode,
        body_text: &str,
        operation: &str,
        request_id: &str,
    ) -> AgenticError {
        let base = |kind: AgenticErrorKind, message: &str, retryable: bool| {
            AgenticError::new(kind, message.to_owned())
                .with_product_operation(PRODUCT, operation)
                .with_request_id(request_id)
                .with_retryable(retryable)
                .with_status(status.as_u16())
        };

        match status.as_u16() {
            // Never retried (ADR-0024a §D6).
            400 => base(
                AgenticErrorKind::Validation,
                non_empty(body_text, "invalid request"),
                false,
            ),
            401 => base(
                AgenticErrorKind::Authentication,
                non_empty(body_text, "authentication failed"),
                false,
            ),
            403 => base(
                AgenticErrorKind::PermissionDenied,
                non_empty(body_text, "permission denied"),
                false,
            ),
            404 => base(
                AgenticErrorKind::NotFound,
                non_empty(body_text, "not found"),
                false,
            ),
            409 => base(
                AgenticErrorKind::Conflict,
                non_empty(body_text, "state conflict or idempotency mismatch"),
                false,
            ),
            // Two unrelated failures share this status: the caller is out
            // of budget, or the caller never bought the tier they asked for.
            // The remedies point in different directions -- usage vs plan --
            // so collapsing both into `BudgetExceeded` sends half of them to
            // the wrong page. The server's `code` is what separates them.
            402 => {
                let body = crate::agentic::upgrade::parse_error_body(body_text);
                let code = body
                    .as_ref()
                    .and_then(|b| b.get("code"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned);
                if crate::agentic::upgrade::is_upgrade_required(body.as_ref()) {
                    let mut error = base(
                        AgenticErrorKind::UpgradeRequired,
                        non_empty(body_text, "upgrade required"),
                        // Still never retried: only a plan change makes this
                        // succeed, and the `retry_with` hint is for the
                        // caller to decide on, not us.
                        false,
                    );
                    error.code = code;
                    error.upgrade =
                        crate::agentic::upgrade::parse_upgrade_affordance(body.as_ref());
                    error
                } else {
                    let mut error = base(
                        AgenticErrorKind::BudgetExceeded,
                        non_empty(body_text, "budget or upgrade required"),
                        false,
                    );
                    error.code = code;
                    error
                }
            }
            422 => base(
                AgenticErrorKind::SafetyBlocked,
                non_empty(body_text, "safety or semantic validation failed"),
                false,
            ),
            // Bounded retry only when the caller proves replay safety (an
            // idempotent-with-key operation) — the retry loop in
            // `./nonstream.rs` is what actually gates this; `retryable: true`
            // here only reflects the status's own classification.
            429 => base(
                AgenticErrorKind::RateLimited,
                non_empty(body_text, "rate limited"),
                true,
            ),
            502 | 503 => base(
                AgenticErrorKind::Transport,
                non_empty(body_text, &format!("upstream error {status}")),
                true,
            ),
            _ => base(
                AgenticErrorKind::Protocol,
                non_empty(body_text, &format!("unexpected status {status}")),
                false,
            ),
        }
    }
}

#[cfg(test)]
mod upgrade_required_tests {
    //! Issue #128 / ADR-0023 §D1. These live in-crate because
    //! `map_http_error` is `pub(super)` -- the kind mapping is the whole
    //! point of the issue, and an integration test cannot reach it.
    use super::*;
    use crate::agentic::AgenticErrorKind;

    /// Verbatim body from https://api.cognitum.one on 2026-07-31, when a key
    /// holding `completions:low` requested `cognitum-high`.
    const LIVE_TIER_SHORTFALL_BODY: &str = r#"{"error":"Model 'cognitum-high' requires the completions:high scope, which this API key does not hold.","code":"upgrade_required","required_tier":"high","held_tier":"low","required_scope":"completions:high","upgrade_url":"https://dashboard.cognitum.one/settings/billing"}"#;

    fn map(status: u16, body: &str) -> AgenticError {
        MetaLlmClient::map_http_error(
            reqwest::StatusCode::from_u16(status).unwrap(),
            body,
            "chatCompletions",
            "req-1",
        )
    }

    #[test]
    fn live_tier_shortfall_maps_to_upgrade_required_not_budget_exceeded() {
        let error = map(402, LIVE_TIER_SHORTFALL_BODY);

        assert_eq!(error.kind, AgenticErrorKind::UpgradeRequired);
        assert_eq!(error.status, Some(402));
        assert_eq!(error.code.as_deref(), Some("upgrade_required"));
    }

    #[test]
    fn affordance_is_attached_to_the_error() {
        let error = map(402, LIVE_TIER_SHORTFALL_BODY);
        let upgrade = error.upgrade.expect("affordance present");

        assert_eq!(upgrade.required_tier.as_deref(), Some("high"));
        assert_eq!(upgrade.held_tier.as_deref(), Some("low"));
    }

    #[test]
    fn upgrade_required_stays_non_retryable() {
        assert!(!map(402, LIVE_TIER_SHORTFALL_BODY).retryable);
    }

    #[test]
    fn budget_402_is_unchanged() {
        let error = map(402, r#"{"error":"budget exhausted","code":"budget_exceeded"}"#);

        assert_eq!(error.kind, AgenticErrorKind::BudgetExceeded);
        assert_eq!(error.code.as_deref(), Some("budget_exceeded"));
        assert!(error.upgrade.is_none());
    }

    #[test]
    fn unrecognised_402_code_stays_budget_exceeded() {
        assert_eq!(
            map(402, r#"{"code":"some_future_402_reason"}"#).kind,
            AgenticErrorKind::BudgetExceeded
        );
    }

    #[test]
    fn non_json_402_body_does_not_panic() {
        let error = map(402, "<html>Payment Required</html>");

        assert_eq!(error.kind, AgenticErrorKind::BudgetExceeded);
        assert!(error.upgrade.is_none());
        assert!(error.message.contains("Payment Required"));
    }

    #[test]
    fn empty_402_body_falls_back_to_the_default_message() {
        let error = map(402, "");

        assert_eq!(error.kind, AgenticErrorKind::BudgetExceeded);
        assert_eq!(error.message, "budget or upgrade required");
    }

    #[test]
    fn other_statuses_are_undisturbed() {
        for (status, kind) in [
            (400, AgenticErrorKind::Validation),
            (401, AgenticErrorKind::Authentication),
            (403, AgenticErrorKind::PermissionDenied),
            (422, AgenticErrorKind::SafetyBlocked),
        ] {
            assert_eq!(map(status, r#"{"code":"upgrade_required"}"#).kind, kind);
        }
    }
}

#[cfg(test)]
mod conformance_corpus_tests {
    //! In-crate half of the cross-language error-mapping corpus adapter
    //! (`sdks/fixtures/error-mapping/`, issue #75). `map_http_error` is
    //! `pub(super)`, so the kind mapping -- the part the corpus exists to
    //! compare -- cannot be reached from `tests/`.
    use super::*;
    use serde_json::Value;

    fn corpus() -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/error-mapping/meta-llm-http-errors-v1.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("corpus readable"))
            .expect("corpus is valid JSON")
    }

    /// The language-neutral shape the corpus compares. Absent values are
    /// `null`, never omitted, so a missing security-significant field cannot
    /// normalize into equality (ADR-0030a §D2).
    fn canonical(error: &AgenticError) -> Value {
        let upgrade = error.upgrade.as_ref().map_or(Value::Null, |u| {
            serde_json::json!({
                "requiredTier": u.required_tier,
                "heldTier": u.held_tier,
                "requiredScope": u.required_scope,
                "upgradeUrl": u.upgrade_url,
                "retryWith": u.retry_with.as_ref().map_or(Value::Null, |r| {
                    serde_json::json!({ "fallbackPolicy": r.fallback_policy })
                }),
            })
        });
        serde_json::json!({
            "kind": error.kind,
            "retryable": error.retryable,
            "code": error.code,
            "retryAfterMs": error.retry_after_ms,
            "upgrade": upgrade,
        })
    }

    #[test]
    fn error_mapping_matches_the_corpus() {
        let corpus = corpus();
        let operation = corpus["operation"].as_str().unwrap();
        let request_id = corpus["requestId"].as_str().unwrap();
        let mut checked = 0;

        for case in corpus["cases"].as_array().expect("cases array") {
            let id = case["id"].as_str().unwrap();
            let status = case["response"]["status"].as_u64().unwrap() as u16;
            let body = case["response"]["body"].as_str().unwrap();

            // A declared divergence pins THIS language's actual behaviour, so
            // a divergence can neither hide nor drift unnoticed.
            let expected = case
                .get("knownDivergence")
                .and_then(|d| d.get("rust"))
                .unwrap_or(&case["expected"]);

            let error = MetaLlmClient::map_http_error(
                reqwest::StatusCode::from_u16(status).unwrap(),
                body,
                operation,
                request_id,
            );

            let actual = canonical(&error);
            // `retryAfterMs` comes from a header, which this mapper does not
            // receive; the parser half is asserted in tests/conformance_error_mapping.rs.
            for field in ["kind", "retryable", "code", "upgrade"] {
                assert_eq!(actual[field], expected[field], "case {id}, field {field}");
            }
            let needle = expected["messageContains"].as_str().unwrap();
            assert!(
                error.message.contains(needle),
                "case {id}: message {:?} does not contain {needle:?}",
                error.message
            );

            if let Some(forbidden) = case.get("mustNotAppearInUpgrade").and_then(Value::as_str) {
                assert!(
                    !format!("{:?}", error.upgrade).contains(forbidden),
                    "case {id}: {forbidden:?} leaked into the upgrade affordance"
                );
            }
            checked += 1;
        }

        assert!(checked > 20, "corpus shrank to {checked} cases");
    }
}
