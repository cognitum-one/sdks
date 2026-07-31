//! Internal HTTP glue for [`super::client::HarnessaaSClient`] — credential
//! acquisition, auth header placement, JSON parsing, and HTTP-status-to-
//! `AgenticError` mapping.
//!
//! HTTP-status mapping verified against the REAL error paths in
//! `cognitum-one/harnessaas@908e4a99`:
//!
//! - 401 `missing_api_key`/`invalid_api_key` (`src/auth.ts:280-303`) —
//!   opaque on purpose (anti-enumeration).
//! - 403 `insufficient_scope`/`scope_required`, plus `EgressDeniedError`
//!   (ADR-0040) — fail closed rather than degrade to open egress.
//! - 400 — invalid JSON body, missing required fields, a non-git `repo`
//!   path (`repo_not_permitted`, issue #56), or a vertical-specific
//!   missing field.
//! - 404 — unmatched route, or (for `lineage`) a `request_id` not owned by
//!   the caller's tenant (cross-tenant reads collapse to the same 404).
//! - 422 `safety_blocked` — the inbound PII/safety pre-flight refused the
//!   request BEFORE any spend (`PiiBlockedError`).
//! - 500 — an uncaught exception; no in-app rate limiter or explicit
//!   429/502/503 emission was found in `harnessaas`'s own route code, so
//!   those (if seen at all) originate from infrastructure in front of the
//!   app. Mapped here defensively for forward compatibility only.
//!
//! Split out of `client.rs` to keep that file focused on the public
//! operation surface; nothing here is part of the public API.

use std::time::Instant;

use serde_json::Value;
use uuid::Uuid;

use crate::agentic::{AgenticError, AgenticErrorKind, Credential, CredentialRequest};

use super::client::{HarnessaaSClient, PRODUCT};
use super::config::HarnessaaSTelemetryEvent;
use super::envelope::HarnessaaSResponseMeta;

fn non_empty<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() {
        fallback
    } else {
        value
    }
}

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
    fn with_retry_after_ms(self, retry_after_ms: Option<u64>) -> Self;
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

    fn with_retry_after_ms(mut self, retry_after_ms: Option<u64>) -> Self {
        if self.retry_after_ms.is_none() {
            self.retry_after_ms = retry_after_ms;
        }
        self
    }
}

/// `Retry-After` per RFC 9110. Was delta-seconds-only here too, a fourth
/// variant of the same bug found across the SDKs (issue #75).
fn retry_after_ms_of(response: &reqwest::Response) -> Option<u64> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    crate::agentic::parse_retry_after_ms(
        response.headers().get("retry-after").and_then(|v| v.to_str().ok()),
        now_ms,
    )
}

/// HTTP-status -> `AgenticErrorKind` mapping. Shared by every operation's
/// error path (`health`/`solve`/`lineage`) since none of these statuses are
/// operation-specific. `pub(super)` so `client.rs` can reuse it.
pub(super) fn map_http_error(status: reqwest::StatusCode, body_text: &str, operation: &str, request_id: &str) -> AgenticError {
    let base = |kind: AgenticErrorKind, message: &str, retryable: bool| {
        AgenticError::new(kind, message.to_owned())
            .with_product_operation(PRODUCT, operation)
            .with_request_id(request_id)
            .with_retryable(retryable)
            .with_status(status.as_u16())
    };

    match status.as_u16() {
        400 => base(AgenticErrorKind::Validation, non_empty(body_text, "invalid request"), false),
        // Opaque anti-enumeration auth failure (`src/auth.ts`) — never retried.
        401 => base(AgenticErrorKind::Authentication, non_empty(body_text, "authentication failed"), false),
        // Insufficient scope (`insufficient_scope`/`scope_required`) or egress denial.
        403 => base(AgenticErrorKind::PermissionDenied, non_empty(body_text, "permission denied"), false),
        404 => base(AgenticErrorKind::NotFound, non_empty(body_text, "not found"), false),
        // The inbound safety pre-flight refused the request before any spend
        // (`PiiBlockedError`) — a genuine content-of-request rejection, never retried.
        422 => base(
            AgenticErrorKind::SafetyBlocked,
            non_empty(body_text, "request blocked by PII/safety pre-flight"),
            false,
        ),
        // No in-app rate limiter or explicit 5xx emission was found in
        // harnessaas's own route code — classified `retryable: true` here
        // for forward compatibility ONLY; `solve()` never acts on this.
        429 => base(AgenticErrorKind::RateLimited, non_empty(body_text, "rate limited"), true),
        502 | 503 => base(
            AgenticErrorKind::Transport,
            non_empty(body_text, &format!("upstream error {status}")),
            true,
        ),
        // An uncaught exception (`src/server.ts`'s catch-all `json(res, 500, ...)`).
        500 => base(AgenticErrorKind::Protocol, non_empty(body_text, "internal server error"), false),
        _ => base(AgenticErrorKind::Protocol, non_empty(body_text, &format!("unexpected status {status}")), false),
    }
}

impl HarnessaaSClient {
    pub(super) async fn require_credential(&self, operation: &str) -> Result<Credential, AgenticError> {
        let Some(provider) = self.config.credential_provider.as_ref() else {
            return Err(AgenticError::new(
                AgenticErrorKind::Authentication,
                format!("HarnessaaSClient::{operation} requires a credential_provider"),
            )
            .with_product_operation(PRODUCT, operation));
        };
        let request = CredentialRequest {
            product: PRODUCT.to_owned(),
            normalized_origin: self.config.base_url.clone(),
            audience: self.config.base_url.clone(),
            // No single required-scope string — see `client.rs`'s `solve()` doc comment.
            required_scopes: Vec::new(),
            operation: operation.to_owned(),
            interactive_allowed: false,
        };
        provider.acquire(&request).await.map_err(|mut e| {
            if e.product.is_none() {
                e.product = Some(PRODUCT.to_owned());
            }
            e
        })
    }

    pub(super) fn apply_auth(&self, headers: &mut reqwest::header::HeaderMap, credential: &Credential) {
        // Exactly one contracted placement per operation (`src/auth.ts:256-264`
        // accepts EITHER `X-API-Key` OR `Authorization: Bearer`, never both).
        let (name, value) = if credential.scheme.eq_ignore_ascii_case("bearer") {
            ("Authorization".to_owned(), format!("Bearer {}", credential.secret.reveal()))
        } else {
            (credential.scheme.clone(), credential.secret.reveal().to_owned())
        };
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(&value),
        ) {
            headers.insert(name, value);
        }
    }

    /// One GET attempt. Never retries by itself — callers own that (see
    /// `client.rs`'s `lineage()`/`health()`).
    #[allow(clippy::result_large_err)]
    pub(super) async fn send_get_once(
        &self,
        path: &str,
        operation: &str,
        credential: Option<&Credential>,
    ) -> Result<(Value, HarnessaaSResponseMeta), AgenticError> {
        let request_id = Uuid::new_v4().to_string();
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_start(operation, &request_id);
        }
        let started_at = Instant::now();

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::ACCEPT, reqwest::header::HeaderValue::from_static("application/json"));
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&request_id) {
            headers.insert("X-Cognitum-Request-Id", value);
        }
        if let Some(credential) = credential {
            self.apply_auth(&mut headers, credential);
        }

        let url = format!("{}{}", self.config.base_url, path);
        let response = self.http.get(&url).headers(headers).send().await.map_err(|cause| {
            AgenticError::new(AgenticErrorKind::Transport, format!("{operation} request failed: {cause}"))
                .with_product_operation(PRODUCT, operation)
                .with_retryable(true)
                .with_request_id(&request_id)
        })?;

        let status = response.status();
        let retry_after_ms = retry_after_ms_of(&response);
        let duration_ms = started_at.elapsed().as_millis() as u64;
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_end(&HarnessaaSTelemetryEvent {
                operation: operation.to_owned(),
                request_id: request_id.clone(),
                http_status: Some(status.as_u16()),
                duration_ms: Some(duration_ms),
                retry_after_ms,
            });
        }

        let response_request_id = response
            .headers()
            .get("x-cognitum-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .unwrap_or_else(|| request_id.clone());

        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(map_http_error(status, &body_text, operation, &response_request_id).with_retry_after_ms(retry_after_ms));
        }

        let data: Value = response.json().await.map_err(|cause| {
            AgenticError::new(AgenticErrorKind::Protocol, format!("{operation} response body was not valid JSON: {cause}"))
                .with_product_operation(PRODUCT, operation)
                .with_request_id(&response_request_id)
        })?;

        Ok((
            data,
            HarnessaaSResponseMeta {
                request_id: response_request_id,
                http_status: status.as_u16(),
                retry_after_ms,
            },
        ))
    }

    /// One POST attempt. Never retries by itself — the caller (`solve()`) owns that.
    #[allow(clippy::result_large_err)]
    pub(super) async fn send_post_once(
        &self,
        path: &str,
        operation: &str,
        body: &Value,
        credential: &Credential,
    ) -> Result<(Value, HarnessaaSResponseMeta), AgenticError> {
        let request_id = Uuid::new_v4().to_string();
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_start(operation, &request_id);
        }
        let started_at = Instant::now();

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::ACCEPT, reqwest::header::HeaderValue::from_static("application/json"));
        headers.insert(reqwest::header::CONTENT_TYPE, reqwest::header::HeaderValue::from_static("application/json"));
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&request_id) {
            headers.insert("X-Cognitum-Request-Id", value);
        }
        self.apply_auth(&mut headers, credential);

        let url = format!("{}{}", self.config.base_url, path);
        let response = self.http.post(&url).headers(headers).json(body).send().await.map_err(|cause| {
            AgenticError::new(AgenticErrorKind::Transport, format!("{operation} request failed: {cause}"))
                .with_product_operation(PRODUCT, operation)
                .with_retryable(true)
                .with_request_id(&request_id)
        })?;

        let status = response.status();
        let retry_after_ms = retry_after_ms_of(&response);
        let duration_ms = started_at.elapsed().as_millis() as u64;
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_end(&HarnessaaSTelemetryEvent {
                operation: operation.to_owned(),
                request_id: request_id.clone(),
                http_status: Some(status.as_u16()),
                duration_ms: Some(duration_ms),
                retry_after_ms,
            });
        }

        let response_request_id = response
            .headers()
            .get("x-cognitum-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .unwrap_or_else(|| request_id.clone());

        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(map_http_error(status, &body_text, operation, &response_request_id).with_retry_after_ms(retry_after_ms));
        }

        let data: Value = response.json().await.map_err(|cause| {
            AgenticError::new(AgenticErrorKind::Protocol, format!("{operation} response body was not valid JSON: {cause}"))
                .with_product_operation(PRODUCT, operation)
                .with_request_id(&response_request_id)
        })?;

        Ok((
            data,
            HarnessaaSResponseMeta {
                request_id: response_request_id,
                http_status: status.as_u16(),
                retry_after_ms,
            },
        ))
    }
}
