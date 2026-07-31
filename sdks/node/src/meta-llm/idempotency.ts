/**
 * Idempotency-key generation and `IdempotencyBindingV1` construction
 * (ADR-0024a §D7, ADR-0023 §D5) for the two "direct nonstream call[s]
 * whose accepted contract declares safe replay" this pass lands:
 * `chat.completions` and `messages.create`. See `./nonstream.js` for the
 * retry loop that actually sends these.
 *
 * This is the exact ADR-0023 §D5 `IdempotencyBindingV1` type and binding
 * shape (re-exported from `../agentic/index.js`), not a Meta LLM-specific
 * approximation (ADR-0024a §D7).
 */

import {
  canonicalJson,
  sha256Hex,
  type Credential,
  type IdempotencyBindingV1,
  type TenantContext,
} from "../agentic/index.js";

/**
 * Contract major for the nonstream serving surface this pass lands
 * (ADR-0023 §D5 `contractMajor`). Bump only alongside a documented
 * breaking change to one of these two operations' request/response wire
 * shape.
 */
export const CONTRACT_MAJOR = 1;

/**
 * `sha256Hex(canonicalJson(body))`, reusing the same
 * `cognitum-canonical-json-v1` scheme as `agentic/receipt-verification.js`
 * (recursively sorted object keys, no whitespace) rather than a separate
 * RFC 8785 implementation of ADR-0023 §D5's canonicalization paragraph.
 * This pass's per-language conformance does not require cross-language
 * byte-identical digests (that lands with the ADR-0024a §D9 GA gates) —
 * only a digest that is stable within one client for one logical call, so
 * a retry reuses the same key/body pair and a changed body is detectable.
 */
export function canonicalRequestSha256(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

/**
 * Build the exact ADR-0023 §D5 binding for one logical nonstream call.
 *
 * `authenticatedPrincipal` falls back to the credential's non-secret
 * provider fingerprint when the provider does not populate
 * `CredentialAuthority.principal` — the binding's principal field is
 * required (not optional), and the fingerprint is still a stable,
 * non-secret per-credential-identity value suitable for that role.
 */
export function buildIdempotencyBinding(
  operation: string,
  path: string,
  credential: Credential,
  tenant: TenantContext | undefined,
  canonicalRequestSha256Value: string,
  idempotencyKey: string,
): IdempotencyBindingV1 {
  const authenticatedPrincipal =
    credential.authority.principal ?? credential.authority.providerFingerprint;
  const tenantContext = tenant?.tenantId ?? credential.authority.tenant;
  const delegatedSubtenantContext =
    tenant?.delegatedSubtenantId ?? credential.authority.delegatedSubtenant;
  return {
    authenticatedPrincipal,
    tenantContext,
    delegatedSubtenantContext,
    httpMethod: "POST",
    // ADR-0023 §D5: "the contract operation ID plus normalized path
    // parameters [...] canonically sorted, percent-encoded query pairs".
    // Neither route has path parameters or a query string, so this
    // reduces to exactly `"{operation} {path}"`.
    normalizedRouteIdentity: `${operation} ${path}`,
    canonicalRequestSha256: canonicalRequestSha256Value,
    idempotencyKey,
    contractMajor: CONTRACT_MAJOR,
  };
}
