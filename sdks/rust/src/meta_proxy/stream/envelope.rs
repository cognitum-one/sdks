//! `MetaProxyStreamEnvelope` (ADR-0025a §D8): "Chat and Messages use
//! ADR-0024a's lossless protocol streams and add plane and Proxy version
//! metadata." Rather than adding fields to the frozen `MetaLlmStreamEnvelope`
//! shape (`crate::meta_llm::stream::envelope` — "do not add fields without
//! an ADR update"), this wraps it with a `proxy_meta` facet carrying exactly
//! the Proxy-specific evidence: product/protocol version (from the response
//! headers, same as non-streaming `MetaProxyResponseMeta`) and the routing/
//! upstream receipts once observed on the wire (ADR-0025a §D4/§D7).

use crate::meta_llm::stream::{MetaLlmStreamEnvelope, OpenAiStreamEvent};

use super::super::envelope::MetaProxyUpstreamReceipt;
use super::super::status::MetaProxyRoutingReceipt;

/// Proxy-specific metadata layered onto every streamed envelope (ADR-0025a §D8).
#[derive(Debug, Clone, Default)]
pub struct MetaProxyStreamMeta {
    pub product_version: Option<String>,
    pub protocol_version: Option<String>,
    /// Plane-routing evidence observed so far on this stream (ADR-0025a
    /// §D4). `None` until the wire payload carrying
    /// `cognitum_routing_receipt` arrives (typically, but not necessarily,
    /// the terminal chunk) — once observed, every subsequently-returned
    /// envelope carries it.
    pub routing_receipt: Option<MetaProxyRoutingReceipt>,
    /// Upstream (Cognitum-cloud) usage/receipt evidence, once observed (ADR-0025a §D7/§D8).
    pub upstream_receipt: Option<MetaProxyUpstreamReceipt>,
}

/// Every streamed envelope from `MetaProxyClient::chat_completions_stream` (ADR-0025a §D8).
#[derive(Debug, Clone)]
pub struct MetaProxyStreamEnvelope {
    pub inner: MetaLlmStreamEnvelope<OpenAiStreamEvent>,
    pub proxy_meta: MetaProxyStreamMeta,
}
