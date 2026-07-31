//! `MetaProxyClient` (ADR-0025a). Issue #61 / M3 start.
//!
//! This pass implements exactly §D1 (public topology — only `status` and
//! `capabilities` exist as methods this pass; every other §D1 surface —
//! `chat`, `messages`, `models`, `whoami`, `preview.sponsored.*`,
//! `preview.routing` — is deliberately NOT declared yet, rather than
//! stubbed with a placeholder, since their construction depends on §D6
//! (auth), §D7 (forwarding), §D9 (consent/sponsor), and §D5 (routing)
//! groundwork that is out of scope here), §D2 (maturity — everything below
//! is preview; see the struct doc comment), §D3 (construction, zero I/O),
//! and §D4 (`status()`/`capabilities()` as real HTTP calls against the
//! local sidecar's `/status` route, decoding the plane-evidence fields §D4
//! specifies).
//!
//! Construction mirrors `MetaLlmClient`'s conventions exactly
//! (`crate::meta_llm::client`): a resolved config struct, an injectable
//! `reqwest::Client`, a shared `CredentialProvider` for auth, and the same
//! telemetry-hook / request-ID / error-mapping shape. The one structural
//! difference is D3's own explicit instruction: `MetaProxyResult`/
//! `MetaProxyResponseMeta` are their OWN envelope, not a reuse of
//! `MetaLlmResult` — see `super::envelope`'s doc comment for why.
//!
//! Deferred to follow-up M3 passes (see issue #61 and ADR-0025a):
//!  - §D5 data-plane and policy model (`RoutingIntent`, plane/policy rules) —
//!    implemented (`super::routing`);
//!  - §D6 authentication and workload capabilities beyond the minimal
//!    `CredentialProvider` this pass's constructor accepts;
//!  - §D7 inference/forwarding contract (`chat_completions`, `messages`) —
//!    implemented (`super::forwarding`/`super::http`);
//!  - §D8 streaming, errors, cancellation, and retry for the data plane —
//!    implemented (`super::stream`);
//!  - §D9 consent, sponsor budget, and usage — the TRACTABLE slice (consent
//!    gating for the `cognitum_cloud` plane, `super::consent`) is
//!    implemented; sponsor budget/usage remain BLOCKED on ADR-0025b's
//!    lifecycle/state fixes and are explicitly out of scope (see
//!    `sponsored_chat_completions` below);
//!  - §D10 loopback and browser security — loopback-origin validation
//!    (`super::config::resolve_config`) is implemented; browser-runtime
//!    rejection is N/A (no wasm32/browser target exists for this crate's
//!    `meta-proxy` feature); non-loopback remote exposure remains dangerous
//!    preview, unimplemented by design.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::agentic::{
    AgenticError, AgenticErrorKind, CancellationToken, CapabilitySet, CapabilitySource,
    UnsupportedCapabilityError,
};
use crate::meta_llm::types::openai::{ChatCompletion, ChatCompletionRequest};

use super::config::{build_default_transport, resolve_config, MetaProxyClientConfig};
use super::consent::assert_consent_for_routing_intent;
use super::envelope::MetaProxyResult;
use super::forwarding::MetaProxyChatCallOptions;
use super::routing::assert_routing_receipt_matches_intent;
use super::status::MetaProxyStatus;
use super::stream::{chat_completions_stream, MetaProxyChatCompletionsStream};
use super::time_budget::ProxyTimeBudget;
use super::{DEFAULT_CAPABILITY_VERSION, PRODUCT};

/// `capabilities()` result shape — the shared `CapabilitySet` (ADR-0019
/// §D6) plus the Proxy-specific plane evidence ADR-0025a §D4 says
/// `capabilities()` must be able to expose alongside it.
#[derive(Debug, Clone)]
pub struct CapabilitiesResult {
    pub capabilities: CapabilitySet,
    pub compatible_sdk_range: Option<String>,
    pub configured_plane: Option<String>,
    pub selected_plane: Option<String>,
}

fn pick_string(map: &HashMap<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str()).map(str::to_owned)
}

fn parse_status(data: Value) -> MetaProxyStatus {
    let obj: HashMap<String, Value> = data
        .as_object()
        .map(|m| m.clone().into_iter().collect())
        .unwrap_or_default();
    let known = MetaProxyStatus::known_keys();
    let raw: HashMap<String, Value> = obj
        .iter()
        .filter(|(k, _)| !known.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let limitations = obj
        .get("limitations")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    MetaProxyStatus {
        product_version: pick_string(&obj, "product_version").unwrap_or_default(),
        protocol_version: pick_string(&obj, "protocol_version"),
        compatible_sdk_range: pick_string(&obj, "compatible_sdk_range"),
        process_state: pick_string(&obj, "process_state").unwrap_or_else(|| "unknown".to_owned()),
        bind: pick_string(&obj, "bind"),
        configured_plane: pick_string(&obj, "configured_plane").unwrap_or_default(),
        selected_plane: pick_string(&obj, "selected_plane").unwrap_or_default(),
        routing_reason: pick_string(&obj, "routing_reason"),
        automatic_usage_state: pick_string(&obj, "automatic_usage_state"),
        utilization: obj.get("utilization").and_then(|v| v.as_f64()),
        reset_at: pick_string(&obj, "reset_at"),
        workload_policy: pick_string(&obj, "workload_policy"),
        sponsored_available: obj.get("sponsored_available").and_then(|v| v.as_bool()),
        cloud_credential_source: pick_string(&obj, "cloud_credential_source"),
        limitations,
        request_id: pick_string(&obj, "request_id").unwrap_or_default(),
        raw,
    }
}

/// Client for an already-running, authenticated, loopback Meta Proxy
/// sidecar (ADR-0025a). Independent of `MetaProxyManager` (ADR-0025b) —
/// construction never starts, installs, authenticates, probes, or
/// reconfigures a process (ADR-0025a §D1).
///
/// Every method on this struct is `preview` maturity (ADR-0025a §D2: "All
/// current methods begin preview until a complete contract bundle
/// exists"). `status`/`capabilities` are the group with a defined path to
/// `Stable` ("Versioned schema, plane evidence, limitations, and
/// compatibility range published") but have not reached it yet — no D11 GA
/// gate has passed.
#[derive(Debug)]
pub struct MetaProxyClient {
    pub(super) config: MetaProxyClientConfig,
    pub(super) http: reqwest::Client,
}

impl MetaProxyClient {
    /// Construct a client. Validates configuration only — no I/O.
    #[allow(clippy::result_large_err)]
    pub fn new(config: MetaProxyClientConfig) -> Result<Self, AgenticError> {
        let resolved = resolve_config(config)?;
        // ADR-0025a §D6/§D10: when no transport is injected, build the
        // explicitly hardened one (proxy-env-ignoring, redirect-rejecting)
        // rather than `reqwest::Client::default()`, whose safety depends on
        // reqwest's defaults staying unchanged.
        let http = match resolved.transport.clone() {
            Some(client) => client,
            None => build_default_transport()?,
        };
        Ok(Self {
            config: resolved,
            http,
        })
    }

    /// Read-only view of the effective configuration.
    pub fn config(&self) -> &MetaProxyClientConfig {
        &self.config
    }

    /// `GET /status` — authenticated local runtime and routing state
    /// (ADR-0025a Context, §D4). `proxy_token_valid: true` (surfaced only
    /// as a successful auth, never as a raw token) means only that auth
    /// succeeded — this method never returns tokens, keys, OAuth data,
    /// unsafe paths, or full account identifiers (§D4).
    #[allow(clippy::result_large_err)]
    pub async fn status(&self) -> Result<MetaProxyResult<MetaProxyStatus>, AgenticError> {
        let (data, meta) = self.get_json("/status", "status").await?;
        Ok(MetaProxyResult {
            data: parse_status(data),
            meta,
        })
    }

    /// Versioned behavior safe for this caller (ADR-0025a §D4:
    /// "`capabilities()` uses an authenticated endpoint when available.
    /// Until then it uses exact tested `/status` schema plus ADR-0020's
    /// pinned compatibility table. It never discovers support by sending a
    /// prompt."). No dedicated `/capabilities` route is published, so this
    /// calls the same authenticated `/status` endpoint `status()` uses and
    /// merges it with `config.capabilities_snapshot` — it never sends an
    /// inference request to probe support.
    #[allow(clippy::result_large_err)]
    pub async fn capabilities(&self) -> Result<MetaProxyResult<CapabilitiesResult>, AgenticError> {
        let status_result = self.status().await?;
        let status = status_result.data;
        let mut meta = status_result.meta;
        let snapshot = self.config.capabilities_snapshot.as_ref();

        let mut warnings = meta.warnings.clone().unwrap_or_default();
        if let Some(expected) = self.config.expected_proxy_version.as_ref() {
            if expected != &status.product_version {
                warnings.push(format!(
                    "expected_proxy_version \"{expected}\" does not match the Proxy's \
                     reported product_version \"{}\" (ADR-0025a §D2: unknown versions \
                     receive a minimum-safe set)",
                    status.product_version
                ));
            }
        }

        let mut limitations = status.limitations.clone();
        if let Some(snapshot) = snapshot {
            limitations.extend(snapshot.limitations.clone());
        }

        let capabilities = CapabilitySet {
            product: PRODUCT.to_owned(),
            product_version: if status.product_version.is_empty() {
                DEFAULT_CAPABILITY_VERSION.to_owned()
            } else {
                status.product_version.clone()
            },
            protocol: snapshot
                .map(|s| s.protocol.clone())
                .unwrap_or_else(|| "cognitum.meta-proxy.http".to_owned()),
            protocol_version: status.protocol_version.clone().unwrap_or_else(|| {
                snapshot
                    .map(|s| s.protocol_version.clone())
                    .unwrap_or_else(|| "1.0".to_owned())
            }),
            features: snapshot.map(|s| s.features.clone()).unwrap_or_default(),
            limitations,
            auth_methods: snapshot.map(|s| s.auth_methods.clone()).unwrap_or_default(),
            source: CapabilitySource::Server,
        };

        meta.warnings = if warnings.is_empty() {
            None
        } else {
            Some(warnings)
        };

        Ok(MetaProxyResult {
            data: CapabilitiesResult {
                capabilities,
                compatible_sdk_range: status.compatible_sdk_range,
                configured_plane: Some(status.configured_plane),
                selected_plane: Some(status.selected_plane),
            },
            meta,
        })
    }

    /// `POST /v1/chat/completions` forwarded through the local Proxy
    /// (ADR-0025a §D7). Reuses `meta_llm`'s OpenAI wire types verbatim
    /// ([`ChatCompletionRequest`]/[`ChatCompletion`]) — permitted wire-primitive
    /// sharing per ADR-0019 §D7 — but stays a Proxy method that returns a Proxy
    /// [`MetaProxyResult`] carrying a routing receipt, never a Meta LLM result.
    ///
    /// Behavior:
    ///  - fails closed with `Authentication` before any HTTP call when no
    ///    `local_credential_provider` is configured (the local `/v1/*` routes
    ///    are authenticated, like `/status`);
    ///  - attaches ONLY the §D7 allowlisted forwarding headers from
    ///    `options.forward_headers` — a caller-supplied `Authorization`, local
    ///    bearer, `Host`, `Content-Length`, sponsor/identity/consent marker,
    ///    etc. is never forwarded (see [`MetaProxyChatCallOptions`]);
    ///  - after a successful decode, when the caller supplied a
    ///    [`RoutingIntent`](super::routing::RoutingIntent) with `required_plane`
    ///    set, verifies the response's routing receipt matches it (§D5 rule 7) —
    ///    a mismatch (or a missing receipt) is a non-retryable `Protocol` error
    ///    even on an otherwise-successful 200.
    ///
    /// Idempotency and the single 401-refresh reuse a Proxy-local POST loop in
    /// `super::http` — NOT `meta_llm`'s `post_json_idempotent`, which is client
    /// behavior `ADR-0019 §D4` keeps product-private (only wire types are shared).
    /// Unlike that Meta LLM helper, this loop never bounded-retries a
    /// 429/502/503: ADR-0025a §D8 rules out automatic Proxy POST retry because
    /// the currently-deployed Proxy drops `Idempotency-Key` server-side, so a
    /// non-2xx is always a single terminal error (see `super::http`'s
    /// `post_json_forwarding` for the full rationale).
    #[allow(clippy::result_large_err)]
    pub async fn chat_completions(
        &self,
        request: &ChatCompletionRequest,
        options: Option<MetaProxyChatCallOptions>,
    ) -> Result<MetaProxyResult<ChatCompletion>, AgenticError> {
        let options = options.unwrap_or_default();

        // ADR-0025a §D9: fail closed on missing consent BEFORE any HTTP I/O
        // — a valid local bearer credential is never a substitute for the
        // ADR-0022 consent grant a cognitum_cloud RoutingIntent requires.
        assert_consent_for_routing_intent(
            options.routing_intent.as_ref(),
            &self.config.consent_grants,
            &self.config.origin,
            "chat_completions",
        )?;

        let body = serde_json::to_value(request).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("chat_completions".to_owned()),
            ..AgenticError::new(
                AgenticErrorKind::Validation,
                format!("chat_completions request failed to serialize: {cause}"),
            )
        })?;

        let (data, meta) = self
            .post_json_forwarding("/v1/chat/completions", "chat_completions", body, &options)
            .await?;

        // §D5 rule 7: a required_plane mismatch is a protocol violation even on
        // a 200. When a required plane is set the receipt is the only evidence
        // of the selected plane, so its absence is itself a violation.
        if options
            .routing_intent
            .as_ref()
            .and_then(|i| i.required_plane)
            .is_some()
        {
            match meta.routing_receipt.as_ref() {
                Some(receipt) => {
                    assert_routing_receipt_matches_intent(options.routing_intent.as_ref(), receipt)?;
                }
                None => {
                    return Err(AgenticError {
                        product: Some(PRODUCT.to_owned()),
                        operation: Some("chat_completions".to_owned()),
                        request_id: Some(meta.request_id.clone()),
                        ..AgenticError::new(
                            AgenticErrorKind::Protocol,
                            "caller required a specific routing plane but the response carried \
                             no routing receipt to verify it against (ADR-0025a §D5 rule 7 / §D7)"
                                .to_owned(),
                        )
                    });
                }
            }
        }

        let parsed: ChatCompletion = serde_json::from_value(data).map_err(|cause| AgenticError {
            product: Some(PRODUCT.to_owned()),
            operation: Some("chat_completions".to_owned()),
            request_id: Some(meta.request_id.clone()),
            ..AgenticError::new(
                AgenticErrorKind::Protocol,
                format!("chat_completions response did not match the expected shape: {cause}"),
            )
        })?;
        Ok(MetaProxyResult {
            data: parsed,
            meta,
        })
    }

    /// `POST /v1/chat/completions` through the Proxy with `stream: true`
    /// (ADR-0025a §D8, M3 continuation of issue #61). Returns a
    /// [`MetaProxyChatCompletionsStream`] to pull events from with
    /// [`MetaProxyChatCompletionsStream::next_envelope`]. See
    /// `super::stream::chat_completions_stream` for the full streaming
    /// contract (reused SSE parser/decoder, `ProxyTimeBudget`, no
    /// auto-retry, required-plane verification on the terminal receipt).
    #[allow(clippy::result_large_err)]
    pub async fn chat_completions_stream(
        &self,
        request: &ChatCompletionRequest,
        options: Option<MetaProxyChatCallOptions>,
        time_budget: Option<ProxyTimeBudget>,
        cancellation: Option<Arc<dyn CancellationToken>>,
    ) -> Result<MetaProxyChatCompletionsStream, AgenticError> {
        chat_completions_stream(self, request, options, time_budget, cancellation).await
    }

    /// `preview.sponsored.chat_completions` (ADR-0025a §D1 topology, §D9
    /// preview maturity). Sponsored forwarding itself (budget, receipts,
    /// atomic spend) is explicitly OUT of scope this pass (§D9 defers to
    /// ADR-0025b's lifecycle/state fixes) — this method exists ONLY to
    /// fail fast, with zero HTTP I/O, per §D1 ("Such a call returns
    /// `UnsupportedCapabilityError` before HTTP I/O") and §D8 ("Sponsored
    /// `stream = true` fails locally until an end-to-end stream capability
    /// exists"). Streaming and non-streaming sponsored calls both fail
    /// this pass; the error message distinguishes the two so a caller who
    /// only hit the streaming restriction isn't told sponsor support is
    /// entirely absent when non-stream sponsor lands in a later pass.
    #[allow(clippy::result_large_err, clippy::unused_async)]
    pub async fn sponsored_chat_completions(
        &self,
        request: &ChatCompletionRequest,
    ) -> Result<ChatCompletion, AgenticError> {
        if request.stream == Some(true) {
            return Err(UnsupportedCapabilityError::new(
                PRODUCT,
                "preview.sponsored.chat_completions",
                "sponsored-inference-streaming",
            )
            .into());
        }
        Err(UnsupportedCapabilityError::new(
            PRODUCT,
            "preview.sponsored.chat_completions",
            "sponsored-inference",
        )
        .into())
    }

    /// Close local connections and wait only. Never stops the sidecar
    /// process (ADR-0025a §D3: "Closing it releases connections only and
    /// never stops the sidecar."). `reqwest::Client` has no explicit
    /// close/drain step, so this is a no-op reserved for a future
    /// transport that needs one.
    pub async fn close(&self) {}
}
