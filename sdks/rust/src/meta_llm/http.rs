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

use crate::agentic::{AgenticError, AgenticErrorKind, Credential, CredentialRequest};

use super::client::MetaLlmClient;
use super::config::MetaLlmTelemetryEvent;
use super::envelope::MetaLlmResponseMeta;
use super::PRODUCT;

/// A placeholder error for the five protocol operations whose HTTP logic
/// is a follow-up issue (ADR-0024a §D2/§D3).
pub(super) fn not_implemented(operation: &str) -> AgenticError {
    unsupported(
        operation,
        format!(
            "MetaLlmClient::{operation} is not implemented yet (ADR-0024a §D2/§D3 wire \
             types only landed in issue #58 / M2 — HTTP logic is a follow-up issue)"
        ),
    )
}

/// Generic fail-closed `unsupported_capability` error, product/operation-scoped.
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

    fn map_http_error(
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
