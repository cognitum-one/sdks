//! Internal HTTP glue for [`super::client::MetaProxyClient`]'s `status()`
//! (and, through it, `capabilities()`) — credential acquisition, auth
//! header placement, JSON parsing, and HTTP-status-to-`AgenticError`
//! mapping. Reuses the same ADR-0024a §D6 status table
//! `crate::meta_llm::http` uses for the same reason: none of these
//! statuses are Proxy-specific, and ADR-0025a §D8's Proxy-specific
//! `MetaProxyError` shape is explicitly out of scope this pass.
//!
//! Split out of `client.rs` to keep that file focused on the public
//! operation surface; nothing here is part of the public API (this module
//! is private — see `super`'s `mod http;`).

use std::time::Instant;

use serde_json::Value;
use uuid::Uuid;

use crate::agentic::{AgenticError, AgenticErrorKind, Credential, CredentialRequest};

use super::client::MetaProxyClient;
use super::config::MetaProxyTelemetryEvent;
use super::envelope::MetaProxyResponseMeta;
use super::forwarding::{build_forward_headers, MetaProxyChatCallOptions};
use super::status::parse_routing_receipt;
use super::PRODUCT;

/// Credential scope for authenticated read routes (`/status`, and through it
/// `capabilities()`).
const STATUS_SCOPE: &str = "meta-proxy.status";
/// Credential scope for the mutating forwarding routes (`/v1/chat/completions`).
/// Distinct from [`STATUS_SCOPE`] — these are inference calls, not reads
/// (ADR-0025a §D6/§D7).
const INFERENCE_SCOPE: &str = "meta-proxy.inference";

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

impl MetaProxyClient {
    pub(super) async fn resolve_credential(
        &self,
        operation: &str,
        scope: &str,
    ) -> Result<Option<Credential>, AgenticError> {
        let Some(provider) = self.config.local_credential_provider.as_ref() else {
            return Ok(None);
        };
        let request = CredentialRequest {
            product: PRODUCT.to_owned(),
            normalized_origin: self.config.origin.clone(),
            audience: self.config.origin.clone(),
            required_scopes: vec![scope.to_owned()],
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
        // ADR-0025a §D6 (deferred, minimal auth only this pass): exactly
        // one contracted placement per operation, mirroring
        // `crate::meta_llm::http`'s `apply_auth`. `credential.scheme` is
        // either the literal header name or "bearer", mapped to
        // `Authorization`.
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
    ) -> Result<(Value, MetaProxyResponseMeta), AgenticError> {
        let request_id = Uuid::new_v4().to_string();
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_start(operation, &request_id);
        }
        let started_at = Instant::now();

        // ADR-0025a Context: `/status` is authenticated — unlike
        // `MetaLlmClient::health()`, there is no unauthenticated Proxy
        // status route to fall back to, so a missing
        // `local_credential_provider` fails closed here.
        let credential = self
            .resolve_credential(operation, STATUS_SCOPE)
            .await
            .map_err(|mut e| {
                if e.product.is_none() {
                    e.product = Some(PRODUCT.to_owned());
                }
                e
            })?;
        let Some(credential) = credential else {
            return Err(AgenticError::new(
                AgenticErrorKind::Authentication,
                format!(
                    "MetaProxyClient::{operation} requires a local_credential_provider \
                     (ADR-0025a Context: \"GET /status | Authenticated local runtime and \
                     routing state\")"
                ),
            )
            .with_product_operation(PRODUCT, operation)
            .with_request_id(&request_id));
        };

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&request_id) {
            headers.insert("X-Cognitum-Request-Id", value);
        }
        self.apply_auth(&mut headers, &credential);

        let url = format!("{}{}", self.config.origin, path);
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
            telemetry.on_request_end(&MetaProxyTelemetryEvent {
                operation: operation.to_owned(),
                request_id: request_id.clone(),
                http_status: Some(status.as_u16()),
                duration_ms: Some(duration_ms),
                retry_after_ms: None,
            });
        }

        let product_version = response
            .headers()
            .get("x-cognitum-product-version")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
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
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok());

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

        let meta = MetaProxyResponseMeta {
            request_id: response_request_id,
            product_version,
            protocol_version,
            http_status: status.as_u16(),
            retry_after,
            routing_receipt: None,
            upstream_receipt: None,
            warnings: None,
            unknown_headers: None,
        };
        Ok((data, meta))
    }

    /// Proxy-local idempotent POST (ADR-0025a §D7/§D8).
    ///
    /// Deliberately NOT a call into `meta_llm`'s `post_json_idempotent`:
    /// ADR-0019 §D4 keeps client behavior product-private (only wire types are
    /// shared, §D7), so this reimplements the same shape — a stable
    /// `Idempotency-Key` across the one possible 401-triggered retry and a
    /// single 401 credential refresh — against the Proxy's local route
    /// rather than borrowing another product's method.
    ///
    /// Deliberately NOT bounded-retried on 429/502/503: §D8 says "No Proxy
    /// POST is automatically retried while it drops `Idempotency-Key`",
    /// which describes the *Proxy server* dropping the header for
    /// server-side dedup (confirmed by the currently-deployed Proxy), not
    /// whether the SDK attaches one. Attaching an `Idempotency-Key`
    /// client-side does not make a retry safe when the server never uses it
    /// to deduplicate — the Alternatives-considered table rejects "Retry
    /// Proxy POSTs" outright ("Idempotency is dropped and spend can
    /// duplicate"). Every non-2xx (429/502/503 included) is therefore a
    /// single terminal, non-retryable `AgenticError` carrying
    /// `retry_after_ms` so the CALLER can retry manually. Bounded retry
    /// remains reserved for the read-only status/models/identity routes
    /// (§D8), which this method does not implement.
    ///
    /// Fails closed with `Authentication` before any HTTP call when no
    /// `local_credential_provider` is configured.
    #[allow(clippy::result_large_err)]
    pub(super) async fn post_json_forwarding(
        &self,
        path: &str,
        operation: &str,
        body: Value,
        options: &MetaProxyChatCallOptions,
    ) -> Result<(Value, MetaProxyResponseMeta), AgenticError> {
        // Fail closed BEFORE any network I/O when no provider is configured —
        // the local `/v1/*` routes are authenticated, like `/status`.
        let mut credential = match self
            .resolve_credential(operation, INFERENCE_SCOPE)
            .await
            .map_err(|mut e| {
                if e.product.is_none() {
                    e.product = Some(PRODUCT.to_owned());
                }
                e
            })? {
            Some(credential) => credential,
            None => {
                return Err(AgenticError::new(
                    AgenticErrorKind::Authentication,
                    format!(
                        "MetaProxyClient::{operation} requires a local_credential_provider \
                         (ADR-0025a §D6: the Proxy's /v1 forwarding routes are authenticated)"
                    ),
                )
                .with_product_operation(PRODUCT, operation));
            }
        };

        // Stable across the one possible 401-triggered retry of this logical
        // call (§D7/§D8: "No Proxy POST is automatically retried while it
        // drops `Idempotency-Key`").
        let idempotency_key = options
            .idempotency_key
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let mut refreshed_once = false;

        loop {
            match self
                .send_chat_post_once(path, operation, &body, &credential, &idempotency_key, options)
                .await
            {
                Ok(ok) => return Ok(ok),
                Err(err) => {
                    if err.status == Some(401) && !refreshed_once {
                        refreshed_once = true;
                        if let Some(provider) = self.config.local_credential_provider.as_ref() {
                            provider.invalidate("401 challenge from meta-proxy").await;
                        }
                        credential =
                            match self.resolve_credential(operation, INFERENCE_SCOPE).await? {
                                Some(credential) => credential,
                                None => return Err(err),
                            };
                        continue;
                    }

                    // ADR-0025a §D8: the currently-deployed Proxy drops
                    // `Idempotency-Key` server-side, so attaching one does not
                    // make a retry safe. 429/502/503 (and every other status)
                    // surface as a single terminal error here;
                    // `err.retry_after_ms` lets the caller retry manually.
                    return Err(err);
                }
            }
        }
    }

    /// One POST attempt. Never retries itself — the caller owns retry/backoff.
    #[allow(clippy::result_large_err)]
    async fn send_chat_post_once(
        &self,
        path: &str,
        operation: &str,
        body: &Value,
        credential: &Credential,
        idempotency_key: &str,
        options: &MetaProxyChatCallOptions,
    ) -> Result<(Value, MetaProxyResponseMeta), AgenticError> {
        let request_id = Uuid::new_v4().to_string();
        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_start(operation, &request_id);
        }
        let started_at = Instant::now();

        // Caller-supplied headers first, allowlist-filtered (§D7). Reserved
        // headers set afterwards so they always win over anything the caller
        // tried to forward — the caller can never override auth, content-type,
        // or the retry-stable idempotency key.
        let mut headers = build_forward_headers(options.forward_headers.as_ref());
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
        if let Ok(value) = reqwest::header::HeaderValue::from_str(idempotency_key) {
            headers.insert("Idempotency-Key", value);
        }
        // Bearer attaches last, from validated local state only (§D6/§D7) —
        // never from a caller-forwarded header.
        self.apply_auth(&mut headers, credential);

        let url = format!("{}{}", self.config.origin, path);
        let response = self
            .http
            .post(&url)
            .headers(headers)
            .json(body)
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

        let product_version = response
            .headers()
            .get("x-cognitum-product-version")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
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
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok());
        let retry_after_ms = retry_after.map(|secs| (secs * 1000.0) as u64);

        if let Some(telemetry) = self.config.telemetry.as_ref() {
            telemetry.on_request_end(&MetaProxyTelemetryEvent {
                operation: operation.to_owned(),
                request_id: request_id.clone(),
                http_status: Some(status.as_u16()),
                duration_ms: Some(duration_ms),
                retry_after_ms,
            });
        }

        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            let mut err =
                Self::map_http_error(status, &body_text, operation, &response_request_id);
            if err.retry_after_ms.is_none() {
                err.retry_after_ms = retry_after_ms;
            }
            return Err(err);
        }

        let data: Value = response.json().await.map_err(|cause| {
            AgenticError::new(
                AgenticErrorKind::Protocol,
                format!("{operation} response body was not valid JSON: {cause}"),
            )
            .with_product_operation(PRODUCT, operation)
            .with_request_id(&response_request_id)
        })?;

        // §D4/§D7: preserve the Proxy's routing receipt and the upstream
        // (Cognitum-cloud) receipt when present, under reasonable wire keys.
        let routing_receipt = data
            .as_object()
            .and_then(|obj| obj.get("cognitum_routing_receipt"))
            .and_then(parse_routing_receipt);
        let upstream_receipt = data
            .as_object()
            .and_then(|obj| obj.get("cognitum_upstream_receipt"))
            .cloned();

        let meta = MetaProxyResponseMeta {
            request_id: response_request_id,
            product_version,
            protocol_version,
            http_status: status.as_u16(),
            retry_after,
            routing_receipt,
            upstream_receipt,
            warnings: None,
            unknown_headers: None,
        };
        Ok((data, meta))
    }

    /// HTTP-status -> `AgenticErrorKind` mapping — same ADR-0024a §D6 table
    /// `crate::meta_llm::http` uses; ADR-0025a §D8's Proxy-specific error
    /// shape is deferred.
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
            400 => base(
                AgenticErrorKind::Validation,
                non_empty(body_text, "invalid request"),
                false,
            ),
            401 => base(
                AgenticErrorKind::Authentication,
                non_empty(body_text, "local Proxy authentication failed"),
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
