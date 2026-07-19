/**
 * Data-plane routing intent and decode-time verification (ADR-0025a §D5).
 *
 * This module carries the caller's *supported intent* and verifies the
 * Proxy's decision against it — it deliberately does NOT implement a router.
 * ADR-0025a §D5: "The SDK communicates supported intent and verifies the
 * decision; it does not implement another router." There is no planner, no
 * plane selector, and no failover logic here; the Proxy owns all of that.
 *
 * `RoutingPlane` / `WorkloadPolicy` are re-exported from `./status.js` (where
 * §D4 already needed them for `MetaProxyStatus`) rather than redeclared, so
 * the union types have exactly one definition across the module.
 */

import { AgenticError } from "../agentic/index.js";
import type { MetaProxyRoutingReceipt, RoutingPlane, WorkloadPolicy } from "./status.js";

export type { RoutingPlane, WorkloadPolicy } from "./status.js";

const PRODUCT = "meta-proxy";

/**
 * A consent grant is an opaque ADR-0022 grant identifier — the SDK treats it
 * as a bare string ID and does not interpret its structure (ADR-0025a §D9
 * owns consent semantics; this pass only forwards intent).
 */
export type ConsentGrantId = string;

/**
 * Supported routing intent a caller attaches to an inference call
 * (ADR-0025a §D5). The Proxy is the authority; the SDK sends this as intent
 * and verifies the returned receipt against it (see
 * {@link assertRoutingReceiptMatchesIntent}). None of these fields cause the
 * SDK to *choose* a plane.
 */
export interface RoutingIntent {
  /**
   * If set, the returned receipt's `selectedPlane` MUST equal this or the
   * call is a protocol violation "even if output succeeds" (ADR-0025a §D5
   * rule 7). Verified at decode time by
   * {@link assertRoutingReceiptMatchesIntent}.
   */
  requiredPlane?: RoutingPlane;
  /** Planes the caller will accept. Advisory intent — the Proxy enforces. */
  allowedPlanes: RoutingPlane[];
  /** Workload urgency class (ADR-0025a §D5). `critical` suppresses automatic failover. */
  workloadPolicy: WorkloadPolicy;
  /** Ceiling the caller is willing to route under, when the Proxy exposes utilization. */
  maxUtilization?: number;
  /** Opaque ADR-0022 consent grant IDs relevant to this call (ADR-0025a §D5/§D9). */
  consentGrants: ConsentGrantId[];
  /** Whether the caller opts into training contribution (reported without content, §D9). */
  trainingShare: boolean;
  /** If true, the Proxy must fail rather than silently degrade to another plane (§D5 rule 5). */
  failIfUnavailable: boolean;
}

/**
 * The single decode-time verification §D5 mandates (rule 7): a
 * `requiredPlane` that the returned receipt contradicts is a protocol
 * violation, non-retryable, and MUST throw even when the HTTP call itself
 * was a well-formed 200. This is the SDK's *only* routing "decision" — a
 * pure after-the-fact check, never a selection.
 *
 * Throws {@link AgenticError} `kind: "protocol"` when:
 *  - `intent.requiredPlane` is set and no receipt was returned to verify
 *    against (§D4: "Every inference must return selected-plane evidence"), or
 *  - the receipt's `selectedPlane` does not equal `intent.requiredPlane`.
 *
 * A no-op when `intent` is undefined or carries no `requiredPlane`.
 */
export function assertRoutingReceiptMatchesIntent(
  intent: RoutingIntent | undefined,
  receipt: MetaProxyRoutingReceipt | undefined,
): void {
  const required = intent?.requiredPlane;
  if (!required) return;

  if (!receipt) {
    throw new AgenticError(
      "protocol",
      `RoutingIntent.requiredPlane "${required}" cannot be verified: the Proxy ` +
        `response carried no routing receipt (ADR-0025a §D4: every inference must ` +
        `return selected-plane evidence)`,
      {
        product: PRODUCT,
        operation: "chat.completions",
        retryable: false,
        details: { requiredPlane: required },
      },
    );
  }

  if (receipt.selectedPlane !== required) {
    throw new AgenticError(
      "protocol",
      `Proxy selected plane "${receipt.selectedPlane}" but RoutingIntent.requiredPlane ` +
        `was "${required}" — a required-plane mismatch is a protocol violation even ` +
        `when output succeeds (ADR-0025a §D5 rule 7)`,
      {
        product: PRODUCT,
        operation: "chat.completions",
        requestId: receipt.requestId,
        retryable: false,
        details: {
          requiredPlane: required,
          selectedPlane: receipt.selectedPlane,
          configuredPlane: receipt.configuredPlane,
        },
      },
    );
  }
}
