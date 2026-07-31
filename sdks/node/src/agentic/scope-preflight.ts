/**
 * ADR-0022 §D5 scope preflight, shared by every product client's mutating
 * request path.
 *
 * > "The SDK contract manifest maps every operation to its required
 * > scopes. Before a billable or mutating call, a provider with known
 * > granted scopes is checked locally. Missing scope returns
 * > `PermissionDeniedError` before I/O. Unknown scope sets are sent once
 * > and mapped from the server response; the SDK never guesses that a
 * > broader-looking string implies permission."
 *
 * `credential.grantedScopes === undefined` means "unknown" — the SDK does
 * not block locally and lets the server be authoritative (matches
 * `StaticApiKeyCredentialProvider`, which never sets `grantedScopes` at
 * all today). An explicit array (including an empty one) means "known",
 * and a missing required scope fails closed here, before any network I/O.
 *
 * Scopes are matched as exact contract tokens (§D5: "Wildcard
 * interpretation belongs to the identity service, not the SDK").
 */

import type { Credential } from "./credentials.js";
import { PermissionDeniedError } from "./errors.js";

/**
 * Throws {@link PermissionDeniedError} when `credential.grantedScopes` is
 * known (defined) and does not contain `requiredScope`. No-op — including
 * when `grantedScopes` is `undefined` — otherwise.
 */
export function assertScopeGranted(
  product: string,
  operation: string,
  requiredScope: string,
  credential: Credential,
): void {
  const granted = credential.grantedScopes;
  if (granted === undefined) {
    // Unknown scope set: send once, let the server be authoritative (§D5).
    return;
  }
  if (!granted.includes(requiredScope)) {
    throw new PermissionDeniedError(product, operation, requiredScope, granted);
  }
}
