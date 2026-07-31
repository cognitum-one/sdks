/**
 * Parsing for the server's 402 upgrade affordance (ADR-0023 §D1).
 *
 * The gateway returns 402 for two unrelated situations and distinguishes them
 * with `code`:
 *
 *   {"code": "upgrade_required", "required_tier": "mid", "held_tier": "low",
 *    "required_scope": "completions:mid", "upgrade_url": "...",
 *    "retry_with": {"fallback_policy": "best_effort"}}
 *
 * versus a budget 402, which carries no such affordance. Status alone cannot
 * tell them apart, and the message text must never be used to try — it is
 * prose, it is localisable, and it is redacted before callers see it.
 *
 * On the Responses and Anthropic Messages surfaces these keys ride at the top
 * level beside `error`, so one parser serves every surface.
 */

import type { UpgradeAffordance, UpgradeRetryHint } from "./errors.js";

/** The `code` value that marks a 402 as a scope shortfall rather than a spend one. */
export const UPGRADE_REQUIRED_CODE = "upgrade_required";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse an error body that may or may not be JSON.
 *
 * Returns `undefined` rather than throwing: a 402 can arrive from a proxy or
 * WAF as HTML, and an error mapper that throws while mapping an error
 * replaces a useful failure with a confusing one.
 */
export function parseErrorBody(bodyText: string): Record<string, unknown> | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseRetryHint(value: unknown): UpgradeRetryHint | undefined {
  if (!isRecord(value)) return undefined;
  // Only the fields this SDK understands are lifted out. Unrecognised keys are
  // dropped rather than preserved -- see `UpgradeRetryHint` for why carrying
  // arbitrary server JSON on a logged error object is not worth it.
  const fallbackPolicy = stringOrUndefined(value.fallback_policy);
  return fallbackPolicy === undefined ? undefined : { fallbackPolicy };
}

/**
 * Extract the upgrade affordance from a parsed error body.
 *
 * Returns `undefined` when the server sent none of the fields, so a caller can
 * treat "no affordance" and "no useful affordance" identically.
 */
export function parseUpgradeAffordance(body: Record<string, unknown> | undefined): UpgradeAffordance | undefined {
  if (!body) return undefined;
  const affordance: UpgradeAffordance = {
    requiredTier: stringOrUndefined(body.required_tier),
    heldTier: stringOrUndefined(body.held_tier),
    requiredScope: stringOrUndefined(body.required_scope),
    upgradeUrl: stringOrUndefined(body.upgrade_url),
    retryWith: parseRetryHint(body.retry_with),
  };
  return Object.values(affordance).some((field) => field !== undefined) ? affordance : undefined;
}

/** Is this 402 body a scope shortfall (as opposed to a budget one)? */
export function isUpgradeRequired(body: Record<string, unknown> | undefined): boolean {
  return body?.code === UPGRADE_REQUIRED_CODE;
}
