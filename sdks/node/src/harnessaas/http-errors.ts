/**
 * HTTP-status -> `AgenticErrorKind` mapping for HarnessaaS. Verified against
 * the REAL error paths in `cognitum-one/harnessaas@908e4a99`:
 *
 * - 401 `missing_api_key`/`invalid_api_key` (`src/auth.ts:280-303`) — opaque
 *   on purpose (anti-enumeration): malformed/unknown/inactive/expired all
 *   collapse to the same message.
 * - 403 `insufficient_scope` (`src/auth.ts` `authorizeGenome`) and
 *   `scope_required` (`src/server.ts` security-remediation gate) — a key
 *   with no completion scope at all, or missing the dedicated
 *   `completions:security` scope.
 * - 403 (egress) `EgressDeniedError` (`src/server.ts`, ADR-0040) — the
 *   requested allowlist-egress policy can't be built on this runtime; the
 *   service fails CLOSED rather than degrade to open egress.
 * - 400 — invalid JSON body, missing `repo`/`test_command`/`issue`, a
 *   non-git `repo` path (`repo_not_permitted`, issue #56), or a
 *   vertical-specific missing field.
 * - 404 — unmatched route, or (for `lineage`) a `request_id` not owned by
 *   the caller's tenant (cross-tenant reads collapse to the same 404,
 *   anti-enumeration).
 * - 422 `safety_blocked` — the inbound PII/safety pre-flight refused the
 *   request BEFORE any spend (`PiiBlockedError`).
 * - 500 — an uncaught exception; the service has no explicit 429/502/503
 *   emission in its own route code (no in-app rate limiter was found), so
 *   those statuses (if seen at all) originate from infrastructure in front
 *   of the app (Cloud Run / load balancer), not from `harnessaas` itself.
 *   Mapped here defensively for forward compatibility only.
 */

import { AgenticError } from "../agentic/index.js";

const PRODUCT = "harnessaas";

function nonEmpty(value: string, fallback: string): string {
  return value.length > 0 ? value : fallback;
}

/** Minimal response shape this mapper needs — satisfied by `fetch`'s `Response`. */
export interface HttpErrorResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export async function mapHarnessaaSHttpError(
  response: HttpErrorResponse,
  operation: string,
  requestId: string,
): Promise<AgenticError> {
  const status = response.status;
  const bodyText = await response.text().catch(() => "");
  const fields = { product: PRODUCT, operation, status, requestId };

  switch (status) {
    case 400:
      return new AgenticError("validation", nonEmpty(bodyText, "invalid request"), {
        ...fields,
        retryable: false,
      });
    // Opaque anti-enumeration auth failure (`src/auth.ts`) — never retried.
    case 401:
      return new AgenticError("authentication", nonEmpty(bodyText, "authentication failed"), {
        ...fields,
        retryable: false,
      });
    // Insufficient scope (`insufficient_scope`/`scope_required`) or egress denial.
    case 403:
      return new AgenticError("permission_denied", nonEmpty(bodyText, "permission denied"), {
        ...fields,
        retryable: false,
      });
    case 404:
      return new AgenticError("not_found", nonEmpty(bodyText, "not found"), {
        ...fields,
        retryable: false,
      });
    // The inbound safety pre-flight refused the request before any spend
    // (`PiiBlockedError`) — a genuine content-of-request rejection, never retried.
    case 422:
      return new AgenticError(
        "safety_blocked",
        nonEmpty(bodyText, "request blocked by PII/safety pre-flight"),
        { ...fields, retryable: false },
      );
    // No in-app rate limiter or explicit 5xx emission was found in
    // `harnessaas`'s own route code — these statuses, if seen, come from
    // infrastructure in front of the app. Classified `retryable: true` here
    // for forward compatibility ONLY; `solve()` never acts on this (see
    // `client.ts`'s doc comment on why solve is single-attempt).
    case 429: {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      return new AgenticError("rate_limited", nonEmpty(bodyText, "rate limited"), {
        ...fields,
        retryable: true,
        retryAfterMs,
      });
    }
    case 502:
    case 503:
      return new AgenticError("transport", nonEmpty(bodyText, `upstream error ${status}`), {
        ...fields,
        retryable: true,
      });
    // An uncaught exception (`src/server.ts`'s catch-all `json(res, 500, ...)`).
    case 500:
      return new AgenticError("protocol", nonEmpty(bodyText, "internal server error"), {
        ...fields,
        retryable: false,
      });
    default:
      return new AgenticError("protocol", nonEmpty(bodyText, `unexpected status ${status}`), {
        ...fields,
        retryable: false,
      });
  }
}
