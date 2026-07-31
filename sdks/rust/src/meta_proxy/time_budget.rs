//! `ProxyTimeBudget` (ADR-0025a §D8):
//!
//! ```text
//! ProxyTimeBudget {
//!   connect_timeout,
//!   first_byte_timeout,
//!   idle_stream_timeout,
//!   overall_deadline
//! }
//! ```
//!
//! §D8: "The process currently uses a 10-second connect timeout and no
//! overall timeout. The SDK supplies cancellation and an optional overall
//! deadline. Timing out one request never kills the Proxy." — so
//! `connect_timeout_ms` has a documented 10s default (matching the deployed
//! Proxy's own connect-timeout behavior) while `overall_deadline_ms` has NO
//! default: it is caller-supplied only, and its absence means "no overall
//! timeout" exactly as today.
//!
//! This is a Proxy-specific type distinct from ADR-0023's generic
//! `TimeBudget` (`crate::agentic`) — ADR-0025a names exactly these four
//! fields, no more — even though `super::stream::chat_completions_stream`
//! internally applies the identical "race the blocking read against the
//! smallest remaining budget" pattern PR #88 proved correct for direct
//! `MetaLlmClient` streaming.

/// Matches the Proxy's own documented connect-timeout behavior (ADR-0025a §D8, Context).
pub const DEFAULT_PROXY_CONNECT_TIMEOUT_MS: u64 = 10_000;

/// Caller-supplied time budget for one Proxy chat/Messages call (ADR-0025a §D8).
#[derive(Debug, Clone, Copy, Default)]
pub struct ProxyTimeBudget {
    /// Bounds each HTTP attempt (initial POST, and the at-most-one
    /// 401-refresh retry) from send until a response begins arriving.
    /// `None` resolves to [`DEFAULT_PROXY_CONNECT_TIMEOUT_MS`] via
    /// [`resolve_proxy_time_budget`].
    pub connect_timeout_ms: Option<u64>,
    /// Bounds the wait for the first SSE body byte after a response begins. No default.
    pub first_byte_timeout_ms: Option<u64>,
    /// Bounds the wait between subsequent SSE body bytes once streaming has started. No default.
    pub idle_stream_timeout_ms: Option<u64>,
    /// Bounds the ENTIRE call (pre-byte connect/retry phase plus the full
    /// streaming read) from the moment the caller invokes the method. No
    /// default — §D8: omission means no overall timeout, matching today's
    /// undocumented-but-real Proxy behavior.
    pub overall_deadline_ms: Option<u64>,
}

/// [`ProxyTimeBudget`] after defaulting — `connect_timeout_ms` is always present.
#[derive(Debug, Clone, Copy)]
pub struct ResolvedProxyTimeBudget {
    pub connect_timeout_ms: u64,
    pub first_byte_timeout_ms: Option<u64>,
    pub idle_stream_timeout_ms: Option<u64>,
    pub overall_deadline_ms: Option<u64>,
}

/// Apply [`DEFAULT_PROXY_CONNECT_TIMEOUT_MS`]; every other field passes through unchanged.
pub fn resolve_proxy_time_budget(budget: Option<ProxyTimeBudget>) -> ResolvedProxyTimeBudget {
    let budget = budget.unwrap_or_default();
    ResolvedProxyTimeBudget {
        connect_timeout_ms: budget
            .connect_timeout_ms
            .unwrap_or(DEFAULT_PROXY_CONNECT_TIMEOUT_MS),
        first_byte_timeout_ms: budget.first_byte_timeout_ms,
        idle_stream_timeout_ms: budget.idle_stream_timeout_ms,
        overall_deadline_ms: budget.overall_deadline_ms,
    }
}
