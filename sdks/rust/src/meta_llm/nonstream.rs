//! Non-streaming HTTP call logic for the two "direct nonstream call[s]
//! whose accepted contract declares safe replay" named in ADR-0024a §D7:
//! `chat.completions` and `messages.create`. Issue #58 / M2 continuation.
//!
//! Deliberately out of scope here: streaming/SSE parsing (§D5) -- folded
//! into `client.rs`/this module in later passes.
//!
//! ADR-0024b D11 migration step 1 (issue #59): this module now also
//! decodes a `MetaLlmReceipt` from the response body when the server
//! includes one (`cognitum_receipt`). `routing_controls` validation
//! happens in `client.rs` before `serde_json::to_value` even runs, not
//! here -- this module only sees the already-serialized `Value` body.
//!
//! Retry (ADR-0023 §D3/§D4, ADR-0024a §D6):
//! - 401: at most one credential refresh after a verified challenge (the
//!   401 response itself), then retry once with the same idempotency key
//!   and body. A second 401 is returned as-is.
//! - 429/502/503: bounded retry using the frozen `RetryPolicy` /
//!   `equal_jitter_delay_ms` (ADR-0005/ADR-0023 verbatim), gated on the
//!   idempotency-with-key binding built in `./idempotency.rs` — this is
//!   what makes the replay safe.
//! - 400/403/404/409/402/422 and anything else: never retried.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use uuid::Uuid;

use crate::agentic::{
    assert_scope_granted, equal_jitter_delay_ms, AgenticError, AgenticErrorKind, Credential,
    CredentialRequest, RetryPolicy,
};

use super::client::MetaLlmClient;
use super::config::MetaLlmTelemetryEvent;
use super::envelope::MetaLlmResponseMeta;
use super::idempotency::{build_idempotency_binding, canonical_request_sha256};
use super::types::parse_meta_llm_receipt;
use super::PRODUCT;

/// Required scope for the inference-serving operations in this pass.
/// Distinct from `get_json`'s `"meta-llm.read"` — these are mutating
/// generation calls, not discovery reads (ADR-0024a §D8).
const INFERENCE_SCOPE: &str = "meta-llm.inference";

/// Per-operation required-scope map for ADR-0022 §D5's scope preflight,
/// covering every "completion-family route" per ADR-0024a §D8 that shares
/// this module's `post_json_idempotent`/credential path.
///
/// PROVISIONAL: no ADR-0020 OpenAPI/JSON-Schema contract bundle publishing
/// a real scope-token vocabulary exists yet (ADR-0024a §D9 gate #1/#8), so
/// every completion-family operation maps to the same literal
/// `INFERENCE_SCOPE` already used in the `CredentialRequest` sent to
/// `acquire()` below — this names the mapping explicitly so a real
/// per-operation vocabulary can slot in later without changing the
/// preflight call site.
fn required_scope_for(operation: &str) -> &'static str {
    match operation {
        "chat.completions" | "chat_completions_stream" | "messages.create"
        | "messages.count_tokens" | "completions" | "responses" | "embeddings" => {
            INFERENCE_SCOPE
        }
        _ => INFERENCE_SCOPE,
    }
}

/// Cheap non-cryptographic jitter in `[0, bound]`, matching the existing
/// cloud `Client`'s `retry_hint::pseudo_jitter_ms` convention (subsecond
/// `SystemTime` entropy) rather than pulling in a `rand` dependency for a
/// backoff jitter that only needs to avoid lockstep retries across
/// callers, not cryptographic unpredictability.
/// `pub(super)` so `./stream/chat_completions_stream.rs` can reuse this
/// verbatim (issue #58 D5 streaming pass).
pub(super) fn random_jitter_ms(bound: u64) -> u64 {
    if bound == 0 {
        return 0;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    nanos % (bound + 1)
}

impl MetaLlmClient {
    /// Shared idempotent-with-key POST used by `chat_completions` and
    /// `messages_create`. Returns the raw JSON body plus response
    /// metadata; callers deserialize into their own protocol-specific
    /// response type.
    #[allow(clippy::result_large_err)]
    pub(super) async fn post_json_idempotent(
        &self,
        path: &str,
        operation: &str,
        body: Value,
    ) -> Result<(Value, MetaLlmResponseMeta), AgenticError> {
        let mut credential = self.require_credential(operation).await?;
        let idempotency_key = Uuid::new_v4().to_string();
        let canonical_sha256 = canonical_request_sha256(&body);
        let tenant = self
            .config
            .default_request_context
            .as_ref()
            .and_then(|rc| rc.tenant.as_ref());

        let retry_policy = RetryPolicy::default();
        let mut attempt: u32 = 0;
        let mut sleep_budget_used_ms: u64 = 0;
        let mut refreshed_once = false;

        loop {
            let binding = build_idempotency_binding(
                operation,
                path,
                &credential,
                tenant,
                canonical_sha256.clone(),
                idempotency_key.clone(),
            );

            match self
                .send_post_once(path, operation, &body, &credential, &binding.idempotency_key)
                .await
            {
                Ok(ok) => return Ok(ok),
                Err(err) => {
                    if err.status == Some(401) && !refreshed_once {
                        refreshed_once = true;
                        if let Some(provider) = self.config.credential_provider.as_ref() {
                            provider.invalidate("401 challenge from meta-llm").await;
                        }
                        credential = self.require_credential(operation).await?;
                        continue;
                    }

                    let is_bounded_retryable =
                        matches!(err.status, Some(429) | Some(502) | Some(503));
                    if is_bounded_retryable && attempt + 1 < retry_policy.max_attempts {
                        let server_hint_ms = err.retry_after_ms.unwrap_or(0);
                        let jitter_ms = random_jitter_ms(retry_policy.base_ms);
                        let delay_ms = equal_jitter_delay_ms(
                            attempt,
                            &retry_policy,
                            server_hint_ms,
                            jitter_ms,
                        );
                        if sleep_budget_used_ms.saturating_add(delay_ms)
                            > retry_policy.retry_sleep_budget_ms
                        {
                            return Err(err);
                        }
                        sleep_budget_used_ms += delay_ms;
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        attempt += 1;
                        continue;
                    }

                    return Err(err);
                }
            }
        }
    }

    /// Resolve a credential, failing closed with `Authentication` when no
    /// provider is configured — mirrors `http.rs`'s `get_json` gate for
    /// `whoami`/`models`, but with the inference scope (ADR-0024a §D8).
    /// `pub(super)` (rather than private) so `./stream/chat_completions_stream.rs`
    /// can reuse it verbatim (issue #58 D5 streaming pass) instead of
    /// duplicating credential-acquisition logic.
    #[allow(clippy::result_large_err)]
    pub(super) async fn require_credential(&self, operation: &str) -> Result<Credential, AgenticError> {
        let Some(provider) = self.config.credential_provider.as_ref() else {
            return Err(AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some(operation.to_owned()),
                ..AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!("MetaLlmClient::{operation} requires a credential_provider"),
                )
            });
        };
        let required_scope = required_scope_for(operation);
        let request = CredentialRequest {
            product: PRODUCT.to_owned(),
            normalized_origin: self.config.base_url.clone(),
            audience: self.config.base_url.clone(),
            required_scopes: vec![required_scope.to_owned()],
            operation: operation.to_owned(),
            interactive_allowed: false,
        };
        let credential = provider.acquire(&request).await.map_err(|mut e| {
            if e.product.is_none() {
                e.product = Some(PRODUCT.to_owned());
            }
            e
        })?;
        // ADR-0022 §D5 scope preflight: fail closed BEFORE any I/O when the
        // credential's granted scopes are known and insufficient. A
        // credential with unknown (`None`) granted scopes — e.g.
        // `StaticApiKeyCredentialProvider`'s today — is sent through
        // unchecked; the server remains authoritative for that case.
        assert_scope_granted(PRODUCT, operation, required_scope, &credential)?;
        Ok(credential)
    }

    /// One HTTP attempt. Never retries by itself — the caller
    /// (`post_json_idempotent`) owns retry/backoff decisions.
    #[allow(clippy::result_large_err)]
    async fn send_post_once(
        &self,
        path: &str,
        operation: &str,
        body: &Value,
        credential: &Credential,
        idempotency_key: &str,
    ) -> Result<(Value, MetaLlmResponseMeta), AgenticError> {
        let request_id = Uuid::new_v4().to_string();
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_start(operation, &request_id);
        }
        let started_at = std::time::Instant::now();

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&request_id) {
            headers.insert("X-Cognitum-Request-Id", value);
        }
        // ADR-0024a §D7 / ADR-0005: the caller-attested idempotency key,
        // stable across every retry of one logical call.
        if let Ok(value) = reqwest::header::HeaderValue::from_str(idempotency_key) {
            headers.insert("Idempotency-Key", value);
        }
        self.apply_auth(&mut headers, credential);

        let url = format!("{}{}", self.config.base_url, path);
        let response = self
            .http
            .post(&url)
            .headers(headers)
            .json(body)
            .send()
            .await
            .map_err(|cause| AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some(operation.to_owned()),
                request_id: Some(request_id.clone()),
                retryable: true,
                ..AgenticError::new(
                    AgenticErrorKind::Transport,
                    format!("{operation} request failed: {cause}"),
                )
            })?;

        let status = response.status();
        let duration_ms = started_at.elapsed().as_millis() as u64;

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
        let idempotent_replay = response
            .headers()
            .get("x-cognitum-idempotent-replay")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("true"));
        let retry_after_header_ms = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok())
            .map(|secs| (secs * 1000.0) as u64);

        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_end(&MetaLlmTelemetryEvent {
                operation: operation.to_owned(),
                request_id: request_id.clone(),
                http_status: Some(status.as_u16()),
                duration_ms: Some(duration_ms),
                retry_after_ms: retry_after_header_ms,
                idempotent_replay,
            });
        }

        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            let mut err =
                MetaLlmClient::map_http_error(status, &body_text, operation, &response_request_id);
            if err.retry_after_ms.is_none() {
                err.retry_after_ms = retry_after_header_ms;
            }
            return Err(err);
        }

        let data: Value = response.json().await.map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some(operation.to_owned()),
            request_id: Some(response_request_id.clone()),
            ..AgenticError::new(
                AgenticErrorKind::Protocol,
                format!("{operation} response body was not valid JSON: {cause}"),
            )
        })?;

        // ADR-0024b §D3/§D11 step 1: decode a `cognitum_receipt` field
        // embedded in the response body, if present, into the typed
        // `MetaLlmReceipt` -- same wire key the SSE path already
        // recognizes (`stream/openai_events.rs`).
        let receipt = data
            .as_object()
            .and_then(|obj| obj.get("cognitum_receipt"))
            .and_then(parse_meta_llm_receipt);

        let meta = MetaLlmResponseMeta {
            request_id: response_request_id,
            http_status: status.as_u16(),
            protocol_version,
            retry_after_ms: retry_after_header_ms,
            idempotent_replay,
            receipt,
            warnings: None,
            unknown_headers: None,
        };
        Ok((data, meta))
    }
}
