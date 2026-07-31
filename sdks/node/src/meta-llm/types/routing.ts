/**
 * ADR-0024b §D2: routing types and precedence. Issue #59, D11 migration
 * step 1 ("Release routing receipt and usage read-only support after
 * ADR-0024a serving").
 *
 * `ModelSelector` deliberately has NO escape hatch for a raw provider model
 * ID — `auto`, a `ModelTier`, or a contract-declared alias string are the
 * only three shapes the audited resolver accepts; anything else is rejected
 * server-side as `model_not_found` (§D2). This is a deliberate rejection,
 * not an oversight, so no fourth "raw model id" variant is added here.
 *
 * Unknown values RECEIVED from the server (e.g. a `resolved_tier` that
 * predates this SDK's enum) must be preserved rather than dropped — see
 * `../types/receipt.js`'s `ReceiptModelTier`/`ReceiptCacheResult`, which
 * widen the known union with `(string & {})` so an unrecognized wire value
 * still round-trips as a plain string instead of being coerced away.
 *
 * Values the SDK *sends*, by contrast, are validated against the closed set
 * at request time via `assertSendableRoutingControls` — §D2: "stable
 * methods cannot send them until capabilities declare support."
 *
 * Body controls win over `X-Cognitum-*` headers (§D2) — this SDK never
 * exposes a generic header-override surface for routing, safety, auth,
 * request ID, idempotency, trace, host, or content-length fields (see
 * `../nonstream.ts`/`../client.ts`: headers are built internally from typed
 * fields only), so there is no header path these controls could lose to.
 */

export type ModelTier = "low" | "mid" | "high";

export type ModelSelector =
  | { readonly kind: "auto" }
  | { readonly kind: "tier"; readonly tier: ModelTier }
  | { readonly kind: "contract_declared_alias"; readonly alias: string };

export type FallbackPolicy = "fail_fast" | "best_effort";

export type EscalationStrategy = "stream_oneshot" | "post_hoc" | "buffered" | "inflight";

export type CacheMode = "disabled" | "exact" | "semantic";

export type SafetyMode = "block" | "warn" | "redact";

/**
 * Opaque, sanitized attribution metadata (ADR-0024b §D2). Included in
 * operation/idempotency metadata where contracted, but never treated as
 * tenant, budget, rate-limit, or resource-owner authority.
 */
export type SubTenantAttribution = string;

/** ADR-0024b §D2's `MetaLlmRoutingControls`. */
export interface MetaLlmRoutingControls {
  model?: ModelSelector;
  minTier?: ModelTier;
  maxTier?: ModelTier;
  fallbackPolicy?: FallbackPolicy;
  escalation?: EscalationStrategy;
  cache?: CacheMode;
  safety?: SafetyMode;
  subTenantId?: SubTenantAttribution;
}

const MODEL_TIERS: ReadonlySet<string> = new Set<ModelTier>(["low", "mid", "high"]);
const FALLBACK_POLICIES: ReadonlySet<string> = new Set<FallbackPolicy>(["fail_fast", "best_effort"]);
const ESCALATION_STRATEGIES: ReadonlySet<string> = new Set<EscalationStrategy>([
  "stream_oneshot",
  "post_hoc",
  "buffered",
  "inflight",
]);
const CACHE_MODES: ReadonlySet<string> = new Set<CacheMode>(["disabled", "exact", "semantic"]);
const SAFETY_MODES: ReadonlySet<string> = new Set<SafetyMode>(["block", "warn", "redact"]);

/** Thrown by `assertSendableRoutingControls` — never thrown by response parsing. */
export class UnsendableRoutingControlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsendableRoutingControlsError";
  }
}

function assertSendableModelSelector(selector: ModelSelector): void {
  switch (selector.kind) {
    case "auto":
      return;
    case "tier":
      if (!MODEL_TIERS.has(selector.tier)) {
        throw new UnsendableRoutingControlsError(
          `unrecognized ModelTier in ModelSelector.tier: ${JSON.stringify(selector.tier)}`,
        );
      }
      return;
    case "contract_declared_alias":
      if (typeof selector.alias !== "string" || selector.alias.length === 0) {
        throw new UnsendableRoutingControlsError(
          "ModelSelector.contract_declared_alias requires a non-empty alias string",
        );
      }
      return;
    default: {
      // Exhaustiveness: any other `kind` — including a hypothetical raw
      // provider-model-id escape hatch — is rejected. §D2 is explicit that
      // no such escape hatch exists; the SDK fails locally rather than
      // forcing a round trip the resolver would reject as `model_not_found`.
      const unrecognized = selector as { kind: string };
      throw new UnsendableRoutingControlsError(`unrecognized ModelSelector.kind: ${JSON.stringify(unrecognized.kind)}`);
    }
  }
}

/**
 * Validates a caller-supplied `MetaLlmRoutingControls` immediately before it
 * is serialized onto the wire. Throws rather than silently sending an
 * unrecognized enum member or a raw provider model ID. Never called on data
 * received from the server — received unknown values are preserved, not
 * rejected (see `../types/receipt.js`).
 */
export function assertSendableRoutingControls(controls: MetaLlmRoutingControls | undefined): void {
  if (!controls) return;
  if (controls.model !== undefined) assertSendableModelSelector(controls.model);
  if (controls.minTier !== undefined && !MODEL_TIERS.has(controls.minTier)) {
    throw new UnsendableRoutingControlsError(`unrecognized ModelTier for minTier: ${JSON.stringify(controls.minTier)}`);
  }
  if (controls.maxTier !== undefined && !MODEL_TIERS.has(controls.maxTier)) {
    throw new UnsendableRoutingControlsError(`unrecognized ModelTier for maxTier: ${JSON.stringify(controls.maxTier)}`);
  }
  if (controls.fallbackPolicy !== undefined && !FALLBACK_POLICIES.has(controls.fallbackPolicy)) {
    throw new UnsendableRoutingControlsError(
      `unrecognized FallbackPolicy: ${JSON.stringify(controls.fallbackPolicy)}`,
    );
  }
  if (controls.escalation !== undefined && !ESCALATION_STRATEGIES.has(controls.escalation)) {
    throw new UnsendableRoutingControlsError(
      `unrecognized EscalationStrategy: ${JSON.stringify(controls.escalation)}`,
    );
  }
  if (controls.cache !== undefined && !CACHE_MODES.has(controls.cache)) {
    throw new UnsendableRoutingControlsError(`unrecognized CacheMode: ${JSON.stringify(controls.cache)}`);
  }
  if (controls.safety !== undefined && !SAFETY_MODES.has(controls.safety)) {
    throw new UnsendableRoutingControlsError(`unrecognized SafetyMode: ${JSON.stringify(controls.safety)}`);
  }
}
