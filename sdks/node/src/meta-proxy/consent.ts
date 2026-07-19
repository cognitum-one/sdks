/**
 * Consent gating for `MetaProxyClient` data-plane calls (ADR-0025a §D9).
 *
 * §D9: "Separate ADR-0022 grants cover Cognitum cloud routing, sponsor,
 * power saver, direct Anthropic, and training contribution. Credential
 * presence is not consent. Headless clients return `ConsentRequiredError`
 * rather than prompt."
 *
 * This module is intentionally narrow. Stable sponsor support is BLOCKED on
 * ADR-0025b's lifecycle/state fixes (§D9: "interprocess locking, atomic
 * replace, fail-closed corruption, schema and pricing version, server
 * reconciliation, and crash/concurrency/date/clock tests") and is NOT
 * implemented here. The one gate this pass DOES implement is the tractable
 * slice: routing to the `cognitum_cloud` plane requires a matching, unexpired
 * `cloud_fallback` consent grant (ADR-0022 §D7's kind for "routing from local
 * to Cognitum cloud") — checked BEFORE any HTTP I/O, never inferred from
 * credential presence.
 *
 * `RoutingIntent.consentGrants` (`./routing.js`) is a distinct, unrelated
 * concept: it is the opaque set of ADR-0022 grant IDs the SDK *forwards as
 * intent* to the Proxy (PR #93) — the SDK does not interpret its structure.
 * This module instead checks the caller's *locally held* `ConsentGrant`
 * objects (`MetaProxyClientConfig.consentGrants`, ADR-0022 §D7's typed shape)
 * against the plane the call's `RoutingIntent` would allow/require.
 */

import { ConsentRequiredError, type ConsentGrant } from "../agentic/index.js";
import type { RoutingIntent, RoutingPlane } from "./routing.js";

const PRODUCT = "meta-proxy";

/**
 * ADR-0022 §D7's consent-grant kind that covers Cognitum-cloud routing.
 * The ADR's kind list has no `cognitum_cloud_routing` entry; `cloud_fallback`
 * ("routing from local to Cognitum cloud") is the matching kind — it is a
 * low-stakes kind (an unsigned local record is sufficient per §D7), unlike
 * `sponsored_inference`.
 */
export const CLOUD_ROUTING_CONSENT_KIND = "cloud_fallback" as const;

/** `true` when `intent` would allow or require routing through `plane`. */
export function intentTouchesPlane(intent: RoutingIntent, plane: RoutingPlane): boolean {
  return intent.requiredPlane === plane || intent.allowedPlanes.includes(plane);
}

/**
 * `true` when `grant` is unexpired at `now` and matches `kind`/`product`/`origin`.
 * Pure, no I/O — does not verify signatures or re-attest server-persisted
 * grants (§D7's consequential-kind re-check remains a follow-up).
 */
export function isConsentGrantValid(
  grant: ConsentGrant,
  kind: ConsentGrant["kind"],
  product: string,
  origin: string,
  now: Date = new Date(),
): boolean {
  if (grant.kind !== kind) return false;
  if (grant.product !== product) return false;
  if (grant.origin !== origin) return false;
  if (grant.expiresAt !== undefined && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

/** `true` when `grants` contains at least one grant satisfying {@link isConsentGrantValid}. */
export function hasValidConsentGrant(
  grants: readonly ConsentGrant[],
  kind: ConsentGrant["kind"],
  product: string,
  origin: string,
  now?: Date,
): boolean {
  return grants.some((grant) => isConsentGrantValid(grant, kind, product, origin, now));
}

/**
 * Fail-closed gate applied BEFORE any HTTP I/O (ADR-0025a §D9). When
 * `intent` allows or requires the `cognitum_cloud` plane and `grants`
 * contains no matching, unexpired {@link CLOUD_ROUTING_CONSENT_KIND} grant
 * for `product`/`origin`, throws {@link ConsentRequiredError} — a valid
 * local bearer credential does NOT satisfy this check ("Credential presence
 * is not consent").
 *
 * A no-op when `intent` is undefined or does not touch `cognitum_cloud`.
 */
export function assertConsentForRoutingIntent(
  intent: RoutingIntent | undefined,
  grants: readonly ConsentGrant[],
  origin: string,
  operation: string,
  now?: Date,
): void {
  if (!intent) return;
  if (!intentTouchesPlane(intent, "cognitum_cloud")) return;
  if (hasValidConsentGrant(grants, CLOUD_ROUTING_CONSENT_KIND, PRODUCT, origin, now)) return;

  throw new ConsentRequiredError(
    PRODUCT,
    operation,
    CLOUD_ROUTING_CONSENT_KIND,
    `${operation}'s RoutingIntent allows or requires the "cognitum_cloud" plane, but no ` +
      `unexpired ADR-0022 "${CLOUD_ROUTING_CONSENT_KIND}" consent grant is present for ` +
      `origin "${origin}" (ADR-0025a §D9: credential presence is not consent — headless ` +
      `clients return ConsentRequiredError rather than prompt).`,
  );
}
