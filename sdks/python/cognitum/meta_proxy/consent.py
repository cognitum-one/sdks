"""Consent gating for ``MetaProxyClient`` data-plane calls (ADR-0025a §D9).

§D9: "Separate ADR-0022 grants cover Cognitum cloud routing, sponsor, power
saver, direct Anthropic, and training contribution. Credential presence is
not consent. Headless clients return ``ConsentRequiredError`` rather than
prompt."

This module is intentionally narrow. Stable sponsor support is BLOCKED on
ADR-0025b's lifecycle/state fixes (§D9: "interprocess locking, atomic
replace, fail-closed corruption, schema and pricing version, server
reconciliation, and crash/concurrency/date/clock tests") and is NOT
implemented here. The one gate this pass DOES implement is the tractable
slice: routing to the ``cognitum_cloud`` plane requires a matching,
unexpired ``cloud_fallback`` consent grant (ADR-0022 §D7's kind for "routing
from local to Cognitum cloud") -- checked BEFORE any HTTP I/O, never
inferred from credential presence.

``RoutingIntent.consent_grants`` (:mod:`cognitum.meta_proxy.routing`) is a
distinct, unrelated concept: it is the opaque set of ADR-0022 grant IDs the
SDK *forwards as intent* to the Proxy (PR #93) -- the SDK does not interpret
its structure. This module instead checks the caller's *locally held*
``ConsentGrant`` objects (``MetaProxyClientConfig.consent_grants``,
ADR-0022 §D7's typed shape) against the plane the call's ``RoutingIntent``
would allow/require.
"""

from __future__ import annotations

import datetime
from typing import TYPE_CHECKING

from cognitum.agentic import ConsentGrant, ConsentGrantKind, ConsentRequiredError

if TYPE_CHECKING:
    from collections.abc import Sequence

    from cognitum.meta_proxy.routing import RoutingIntent, RoutingPlane

_PRODUCT = "meta-proxy"

#: ADR-0022 §D7's consent-grant kind that covers Cognitum-cloud routing. The
#: ADR's kind list has no ``cognitum_cloud_routing`` entry; ``cloud_fallback``
#: ("routing from local to Cognitum cloud") is the matching kind -- it is a
#: low-stakes kind (an unsigned local record is sufficient per §D7), unlike
#: ``sponsored_inference``.
CLOUD_ROUTING_CONSENT_KIND: ConsentGrantKind = "cloud_fallback"


def intent_touches_plane(intent: RoutingIntent, plane: RoutingPlane) -> bool:
    """``True`` when ``intent`` would allow or require routing through ``plane``."""
    return intent.required_plane == plane or plane in intent.allowed_planes


def is_consent_grant_valid(
    grant: ConsentGrant,
    kind: ConsentGrantKind,
    product: str,
    origin: str,
    now: datetime.datetime | None = None,
) -> bool:
    """``True`` when ``grant`` is unexpired at ``now`` and matches
    ``kind``/``product``/``origin``. Pure, no I/O -- does not verify
    signatures or re-attest server-persisted grants (§D7's
    consequential-kind re-check remains a follow-up).
    """
    if grant.kind != kind:
        return False
    if grant.product != product:
        return False
    if grant.origin != origin:
        return False
    if grant.expires_at is not None:
        moment = now or datetime.datetime.now(datetime.timezone.utc)
        expires = datetime.datetime.fromisoformat(grant.expires_at)
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=datetime.timezone.utc)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=datetime.timezone.utc)
        if expires <= moment:
            return False
    return True


def has_valid_consent_grant(
    grants: Sequence[ConsentGrant],
    kind: ConsentGrantKind,
    product: str,
    origin: str,
    now: datetime.datetime | None = None,
) -> bool:
    """``True`` when ``grants`` contains at least one grant satisfying
    :func:`is_consent_grant_valid`.
    """
    return any(is_consent_grant_valid(grant, kind, product, origin, now) for grant in grants)


def assert_consent_for_routing_intent(
    intent: RoutingIntent | None,
    grants: Sequence[ConsentGrant],
    origin: str,
    operation: str,
    now: datetime.datetime | None = None,
) -> None:
    """Fail-closed gate applied BEFORE any HTTP I/O (ADR-0025a §D9).

    When ``intent`` allows or requires the ``cognitum_cloud`` plane and
    ``grants`` contains no matching, unexpired
    :data:`CLOUD_ROUTING_CONSENT_KIND` grant for ``product``/``origin``,
    raises :class:`cognitum.agentic.ConsentRequiredError` -- a valid local
    bearer credential does NOT satisfy this check ("Credential presence is
    not consent").

    A no-op when ``intent`` is ``None`` or does not touch ``cognitum_cloud``.
    """
    if intent is None:
        return
    if not intent_touches_plane(intent, "cognitum_cloud"):
        return
    if has_valid_consent_grant(grants, CLOUD_ROUTING_CONSENT_KIND, _PRODUCT, origin, now):
        return

    raise ConsentRequiredError(
        _PRODUCT,
        operation,
        CLOUD_ROUTING_CONSENT_KIND,
        f'{operation}\'s RoutingIntent allows or requires the "cognitum_cloud" plane, but '
        f'no unexpired ADR-0022 "{CLOUD_ROUTING_CONSENT_KIND}" consent grant is present '
        f'for origin "{origin}" (ADR-0025a §D9: credential presence is not consent -- '
        "headless clients return ConsentRequiredError rather than prompt).",
    )


__all__ = [
    "CLOUD_ROUTING_CONSENT_KIND",
    "assert_consent_for_routing_intent",
    "has_valid_consent_grant",
    "intent_touches_plane",
    "is_consent_grant_valid",
]
