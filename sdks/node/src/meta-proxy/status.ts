/**
 * Status, capabilities, and plane-evidence wire types (ADR-0025a §D4).
 *
 * No service-owned OpenAPI contract exists yet for `/status` (§D11 gate #1
 * is not yet published), so `MetaProxyStatus` stays intentionally
 * permissive (`raw` passthrough for unrecognized fields), matching the same
 * convention `MetaLlmClient`'s discovery types use
 * (`../meta-llm/discovery.js`) for the same reason.
 *
 * `RoutingPlane` and `WorkloadPolicy` are formally defined in §D5 (data-plane
 * and policy model), which is explicitly OUT of scope for this pass — they
 * are declared here only because §D4's `MetaProxyStatus.configuredPlane` /
 * `selectedPlane` / `workloadPolicy` fields reference them. No routing,
 * consent, or plane-selection LOGIC from §D5 is implemented here.
 */

/**
 * The plane an inference request is (or would be) routed through
 * (ADR-0025a §D5). Reference-only in this pass — no plane-selection logic
 * is implemented; `MetaProxyStatus` fields that carry a plane are typed as
 * plain `string` (see its doc comment) rather than this union, consistent
 * with "no contract yet" fields elsewhere.
 */
export type RoutingPlane =
  | "local"
  | "cognitum_cloud"
  | "anthropic_passthrough"
  | "sponsored_cognitum";

/** Workload urgency classification (ADR-0025a §D5). Reference-only this pass. */
export type WorkloadPolicy = "critical" | "standard" | "economy";

/**
 * `status()` response (ADR-0025a §D4). `configuredPlane`/`selectedPlane`/
 * `workloadPolicy` are typed as plain `string` rather than the
 * {@link RoutingPlane}/{@link WorkloadPolicy} unions above — the Proxy's
 * `/status` route has no published OpenAPI contract yet (§D11 gate #1), so
 * this stays permissive rather than pretending to validate a contract that
 * does not exist, matching `MetaLlmHealth`'s precedent
 * (`../meta-llm/discovery.js`). Values SHOULD be one of the documented
 * constants but the SDK does not reject an unrecognized one — it surfaces
 * it verbatim and lets the caller decide.
 */
export interface MetaProxyStatus {
  productVersion: string;
  protocolVersion?: string;
  /** SDK/protocol compatibility range, format not yet contracted (§D11 gate #2). */
  compatibleSdkRange?: string;
  processState: string;
  /** The loopback `host:port` the Proxy is bound to. */
  bind?: string;
  configuredPlane: string;
  selectedPlane: string;
  routingReason?: string;
  automaticUsageState?: string;
  utilization?: number;
  resetAt?: string;
  workloadPolicy?: string;
  sponsoredAvailable?: boolean;
  cloudCredentialSource?: string;
  limitations: string[];
  requestId: string;
  /** Unrecognized fields from the server response, preserved verbatim. */
  raw?: Record<string, unknown>;
}

/**
 * Plane-routing evidence attached to an inference response or terminal
 * stream event (ADR-0025a §D4). Reserved for §D7 (inference/forwarding
 * contract) — `status()`/`capabilities()` in this pass never construct
 * one, since a routing receipt describes an inference call's plane
 * selection, which does not exist yet. Declared now so §D4's full contract
 * is represented in the type system ahead of §D7 landing.
 */
export interface MetaProxyRoutingReceipt {
  requestId: string;
  configuredPlane: string;
  selectedPlane: string;
  routingReason?: string;
  automatic: boolean;
  workloadPolicy?: string;
  consentEvidenceId?: string;
  upstreamReceipt?: unknown;
  localUsage?: Record<string, unknown>;
  degraded: boolean;
  warnings?: string[];
}
