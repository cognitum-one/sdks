/**
 * `MetaProxyStreamEnvelope<E>` (ADR-0025a §D8): "Chat and Messages use
 * ADR-0024a's lossless protocol streams and add plane and Proxy version
 * metadata." Rather than adding fields to the frozen `MetaLlmStreamEnvelope`
 * shape (`../../meta-llm/stream/envelope.js` — "do not add fields without an
 * ADR update"), this wraps it with a `proxyMeta` facet carrying exactly the
 * Proxy-specific evidence: product/protocol version (from the response
 * headers, same as non-streaming `MetaProxyResponseMeta`) and the routing/
 * upstream receipts once observed on the wire (ADR-0025a §D4/§D7).
 */

import type { MetaLlmStreamEnvelope } from "../../meta-llm/stream/envelope.js";
import type { OpenAiStreamEvent } from "../../meta-llm/stream/openai-events.js";
import type { MetaProxyUpstreamReceipt } from "../envelope.js";
import type { MetaProxyRoutingReceipt } from "../status.js";

/** Proxy-specific metadata layered onto every streamed envelope (ADR-0025a §D8). */
export interface MetaProxyStreamMeta {
  productVersion?: string;
  protocolVersion?: string;
  /**
   * Plane-routing evidence observed so far on this stream (ADR-0025a §D4).
   * `undefined` until the wire payload carrying `cognitum_routing_receipt`
   * arrives (typically, but not necessarily, the terminal chunk) — once
   * observed, every subsequently-yielded envelope carries it.
   */
  routingReceipt?: MetaProxyRoutingReceipt;
  /** Upstream (Cognitum-cloud) usage/receipt evidence, once observed (ADR-0025a §D7/§D8). */
  upstreamReceipt?: MetaProxyUpstreamReceipt;
}

/** Every streamed envelope from `MetaProxyClient.chat.completionsStream` (ADR-0025a §D8). */
export interface MetaProxyStreamEnvelope<E> extends MetaLlmStreamEnvelope<E> {
  proxyMeta: MetaProxyStreamMeta;
}

/** The concrete envelope type `chat.completionsStream` yields. */
export type MetaProxyChatStreamEnvelope = MetaProxyStreamEnvelope<OpenAiStreamEvent>;
