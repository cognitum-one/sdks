"""Non-streaming POST forwarding for the Meta Proxy data plane (ADR-0025a §D7).

This is a lightweight, Proxy-SPECIFIC equivalent of
:mod:`cognitum.meta_llm.nonstream`'s ``post_json_idempotent`` rather than a
reuse of it: that helper is bound to ``MetaLlmClientConfig`` (its
``credential_provider``/``base_url``/``MetaLlmTelemetryHooks``), whereas the
Proxy has its own config (``local_credential_provider``/``origin``/
``MetaProxyTelemetryHooks``) AND three Proxy-only obligations that helper
does not carry:

1. the §D7 caller-header FORWARDING ALLOWLIST -- only an explicit set of
   headers may be forwarded, and ``Authorization``/local-bearer/``Host``/
   ``Content-Length``/sponsor/identity/consent are NEVER caller-forwarded
   (they come from validated local state);
2. §D10 redirect rejection -- a 3xx is a hard protocol error, never followed;
3. §D4/§D5 routing-receipt decode into ``MetaProxyResponseMeta`` so the
   caller's ``RoutingIntent`` can be verified at decode time.

The idempotency-key + single-401-refresh shape is mirrored CONCEPTUALLY from
``meta_llm/nonstream.py``, but the retry shape is deliberately NOT mirrored:
per §D8, "No Proxy POST is automatically retried while it drops
``Idempotency-Key``". That sentence is about whether the *Proxy server*
honors the header for server-side deduplication -- the currently-deployed
Proxy drops it -- not about whether the SDK attaches one. Attaching an
``Idempotency-Key`` client-side does nothing to make a retry safe if the
server never uses it to deduplicate, so a 429/502/503 (or any other
non-2xx) from this POST is surfaced as a single terminal, non-retryable
error; the caller may retry manually using the error's ``retry_after_ms``.
The Alternatives-considered table makes the same point explicitly: "Retry
Proxy POSTs" was considered and rejected because "Idempotency is dropped
and spend can duplicate". Bounded retry remains reserved for the read-only
status/models/identity routes (§D8), which this module does not implement.
§D8's own error/stream/deadline model is otherwise out of scope for this
pass.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import AgenticError
from cognitum.meta_proxy.envelope import MetaProxyResponseMeta, collect_unknown_headers
from cognitum.meta_proxy.http_errors import map_meta_proxy_http_error
from cognitum.meta_proxy.status import MetaProxyRoutingReceipt

if TYPE_CHECKING:
    from cognitum.agentic import Credential
    from cognitum.meta_proxy.config import MetaProxyClientConfig

_PRODUCT = "meta-proxy"
#: Required scope for the data-plane inference operations (distinct from
#: ``client.py``'s ``"meta-proxy.status"`` read scope).
_INFERENCE_SCOPE = "meta-proxy.inference"

#: Wire keys for the routing/upstream receipts embedded in a response body
#: (snake_case, consistent with the rest of the Proxy wire surface).
_ROUTING_RECEIPT_KEY = "cognitum_routing_receipt"
_UPSTREAM_RECEIPT_KEY = "cognitum_upstream_receipt"

#: The §D7 cloud-forwarding allowlist. Mapping is lowercase -> canonical
#: casing so a caller-supplied header of any case is normalized, and anything
#: NOT in this set (``Authorization``, ``Host``, ``Content-Length``, sponsor
#: markers, installation identity, training consent, ...) is dropped before
#: the request is built.
_FORWARD_ALLOWLIST: dict[str, str] = {
    h.lower(): h
    for h in (
        "Idempotency-Key",
        "X-Request-ID",
        "traceparent",
        "tracestate",
        "X-Cognitum-Fallback-Policy",
        "X-Cognitum-Min-Tier",
        "X-Cognitum-Max-Tier",
        "X-Cognitum-Escalation",
        "X-Cognitum-Cache",
        "X-Cognitum-Safety",
        "X-Cognitum-Sub-Tenant",
        "anthropic-version",
        "anthropic-beta",
    )
}


def filter_forwardable_headers(headers: Mapping[str, str] | None) -> dict[str, str]:
    """Return only the §D7-allowlisted subset of ``headers``, normalized to
    canonical casing. Everything else -- crucially ``Authorization`` and the
    local bearer -- is dropped, so a caller can never inject an auth override
    through the forwarding bag (ADR-0025a §D7).
    """
    result: dict[str, str] = {}
    if not headers:
        return result
    for name, value in headers.items():
        canonical = _FORWARD_ALLOWLIST.get(name.lower())
        if canonical is not None:
            result[canonical] = value
    return result


def parse_meta_proxy_routing_receipt(raw: Any) -> MetaProxyRoutingReceipt | None:
    """Decode a ``cognitum_routing_receipt`` body field into the typed
    receipt, or ``None`` when absent. Permissive about unknown fields, like
    the rest of the not-yet-contracted Proxy wire surface (§D4).
    """
    if not isinstance(raw, dict):
        return None
    return MetaProxyRoutingReceipt(
        request_id=str(raw.get("request_id", "")),
        configured_plane=str(raw.get("configured_plane", "")),
        selected_plane=str(raw.get("selected_plane", "")),
        automatic=bool(raw.get("automatic", False)),
        degraded=bool(raw.get("degraded", False)),
        routing_reason=raw.get("routing_reason"),
        workload_policy=raw.get("workload_policy"),
        consent_evidence_id=raw.get("consent_evidence_id"),
        upstream_receipt=raw.get("upstream_receipt"),
        local_usage=raw.get("local_usage"),
        warnings=raw.get("warnings"),
    )


async def _require_bearer(config: MetaProxyClientConfig, operation: str) -> Credential:
    from cognitum.agentic import CredentialRequest

    provider = config.local_credential_provider
    if provider is None:
        raise AgenticError(
            "authentication",
            f"MetaProxyClient.{operation} requires a local_credential_provider "
            "(ADR-0025a §D6: the bearer comes only from validated local state)",
            product=_PRODUCT,
            operation=operation,
            retryable=False,
        )
    return await provider.acquire(
        CredentialRequest(
            product=_PRODUCT,
            normalized_origin=config.origin,
            audience=config.origin,
            required_scopes=[_INFERENCE_SCOPE],
            operation=operation,
            interactive_allowed=False,
        )
    )


def _apply_bearer(headers: dict[str, str], credential: Credential) -> None:
    # ADR-0025a §D6/§D7: the local bearer is derived from validated local
    # state and placed by the SDK -- it is never a caller-forwarded header.
    if credential.scheme.lower() == "bearer":
        headers["Authorization"] = f"Bearer {credential.secret.reveal()}"
    else:
        headers[credential.scheme] = credential.secret.reveal()


async def _send_once(
    config: MetaProxyClientConfig,
    transport: httpx.AsyncClient,
    path: str,
    operation: str,
    body: dict[str, Any],
    credential: Credential,
    forwarded_headers: dict[str, str],
    idempotency_key: str,
) -> tuple[dict[str, Any], MetaProxyResponseMeta]:
    """One HTTP attempt. Never retries by itself -- the caller owns that."""
    request_id = str(uuid.uuid4())
    telemetry = config.telemetry
    if telemetry is not None:
        telemetry.on_request_start(operation, request_id)
    started_at = time.monotonic()

    # Start from the allowlisted forward headers, then overlay SDK-owned
    # headers so they always win (and so nothing caller-supplied can shadow
    # Accept/Content-Type/Authorization/request-id/idempotency-key).
    headers = dict(forwarded_headers)
    headers["Accept"] = "application/json"
    headers["Content-Type"] = "application/json"
    headers["X-Cognitum-Request-Id"] = request_id
    headers["Idempotency-Key"] = idempotency_key

    # ADR-0025a §D6/§D10: the bearer is sent ONLY to literal loopback (or an
    # explicitly opted-in non-loopback origin). Re-verify at the attachment
    # point rather than trusting construction alone.
    from cognitum.meta_proxy.config import bearer_target_allowed

    if not bearer_target_allowed(config.origin, config.allow_non_loopback):
        raise AgenticError(
            "authentication",
            f'{operation} refused to attach a local bearer to non-loopback origin '
            f'"{config.origin}" (ADR-0025a §D6/§D10: set allow_non_loopback only for '
            "the dangerous-preview remote case)",
            product=_PRODUCT,
            operation=operation,
            retryable=False,
        )
    _apply_bearer(headers, credential)

    url = f"{config.origin}{path}"
    try:
        response = await transport.post(url, headers=headers, json=body)
    except httpx.HTTPError as cause:
        raise AgenticError(
            "transport",
            f"{operation} request failed: {cause}",
            product=_PRODUCT,
            operation=operation,
            request_id=request_id,
            retryable=True,
            cause=cause,
        ) from cause

    duration_ms = (time.monotonic() - started_at) * 1000
    retry_after_header = response.headers.get("retry-after")
    retry_after_ms = int(float(retry_after_header) * 1000) if retry_after_header else None

    if telemetry is not None:
        from cognitum.meta_proxy.config import MetaProxyTelemetryEvent

        telemetry.on_request_end(
            MetaProxyTelemetryEvent(
                operation=operation,
                request_id=request_id,
                http_status=response.status_code,
                duration_ms=duration_ms,
                retry_after_ms=retry_after_ms,
            )
        )

    # ADR-0025a §D10: redirects are rejected outright, never followed. With
    # ``follow_redirects=False`` httpx returns the 3xx as-is, so we must turn
    # it into a hard protocol error rather than silently treating the (empty)
    # redirect body as a success.
    if 300 <= response.status_code < 400:
        location = response.headers.get("location")
        raise AgenticError(
            "protocol",
            f"{operation} received a {response.status_code} redirect"
            + (f' to "{location}"' if location else "")
            + " -- the Meta Proxy transport rejects redirects (ADR-0025a §D10)",
            product=_PRODUCT,
            operation=operation,
            status=response.status_code,
            request_id=request_id,
            retryable=False,
        )

    if response.status_code >= 400:
        err = map_meta_proxy_http_error(response, operation, request_id)
        if err.retry_after_ms is None:
            err.retry_after_ms = retry_after_ms
        raise err

    data: dict[str, Any] = response.json()
    routing_receipt = parse_meta_proxy_routing_receipt(data.get(_ROUTING_RECEIPT_KEY))
    upstream_receipt = data.get(_UPSTREAM_RECEIPT_KEY)
    meta = MetaProxyResponseMeta(
        request_id=response.headers.get("x-cognitum-request-id", request_id),
        http_status=response.status_code,
        product_version=response.headers.get("x-cognitum-product-version"),
        protocol_version=response.headers.get("x-cognitum-protocol-version"),
        retry_after=float(retry_after_header) if retry_after_header else None,
        routing_receipt=routing_receipt,
        upstream_receipt=upstream_receipt,
        unknown_headers=collect_unknown_headers(response.headers),
    )
    return data, meta


async def post_chat_forwarding(
    config: MetaProxyClientConfig,
    transport: httpx.AsyncClient,
    path: str,
    operation: str,
    body: dict[str, Any],
    caller_headers: Mapping[str, str] | None,
) -> tuple[dict[str, Any], MetaProxyResponseMeta]:
    """Forward one non-streaming inference POST through the Proxy (§D7).

    Attaches ONLY the §D7-allowlisted subset of ``caller_headers`` plus the
    SDK-owned headers and the validated local bearer; generates an
    idempotency key when the caller did not supply one; performs at most one
    401 credential refresh; rejects redirects; and decodes the routing/
    upstream receipts into the returned metadata.

    Per §D8, a Proxy POST is never automatically retried on 429/502/503 (or
    any other status): the currently-deployed Proxy drops the caller's
    ``Idempotency-Key`` server-side, so attaching one client-side does not
    make a silent retry safe against duplicate spend. Any such error
    surfaces as a single terminal, non-retryable ``AgenticError`` whose
    ``retry_after_ms`` (populated from a ``Retry-After`` response header,
    when present) lets the CALLER decide whether to retry manually.
    """
    forwarded = filter_forwardable_headers(caller_headers)
    # Reuse a caller-supplied (allowlisted) Idempotency-Key when present so
    # the retry replay is safe against the same logical request; otherwise
    # generate one. Stable across every retry of this call.
    idempotency_key = forwarded.pop("Idempotency-Key", None) or str(uuid.uuid4())

    credential = await _require_bearer(config, operation)

    refreshed_once = False

    while True:
        try:
            return await _send_once(
                config,
                transport,
                path,
                operation,
                body,
                credential,
                forwarded,
                idempotency_key,
            )
        except AgenticError as err:
            if err.status == 401 and not refreshed_once:
                refreshed_once = True
                if config.local_credential_provider is not None:
                    await config.local_credential_provider.invalidate(
                        "401 challenge from meta-proxy"
                    )
                credential = await _require_bearer(config, operation)
                continue

            # ADR-0025a §D8: "No Proxy POST is automatically retried while it
            # drops `Idempotency-Key`" -- the currently-deployed Proxy does not
            # honor the header for server-side dedup, so attaching one here
            # does not make a retry safe. 429/502/503 (and every other status)
            # surface as a single terminal error; `err.retry_after_ms` lets the
            # caller retry manually.
            raise


__all__ = [
    "filter_forwardable_headers",
    "parse_meta_proxy_routing_receipt",
    "post_chat_forwarding",
]
