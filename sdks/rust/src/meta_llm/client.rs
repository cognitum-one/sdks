//! `MetaLlmClient` (ADR-0024a). Issue #58 / M2.
//!
//! M2 start (PR #85):
//!  - real, HTTP-backed `health()`, `whoami()`, and `models()` — the
//!    "Stable-track, simplest" group per §D2's maturity table (the
//!    internal HTTP glue lives in `super::http`);
//!  - `capabilities()` from the static compatibility snapshot (no I/O — no
//!    runtime capabilities endpoint is published yet, §D9 gate #3);
//!  - fails closed on `ready(feature)` (dependency readiness is only
//!    published "when published", §D1 — nothing is published yet).
//!
//! M2 continuation (PR #86): real HTTP call logic for `chat_completions`
//! and `messages_create` — idempotency-key generation, bounded 429/502/503
//! retry, and a single 401-refresh (`super::nonstream`).
//!
//! This pass (issue #58 / M2 continuation): the same real HTTP call logic
//! for the remaining direct nonstream operations named in ADR-0024a §D7 —
//! `completions` (legacy OpenAI completions), `responses`, `embeddings`,
//! and `messages_count_tokens` — reusing `post_json_idempotent` from
//! `super::nonstream` verbatim rather than a per-operation
//! reimplementation.
//!
//! ADR-0024b D11 migration step 1 (issue #59): `MetaLlmRoutingControls` is
//! now the concrete §D2 shape and lands as an optional field on
//! `chat_completions`/`messages_create`/`completions`/`responses`
//! requests (`types::openai`/`types::anthropic`); `usage()` is the new
//! read-only, authenticated-account-scoped §D3 endpoint; and every
//! nonstream/stream response now decodes a `MetaLlmReceipt` when the
//! server includes one. Explicitly still out of scope: batches, pods,
//! bench, webhooks, guidance, collaboration, evolution, MicroLoRA,
//! flywheel, genome, brain, vectors, and conditional hosts (§D5-§D8) --
//! separate future issues per §D11 steps 2-4.

use std::collections::HashMap;
use std::sync::Arc;

use crate::agentic::{AgenticError, AgenticErrorKind, CancellationToken, CapabilitySet, TimeBudget};

use super::config::{resolve_config, MetaLlmClientConfig};
use super::discovery::{MetaLlmHealth, MetaLlmModelInfo, MetaLlmModelList, MetaLlmWhoAmI};
use super::envelope::MetaLlmResult;
use super::http::{as_object, take_string, unsupported};
use super::stream::{self, ChatCompletionsStream};
use super::types::{
    assert_sendable_routing_controls, assert_valid_usage_query, parse_usage_summary,
    AnthropicMessage, AnthropicMessageRequest, ChatCompletion, ChatCompletionRequest,
    CountTokensRequest, CountTokensResult, EmbeddingRequest, EmbeddingResponse, LegacyCompletion,
    LegacyCompletionRequest, MetaLlmRoutingControls, ResponsesRequest, ResponsesResponse,
    UsageQuery, UsageSummary,
};
use super::{DEFAULT_CAPABILITY_VERSION, PRODUCT};

/// Minimal query-string percent-encoding for `usage()`'s `from`/`to`/
/// `model`/`provider` parameters. The `url` crate is only an optional
/// dependency of the `seed`/`mdns` features (`Cargo.toml`), not `meta-llm`
/// alone, so this stays a small self-contained encoder rather than adding
/// a new dependency edge for the `meta-llm`-only build.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Fails locally, before any network I/O or credential acquisition,
/// rather than sending an unrecognized enum member or a raw provider
/// model ID the resolver would reject anyway (ADR-0024b §D2).
#[allow(clippy::result_large_err)]
fn assert_routing_controls_sendable(
    operation: &str,
    controls: Option<&MetaLlmRoutingControls>,
) -> Result<(), AgenticError> {
    assert_sendable_routing_controls(controls).map_err(|cause| AgenticError {
        product: Some(PRODUCT.to_owned()),
        operation: Some(operation.to_owned()),
        ..AgenticError::new(
            AgenticErrorKind::Validation,
            format!("{operation} routing_controls rejected: {cause}"),
        )
    })
}

/// Serving-protocol client for Meta LLM (ADR-0024a). Construction performs
/// no I/O (ADR-0024a §D1, ADR-0019 §D3).
#[derive(Debug)]
pub struct MetaLlmClient {
    pub(super) config: MetaLlmClientConfig,
    pub(super) http: reqwest::Client,
}

impl MetaLlmClient {
    /// Construct a client. Validates configuration only — no I/O.
    #[allow(clippy::result_large_err)]
    pub fn new(config: MetaLlmClientConfig) -> Result<Self, AgenticError> {
        let resolved = resolve_config(config)?;
        let http = resolved.transport.clone().unwrap_or_default();
        Ok(Self {
            config: resolved,
            http,
        })
    }

    /// Read-only view of the effective configuration.
    pub fn config(&self) -> &MetaLlmClientConfig {
        &self.config
    }

    // ---------------------------------------------------------------------
    // D2: health, models, whoami, capabilities, ready — implemented here
    // ---------------------------------------------------------------------

    /// Process-level health only — never identity or readiness (ADR-0024a §D1).
    pub async fn health(&self) -> Result<MetaLlmResult<MetaLlmHealth>, AgenticError> {
        let (data, meta) = self.get_json("/v1/health", "health", false).await?;
        let mut raw = as_object(&data);
        let status = take_string(&mut raw, "status").unwrap_or_else(|| "unknown".to_owned());
        let version = take_string(&mut raw, "version");
        Ok(MetaLlmResult {
            data: MetaLlmHealth {
                status,
                version,
                raw,
            },
            meta,
        })
    }

    /// `/v1/models`. May not list every alias the resolver accepts (ADR-0024a Context).
    pub async fn models(&self) -> Result<MetaLlmResult<MetaLlmModelList>, AgenticError> {
        let (data, meta) = self.get_json("/v1/models", "models", true).await?;
        let mut raw = as_object(&data);
        let object = take_string(&mut raw, "object");
        let models_value = raw
            .remove("models")
            .or_else(|| raw.remove("data"))
            .unwrap_or(serde_json::Value::Array(vec![]));
        let models = match models_value {
            serde_json::Value::Array(items) => items
                .into_iter()
                .map(|item| {
                    let mut m = as_object(&item);
                    let id = take_string(&mut m, "id").unwrap_or_default();
                    let object = take_string(&mut m, "object");
                    let owned_by =
                        take_string(&mut m, "owned_by").or_else(|| take_string(&mut m, "ownedBy"));
                    let created = m.remove("created").and_then(|v| v.as_i64());
                    MetaLlmModelInfo {
                        id,
                        object,
                        owned_by,
                        created,
                        raw: m,
                    }
                })
                .collect(),
            _ => Vec::new(),
        };
        Ok(MetaLlmResult {
            data: MetaLlmModelList {
                models,
                object,
                raw,
            },
            meta,
        })
    }

    /// Authenticated account and credential type only (ADR-0024a §D1).
    pub async fn whoami(&self) -> Result<MetaLlmResult<MetaLlmWhoAmI>, AgenticError> {
        let (data, meta) = self.get_json("/v1/whoami", "whoami", true).await?;
        let mut raw = as_object(&data);
        let account_id =
            take_string(&mut raw, "account_id").or_else(|| take_string(&mut raw, "accountId"));
        let credential_type = take_string(&mut raw, "credential_type")
            .or_else(|| take_string(&mut raw, "credentialType"));
        let tenant_id =
            take_string(&mut raw, "tenant_id").or_else(|| take_string(&mut raw, "tenantId"));
        let scopes = raw
            .remove("scopes")
            .and_then(|v| v.as_array().cloned())
            .map(|items| {
                items
                    .into_iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        Ok(MetaLlmResult {
            data: MetaLlmWhoAmI {
                account_id,
                credential_type,
                scopes,
                tenant_id,
                raw,
            },
            meta,
        })
    }

    /// `GET /v1/usage` (ADR-0024b §D1's `client.usage`, D11 migration
    /// step 1). Strictly authenticated-account scoped — every query is
    /// bound to the caller's own credential; there is no parameter that
    /// can select another account's usage. Uses the contract's bounded
    /// `YYYY-MM` range plus optional `model`/`provider`/`group_by`
    /// grouping (§D3). An empty result is returned exactly as reported —
    /// never reinterpreted as "no usage anywhere" vs. "this account
    /// genuinely has none" (§D3: no speculative fallback logic is layered
    /// on top).
    #[allow(clippy::result_large_err)]
    pub async fn usage(
        &self,
        query: &UsageQuery,
    ) -> Result<MetaLlmResult<UsageSummary>, AgenticError> {
        assert_valid_usage_query(query).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("usage".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("usage query rejected: {cause}"),
            )
        })?;

        let mut path = format!(
            "/v1/usage?from={}&to={}",
            urlencode(&query.from),
            urlencode(&query.to)
        );
        if let Some(model) = &query.model {
            path.push_str(&format!("&model={}", urlencode(model)));
        }
        if let Some(provider) = &query.provider {
            path.push_str(&format!("&provider={}", urlencode(provider)));
        }
        if let Some(group_by) = query.group_by {
            path.push_str(&format!("&group_by={}", group_by.as_query_str()));
        }

        let (data, meta) = self.get_json(&path, "usage", true).await?;
        Ok(MetaLlmResult {
            data: parse_usage_summary(&data),
            meta,
        })
    }

    /// Versioned behavior safe for this caller, from the static
    /// compatibility snapshot (no I/O — ADR-0024a §D9 gate #3 is not yet
    /// published). Unknown server versions receive the intersection of
    /// proven-safe capabilities, never the union (ADR-0019 §D6).
    pub fn capabilities(&self) -> CapabilitySet {
        self.config
            .capabilities_snapshot
            .clone()
            .unwrap_or(CapabilitySet {
                product: PRODUCT.to_owned(),
                product_version: DEFAULT_CAPABILITY_VERSION.to_owned(),
                protocol: "cognitum.meta-llm.http".to_owned(),
                protocol_version: "1.0".to_owned(),
                features: HashMap::new(),
                limitations: vec!["no capabilities_snapshot configured".to_owned()],
                auth_methods: Vec::new(),
                source: crate::agentic::CapabilitySource::StaticCompatibilityTable,
            })
    }

    /// Dependency readiness for a named feature. Fails closed: no readiness
    /// endpoint is published yet (ADR-0024a §D1: "when published").
    #[allow(clippy::result_large_err)]
    pub async fn ready(&self, feature: &str) -> Result<(), AgenticError> {
        Err(unsupported(
            "ready",
            format!(
                "ready(\"{feature}\") is unsupported: no readiness endpoint is \
                 published for meta-llm yet"
            ),
        ))
    }

    // ---------------------------------------------------------------------
    // D3: protocol-specific wire types only this pass — placeholders below
    // ---------------------------------------------------------------------

    /// `POST /v1/chat/completions` (OpenAI-style). Real HTTP call logic
    /// (issue #58 / M2 continuation): idempotency-key generation, bounded
    /// 429/502/503 retry, and a single 401-refresh — see `./nonstream.rs`.
    /// Streaming (`request.stream = Some(true)`) is not validated against
    /// here — this pass only implements the nonstream path (§D5 is a
    /// follow-up issue).
    #[allow(clippy::result_large_err)]
    pub async fn chat_completions(
        &self,
        request: &ChatCompletionRequest,
    ) -> Result<MetaLlmResult<ChatCompletion>, AgenticError> {
        assert_routing_controls_sendable("chat_completions", request.routing_controls.as_ref())?;
        let body = serde_json::to_value(request).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("chat_completions".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("chat_completions request failed to serialize: {cause}"),
            )
        })?;
        let (data, meta) = self
            .post_json_idempotent("/v1/chat/completions", "chat_completions", body)
            .await?;
        let parsed: ChatCompletion = serde_json::from_value(data).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("chat_completions".to_owned()),
            request_id: Some(meta.request_id.clone()),
            ..AgenticError::new(
                AgenticErrorKind::Protocol,
                format!("chat_completions response did not match the expected shape: {cause}"),
            )
        })?;
        Ok(MetaLlmResult {
            data: parsed,
            meta,
        })
    }

    /// `POST /v1/chat/completions` with `stream: true` (ADR-0024a §D5).
    /// Issue #58 / M2 continuation — the first protocol wired onto the
    /// generic SSE parser (`crate::sse`); Anthropic Messages and Responses
    /// streaming are deferred follow-ups that reuse the same parser.
    /// Returns a [`ChatCompletionsStream`] — pull events with
    /// `next_envelope().await` in a `while let Some(envelope) = ...` loop
    /// (see `super::stream`'s module docs for why this isn't a
    /// `futures::Stream`). The stream completes successfully only after
    /// observing the OpenAI wire terminal condition (`[DONE]` or a
    /// `finish_reason`); otherwise `next_envelope` returns a typed
    /// `AgenticError` describing why.
    #[allow(clippy::result_large_err)]
    pub async fn chat_completions_stream(
        &self,
        request: &ChatCompletionRequest,
        time_budget: Option<TimeBudget>,
        cancellation: Option<Arc<dyn CancellationToken>>,
    ) -> Result<ChatCompletionsStream, AgenticError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        stream::chat_completions_stream(self, request, request_id, time_budget, cancellation).await
    }

    /// `POST /v1/completions` (legacy OpenAI completions). Real HTTP call
    /// logic (issue #58 / M2 continuation) — this is a "direct nonstream
    /// call whose accepted contract declares safe replay" per ADR-0024a
    /// §D7, the same class as `chat_completions`/`messages_create`, so it
    /// reuses `post_json_idempotent` from `./nonstream.rs` verbatim.
    #[allow(clippy::result_large_err)]
    pub async fn completions(
        &self,
        request: &LegacyCompletionRequest,
    ) -> Result<MetaLlmResult<LegacyCompletion>, AgenticError> {
        assert_routing_controls_sendable("completions", request.routing_controls.as_ref())?;
        let body = serde_json::to_value(request).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("completions".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("completions request failed to serialize: {cause}"),
            )
        })?;
        let (data, meta) = self
            .post_json_idempotent("/v1/completions", "completions", body)
            .await?;
        let parsed: LegacyCompletion =
            serde_json::from_value(data).map_err(|cause| AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some("completions".to_owned()),
                request_id: Some(meta.request_id.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Protocol,
                    format!("completions response did not match the expected shape: {cause}"),
                )
            })?;
        Ok(MetaLlmResult {
            data: parsed,
            meta,
        })
    }

    /// `POST /v1/messages` (Anthropic-style). Real HTTP call logic (issue
    /// #58 / M2 continuation) — see `chat_completions`'s doc comment and
    /// `./nonstream.rs` for the shared idempotency/retry logic.
    #[allow(clippy::result_large_err)]
    pub async fn messages_create(
        &self,
        request: &AnthropicMessageRequest,
    ) -> Result<MetaLlmResult<AnthropicMessage>, AgenticError> {
        assert_routing_controls_sendable("messages_create", request.routing_controls.as_ref())?;
        let body = serde_json::to_value(request).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("messages_create".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("messages_create request failed to serialize: {cause}"),
            )
        })?;
        let (data, meta) = self
            .post_json_idempotent("/v1/messages", "messages_create", body)
            .await?;
        let parsed: AnthropicMessage = serde_json::from_value(data).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("messages_create".to_owned()),
            request_id: Some(meta.request_id.clone()),
            ..AgenticError::new(
                AgenticErrorKind::Protocol,
                format!("messages_create response did not match the expected shape: {cause}"),
            )
        })?;
        Ok(MetaLlmResult {
            data: parsed,
            meta,
        })
    }

    /// `POST /v1/messages/count_tokens`. Same "direct nonstream call"
    /// class as `messages_create` (ADR-0024a §D7) — reuses
    /// `post_json_idempotent` verbatim.
    #[allow(clippy::result_large_err)]
    pub async fn messages_count_tokens(
        &self,
        request: &CountTokensRequest,
    ) -> Result<MetaLlmResult<CountTokensResult>, AgenticError> {
        let body = serde_json::to_value(request).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("messages_count_tokens".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("messages_count_tokens request failed to serialize: {cause}"),
            )
        })?;
        let (data, meta) = self
            .post_json_idempotent("/v1/messages/count_tokens", "messages_count_tokens", body)
            .await?;
        let parsed: CountTokensResult =
            serde_json::from_value(data).map_err(|cause| AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some("messages_count_tokens".to_owned()),
                request_id: Some(meta.request_id.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Protocol,
                    format!(
                        "messages_count_tokens response did not match the expected shape: {cause}"
                    ),
                )
            })?;
        Ok(MetaLlmResult {
            data: parsed,
            meta,
        })
    }

    /// `POST /v1/responses`. Current server is stateless: callers resend
    /// conversation input. `previous_response_id` is preview and MUST NOT
    /// be described as recovery (ADR-0024a §D3) — this method does not
    /// restore or synthesize any prior conversation state; it only sends
    /// `request` as given. Real HTTP call logic (issue #58 / M2
    /// continuation) reuses `post_json_idempotent` verbatim, same as
    /// `chat_completions`.
    #[allow(clippy::result_large_err)]
    pub async fn responses(
        &self,
        request: &ResponsesRequest,
    ) -> Result<MetaLlmResult<ResponsesResponse>, AgenticError> {
        assert_routing_controls_sendable("responses", request.routing_controls.as_ref())?;
        let body = serde_json::to_value(request).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("responses".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("responses request failed to serialize: {cause}"),
            )
        })?;
        let (data, meta) = self
            .post_json_idempotent("/v1/responses", "responses", body)
            .await?;
        let parsed: ResponsesResponse =
            serde_json::from_value(data).map_err(|cause| AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some("responses".to_owned()),
                request_id: Some(meta.request_id.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Protocol,
                    format!("responses response did not match the expected shape: {cause}"),
                )
            })?;
        Ok(MetaLlmResult {
            data: parsed,
            meta,
        })
    }

    /// `POST /v1/embeddings`. Real HTTP call logic (issue #58 / M2
    /// continuation) reuses `post_json_idempotent` verbatim —
    /// infrastructure is identical to the other direct nonstream
    /// operations even though embeddings has its own separate maturity
    /// gate criteria in ADR-0024a §D2 ("input limits, dimensions, usage,
    /// errors and auth published").
    #[allow(clippy::result_large_err)]
    pub async fn embeddings(
        &self,
        request: &EmbeddingRequest,
    ) -> Result<MetaLlmResult<EmbeddingResponse>, AgenticError> {
        let body = serde_json::to_value(request).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("embeddings".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("embeddings request failed to serialize: {cause}"),
            )
        })?;
        let (data, meta) = self
            .post_json_idempotent("/v1/embeddings", "embeddings", body)
            .await?;
        let parsed: EmbeddingResponse =
            serde_json::from_value(data).map_err(|cause| AgenticError {
                product: Some(PRODUCT.to_owned()),
                operation: Some("embeddings".to_owned()),
                request_id: Some(meta.request_id.clone()),
                ..AgenticError::new(
                    AgenticErrorKind::Protocol,
                    format!("embeddings response did not match the expected shape: {cause}"),
                )
            })?;
        Ok(MetaLlmResult {
            data: parsed,
            meta,
        })
    }

    /// Close local connections and wait only. Never cancels a remote
    /// operation, stops a pod, releases a reservation, or revokes a
    /// credential (ADR-0024a §D1).
    ///
    /// `reqwest::Client` has no explicit close/drain step, so this is a
    /// no-op reserved for a future transport that needs one.
    pub async fn close(&self) {}
}
