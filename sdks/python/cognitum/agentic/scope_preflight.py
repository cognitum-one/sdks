"""ADR-0022 §D5 scope preflight, shared by every product client's mutating
request path.

    "The SDK contract manifest maps every operation to its required
    scopes. Before a billable or mutating call, a provider with known
    granted scopes is checked locally. Missing scope returns
    ``PermissionDeniedError`` before I/O. Unknown scope sets are sent once
    and mapped from the server response; the SDK never guesses that a
    broader-looking string implies permission."

``credential.granted_scopes is None`` means "unknown" -- the SDK does not
block locally and lets the server be authoritative (matches
``StaticApiKeyCredentialProvider``, which never sets ``granted_scopes`` at
all today). An explicit list (including an empty one) means "known", and a
missing required scope fails closed here, before any network I/O.

Scopes are matched as exact contract tokens (§D5: "Wildcard interpretation
belongs to the identity service, not the SDK").
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cognitum.agentic.errors import PermissionDeniedError

if TYPE_CHECKING:
    from cognitum.agentic.credentials import Credential


def assert_scope_granted(
    product: str,
    operation: str,
    required_scope: str,
    credential: Credential,
) -> None:
    """Raise :class:`PermissionDeniedError` when ``credential.granted_scopes``
    is known (not ``None``) and does not contain ``required_scope``. No-op
    -- including when ``granted_scopes`` is ``None`` -- otherwise.
    """
    granted = credential.granted_scopes
    if granted is None:
        # Unknown scope set: send once, let the server be authoritative (§D5).
        return
    if required_scope not in granted:
        raise PermissionDeniedError(product, operation, required_scope, granted)


__all__ = ["assert_scope_granted"]
