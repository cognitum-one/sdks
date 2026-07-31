//! ADR-0022 §D5 scope preflight, shared by every product client's mutating
//! request path.
//!
//! > "The SDK contract manifest maps every operation to its required
//! > scopes. Before a billable or mutating call, a provider with known
//! > granted scopes is checked locally. Missing scope returns
//! > `PermissionDeniedError` before I/O. Unknown scope sets are sent once
//! > and mapped from the server response; the SDK never guesses that a
//! > broader-looking string implies permission."
//!
//! `credential.granted_scopes == None` means "unknown" — the SDK does not
//! block locally and lets the server be authoritative (matches
//! `StaticApiKeyCredentialProvider`, which never sets `granted_scopes` at
//! all today). An explicit `Some(vec)` (including an empty one) means
//! "known", and a missing required scope fails closed here, before any
//! network I/O.
//!
//! Scopes are matched as exact contract tokens (§D5: "Wildcard
//! interpretation belongs to the identity service, not the SDK").

use crate::agentic::credentials::Credential;
use crate::agentic::errors::PermissionDeniedError;

/// Returns `Err(PermissionDeniedError)` when `credential.granted_scopes` is
/// known (`Some`) and does not contain `required_scope`. `Ok(())` —
/// including when `granted_scopes` is `None` — otherwise.
pub fn assert_scope_granted(
    product: &str,
    operation: &str,
    required_scope: &str,
    credential: &Credential,
) -> Result<(), PermissionDeniedError> {
    let Some(granted) = credential.granted_scopes.as_ref() else {
        // Unknown scope set: send once, let the server be authoritative (§D5).
        return Ok(());
    };
    if !granted.iter().any(|s| s == required_scope) {
        return Err(PermissionDeniedError::new(
            product,
            operation,
            required_scope,
            granted.clone(),
        ));
    }
    Ok(())
}
