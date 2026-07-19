/**
 * Meta Proxy client (ADR-0025a). Product namespace per ADR-0019 §D2:
 * `@cognitum-one/sdk/meta-proxy`.
 *
 * Issue #61 / M3 start: `MetaProxyClient` construction (§D3) and real
 * `status()` / `capabilities()` implementations (§D4). Data-plane forwarding
 * (§D5-§D9) and loopback/browser security beyond loopback-origin
 * construction validation (§D10) are deliberately out of scope — see the
 * `./client.js` module doc comment for the full deferred list.
 *
 * Per ADR-0019 §D4, this module depends on `../agentic/index.js` and MUST
 * NOT be imported by any other product module (`meta-llm`, `metaharness`,
 * `harnessaas`).
 */

export {
  DEFAULT_META_PROXY_ORIGIN,
  isBearerAttachmentAllowed,
  resolveMetaProxyClientConfig,
  __resetMetaProxyNonLoopbackWarnLatch,
} from "./config.js";
export type {
  MetaProxyClientConfig,
  MetaProxyTelemetryEvent,
  MetaProxyTelemetryHooks,
  MetaProxyTransport,
  ResolvedMetaProxyClientConfig,
} from "./config.js";

export type {
  MetaProxyResponseMeta,
  MetaProxyResult,
  MetaProxyUpstreamReceipt,
} from "./envelope.js";

export type { MetaProxyRoutingReceipt, MetaProxyStatus, RoutingPlane, WorkloadPolicy } from "./status.js";

export { assertRoutingReceiptMatchesIntent } from "./routing.js";
export type { ConsentGrantId, RoutingIntent } from "./routing.js";

export {
  DEFAULT_META_PROXY_TOKEN_ENV_VAR,
  LocalBearerTokenCredentialProvider,
} from "./auth.js";
export type {
  LocalBearerToken,
  LocalBearerTokenCredentialProviderOptions,
  ProxyCredential,
  WorkloadCapability,
  WorkloadCapabilityClaims,
} from "./auth.js";

export {
  forwardChatCompletion,
  PROXY_CHAT_FORWARD_HEADER_ALLOWLIST,
  rejectRedirectResponse,
} from "./forwarding.js";
export type { ChatForwardDeps, MetaProxyChatCallOptions } from "./forwarding.js";

export {
  DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
  resolveProxyTimeBudget,
} from "./time-budget.js";
export type { ProxyTimeBudget, ResolvedProxyTimeBudget } from "./time-budget.js";

export { forwardChatCompletionStream } from "./stream/chat-completions-stream.js";
export type { MetaProxyChatStreamCallOptions } from "./stream/chat-completions-stream.js";
export type {
  MetaProxyChatStreamEnvelope,
  MetaProxyStreamEnvelope,
  MetaProxyStreamMeta,
} from "./stream/envelope.js";

export type { CapabilitiesResult, MetaProxyCallOptions } from "./client.js";
export { MetaProxyClient } from "./client.js";
