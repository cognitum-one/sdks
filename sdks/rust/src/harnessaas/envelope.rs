//! Result and metadata envelope for HarnessaaSClient operations (ADR-0027a).

/// Per-response metadata carried alongside every [`HarnessaaSResult`].
#[derive(Debug, Clone)]
pub struct HarnessaaSResponseMeta {
    pub request_id: String,
    pub http_status: u16,
    pub retry_after_ms: Option<u64>,
}

/// Envelope wrapping every HarnessaaSClient operation result.
#[derive(Debug, Clone)]
pub struct HarnessaaSResult<T> {
    pub data: T,
    pub meta: HarnessaaSResponseMeta,
}
