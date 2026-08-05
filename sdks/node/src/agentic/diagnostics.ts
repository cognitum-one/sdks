/**
 * `DiagnosticPolicy` / manifest-preview scaffolding (ADR-0028 §D10).
 * Tracking issue #70 (M6). This pass freezes the policy/manifest/bundle
 * shapes and implements the one piece of real logic §D10 actually
 * specifies at this layer -- "the SDK previews a manifest of categories
 * before capture" -- as a pure computation over a caller-supplied policy.
 *
 * Explicitly NOT in scope for this pass (matching the discipline already
 * established by `./telemetry.ts`'s `TelemetrySink` freeze and
 * `./receipts.ts`'s `ExecutionReceipt` freeze):
 * - no real capture/collection logic (no reading of prompts, source,
 *   patches, tool arguments, or environment values from anywhere);
 * - no upload logic -- per §D10, "Upload is a separate source-upload
 *   consent operation; capture never uploads automatically";
 * - no product client (meta_llm/meta_proxy/metaharness/harnessaas)
 *   references any symbol in this module yet.
 *
 * Sources: docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md
 * §D10 (lines 325-343), reusing the §D12/§D13 `D12Category` taxonomy
 * already frozen in `./sentinel.ts`.
 */

import type { D12Category } from "./sentinel.js";

/**
 * Where a captured diagnostic bundle is written (ADR-0028 §D10: "local
 * sink path or callback"). The `callback` variant is a marker discriminant
 * only: this pass has no real capture pipeline to invoke a callback from,
 * so it does not model an actual callback function type (design decision,
 * not an ADR quote) -- a future capture implementation attaches a real
 * callback type to this variant. Discriminated on `kind` so the wire shape
 * is `{ kind: "local_path", path: "..." }` / `{ kind: "callback" }`.
 */
export type DiagnosticSink = { kind: "local_path"; path: string } | { kind: "callback" };

/**
 * Retention/expiry policy for a captured diagnostic bundle (ADR-0028 §D10
 * "retention/expiry" bullet). `maxAgeMs: undefined` means the caller has
 * not declared a retention bound in this pass -- no enforcement exists yet
 * (no capture pipeline exists to enforce it against).
 */
export interface RetentionPolicy {
  maxAgeMs?: number;
}

/**
 * Caller-declared diagnostic-capture policy (ADR-0028 §D10). Every field
 * maps directly onto one bullet of the ADR's list:
 * - `includedFields` <- "included schema-classified fields". No validation
 *   against a real field schema/registry exists in this pass (design
 *   decision, not an ADR quote) -- this is a plain caller-supplied list of
 *   field names the policy scopes capture to.
 * - `maxBytes` / `maxDurationMs` <- "maximum bytes and duration".
 * - `sink` <- "local sink path or callback".
 * - `encryptionRequired` / `accessExpectation` <- "encryption and access
 *   expectations". The ADR does not specify a structured shape here, so a
 *   boolean + free-text string is a deliberately simple, honest
 *   simplification (design decision, not an ADR quote).
 * - `retention` <- "retention/expiry".
 * - `allowedCategories` <- "whether prompt, output, source, patch, tool,
 *   and environment categories are individually allowed". Reuses the
 *   existing {@link D12Category} taxonomy (`./sentinel.ts`) rather than a
 *   parallel type -- see {@link D10_RELEVANT_CATEGORIES} for the exact
 *   6-of-11 mapping from §D10's prose names onto `D12Category` values.
 *
 * Constructing a `DiagnosticPolicy` performs no I/O, capture, or schema
 * validation -- it is a plain value type, mirroring how `TelemetrySink`
 * (`./telemetry.ts`) was frozen as an interface before any real emission
 * pipeline existed.
 */
export interface DiagnosticPolicy {
  includedFields: string[];
  maxBytes: number;
  maxDurationMs: number;
  sink: DiagnosticSink;
  encryptionRequired: boolean;
  accessExpectation?: string;
  retention: RetentionPolicy;
  allowedCategories: Set<D12Category>;
}

/**
 * Validate a diagnostic policy before any future capture pipeline consumes
 * it.  Capture is fail-closed: malformed limits, empty field names, or an
 * invalid sink path are rejected rather than silently broadening collection.
 * This remains a pure check and performs no filesystem or network I/O.
 */
export function validateDiagnosticPolicy(policy: DiagnosticPolicy): void {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0) {
    throw new TypeError("DiagnosticPolicy.maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.maxDurationMs) || policy.maxDurationMs <= 0) {
    throw new TypeError("DiagnosticPolicy.maxDurationMs must be a positive safe integer");
  }
  if (policy.retention.maxAgeMs !== undefined &&
      (!Number.isSafeInteger(policy.retention.maxAgeMs) || policy.retention.maxAgeMs <= 0)) {
    throw new TypeError("DiagnosticPolicy.retention.maxAgeMs must be a positive safe integer");
  }
  if (!Array.isArray(policy.includedFields) ||
      policy.includedFields.some((field) => typeof field !== "string" || field.trim().length === 0)) {
    throw new TypeError("DiagnosticPolicy.includedFields must contain non-empty field names");
  }
  if (policy.sink.kind === "local_path" && policy.sink.path.trim().length === 0) {
    throw new TypeError("DiagnosticPolicy.sink.path must be non-empty");
  }
  if (!(policy.allowedCategories instanceof Set)) {
    throw new TypeError("DiagnosticPolicy.allowedCategories must be a Set");
  }
}

/**
 * The 6 of {@link D12Category}'s 11 values that §D10 governs, in the ADR's
 * own prose order ("prompt, output, source, patch, tool, and environment
 * categories"). This mapping is a design decision, not a literal ADR
 * quote, since §D10 uses its own short names rather than the §D12/§D13
 * category names:
 * - prompt -> `"prompts"`
 * - output -> `"messages"`
 * - source -> `"source"`
 * - patch -> `"patches"`
 * - tool -> `"tool-arguments-results"`
 * - environment -> `"environment-values"`
 */
export const D10_RELEVANT_CATEGORIES: readonly D12Category[] = [
  "prompts",
  "messages",
  "source",
  "patches",
  "tool-arguments-results",
  "environment-values",
];

/**
 * Hard-coded, policy-independent never-capturable set (ADR-0028 §D10):
 * "Credentials, signing private keys, proxy tokens, cookies, repository
 * credentials, and pre-signed URLs are never capturable." `D12Category` has
 * no finer split than `"credentials"` for signing keys, proxy tokens,
 * cookies, and repository credentials -- all are secret-bearing
 * authentication material, matching §D13's own key-name rule, which
 * already classifies "secret", "token", "password", "accesskey" fields as
 * `"credentials"` regardless of which specific kind of credential they
 * hold; there is no separate signing-keys/proxy-tokens/cookies category to
 * map onto. `"signed-urls"` covers pre-signed URLs directly. This mapping
 * is a design decision, not a literal ADR quote: it resolves the ADR's
 * six-item prose list onto exactly 2 `D12Category` values, not 6, because
 * the ADR's own taxonomy is coarser than its prose list.
 */
export const NEVER_CAPTURABLE_CATEGORIES: readonly D12Category[] = [
  "credentials",
  "signed-urls",
];

/**
 * Whether `category` is unconditionally excluded from capture, regardless
 * of what any {@link DiagnosticPolicy.allowedCategories} claims. This is
 * the real, enforced check backing {@link previewDiagnosticManifest}'s
 * hard block -- not merely documentation.
 */
export function isNeverCapturable(category: D12Category): boolean {
  return NEVER_CAPTURABLE_CATEGORIES.includes(category);
}

/**
 * A preview of which §D10-relevant categories a policy would and would not
 * capture (ADR-0028 §D10: "The SDK previews a manifest of categories
 * before capture").
 */
export interface DiagnosticManifest {
  wouldCapture: D12Category[];
  blockedByPolicy: D12Category[];
}

/**
 * Computes the manifest a caller would see before capture starts. Pure
 * computation over `policy` -- performs no I/O and does not read, touch,
 * or capture any real prompt/source/patch/tool/environment content.
 *
 * `wouldCapture` is the intersection of `policy.allowedCategories`
 * (restricted to {@link D10_RELEVANT_CATEGORIES}) minus
 * {@link NEVER_CAPTURABLE_CATEGORIES}. The hard block applies even if a
 * caller's policy explicitly lists `"credentials"` or `"signed-urls"` in
 * `allowedCategories` -- a policy can never override it, which is why the
 * loop below only ever iterates the 6 §D10-relevant categories (neither
 * hard-blocked category is a member of that set, so neither can ever reach
 * `wouldCapture` through this function, no matter what the policy claims).
 *
 * `blockedByPolicy` lists the §D10-relevant categories the policy did NOT
 * allow -- distinct from the hard-blocked categories, which never appear
 * in either list returned here since they are outside
 * {@link D10_RELEVANT_CATEGORIES} entirely.
 */
export function previewDiagnosticManifest(policy: DiagnosticPolicy): DiagnosticManifest {
  const wouldCapture: D12Category[] = [];
  const blockedByPolicy: D12Category[] = [];
  for (const category of D10_RELEVANT_CATEGORIES) {
    // Defensive re-check: D10_RELEVANT_CATEGORIES never contains a
    // hard-blocked category today, but this keeps the hard-block
    // invariant enforced in code (not just by the constant's current
    // contents) if that set is ever edited in a future pass.
    if (isNeverCapturable(category)) {
      continue;
    }
    if (policy.allowedCategories.has(category)) {
      wouldCapture.push(category);
    } else {
      blockedByPolicy.push(category);
    }
  }
  return { wouldCapture, blockedByPolicy };
}

/**
 * Minimal redaction-report shape (ADR-0028 §D10: "Diagnostic bundles
 * include a redaction report..."). `SentinelSecretRedactor`
 * (`./sentinel.ts`) does not currently return a report-shaped value --
 * `redact` returns the redacted value itself, not a summary of what was
 * redacted -- so this is a new minimal type, matching the "shape freeze"
 * convention already used by `ExecutionReceipt` (`./receipts.ts`): no
 * bundle-construction pipeline computes a real value for this type in this
 * pass.
 */
export interface RedactionReport {
  redactionCount: number;
  categoriesRedacted: D12Category[];
}

/**
 * Frozen diagnostic-bundle field shape (ADR-0028 §D10): "Diagnostic
 * bundles include a redaction report, SDK and contract versions, and
 * SHA-256 digest." Type-only stub, matching `ExecutionReceipt`
 * (`./receipts.ts`)'s freeze discipline -- no bundle-construction pipeline
 * exists in this pass; nothing populates a `DiagnosticBundle` from real
 * captured content, and no upload logic exists (§D10: "capture never
 * uploads automatically").
 */
export interface DiagnosticBundle {
  redactionReport: RedactionReport;
  sdkVersion: string;
  contractVersion: string;
  sha256Digest: string;
}
