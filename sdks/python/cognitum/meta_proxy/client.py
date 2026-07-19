"""MetaProxyClient (ADR-0025a). Issue #61 / M3 start.

This pass implements exactly §D1 (public topology -- only ``status()`` and
``capabilities()`` exist as methods this pass; every other §D1 surface --
``chat``, ``messages``, ``models``, ``whoami``, ``preview.sponsored.*``,
``preview.routing`` -- is deliberately NOT declared yet, rather than
stubbed with a placeholder, since their construction depends on §D6
(auth), §D7 (forwarding), §D9 (consent/sponsor), and §D5 (routing)
groundwork that is out of scope here), §D2 (maturity -- everything below
is preview), §D3 (construction, zero I/O), and §D4 (``status()``/
``capabilities()`` as real HTTP calls against the local sidecar's
``/status`` route, decoding the plane-evidence fields §D4 specifies).

Construction mirrors :class:`cognitum.meta_llm.client.MetaLlmClient`'s
conventions exactly: a resolved config object, an injectable ``transport``,
a shared ``CredentialProvider`` for auth, and the same telemetry-hook /
request-ID / error-mapping shape. The one structural difference is D3's own
explicit instruction: ``MetaProxyResult``/``MetaProxyResponseMeta`` are
their OWN envelope, not a reuse of ``MetaLlmResult`` -- see
:mod:`cognitum.meta_proxy.envelope`'s module docstring for why.

Deferred to follow-up M3 passes (see issue #61 and ADR-0025a):

- §D5 data-plane and policy model (``RoutingIntent``, plane/policy rules);
- §D6 authentication and workload capabilities beyond the minimal
  ``CredentialProvider`` this pass's constructor accepts;
- §D7 inference/forwarding contract (``chat.completions``, ``messages``);
- §D8 streaming, errors, cancellation, and retry for the data plane;
- §D9 consent, sponsor budget, and usage;
- §D10 loopback and browser security beyond the loopback-origin validation
  already enforced by :mod:`cognitum.meta_proxy.config`.

This client is async-only, mirroring :class:`cognitum.meta_llm.client.MetaLlmClient`.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import AgenticError
from cognitum.meta_proxy.config import MetaProxyClientConfig
from cognitum.meta_proxy.envelope import MetaProxyResponseMeta, MetaProxyResult
from cognitum.meta_proxy.http_errors import map_meta_proxy_http_error
from cognitum.meta_proxy.status import MetaProxyStatus

if TYPE_CHECKING:
    from cognitum.agentic import Credential

_PRODUCT = "meta-proxy"
_DEFAULT_CAPABILITY_VERSION = "0.0.0"


@dataclass(frozen=True)
class CapabilitiesResult:
    """``capabilities()`` result shape -- the shared ``CapabilitySet``
    (ADR-0019 §D6) plus the Proxy-specific plane evidence ADR-0025a §D4
    says ``capabilities()`` must be able to expose alongside it.
    """

    product: str
    product_version: str
    protocol: str
    protocol_version: str
    source: str
    features: dict[str, bool] = field(default_factory=dict)
    limitations: list[str] = field(default_factory=list)
    auth_methods: list[str] = field(default_factory=list)
    compatible_sdk_range: str | None = None
    configured_plane: str | None = None
    selected_plane: str | None = None


def _parse_status(data: dict[str, Any]) -> MetaProxyStatus:
    known_keys = MetaProxyStatus.known_keys()
    raw = {k: v for k, v in data.items() if k not in known_keys}
    return MetaProxyStatus(
        product_version=str(data.get("product_version", "")),
        protocol_version=data.get("protocol_version"),
        compatible_sdk_range=data.get("compatible_sdk_range"),
        process_state=str(data.get("process_state", "unknown")),
        bind=data.get("bind"),
        configured_plane=str(data.get("configured_plane", "")),
        selected_plane=str(data.get("selected_plane", "")),
        routing_reason=data.get("routing_reason"),
        automatic_usage_state=data.get("automatic_usage_state"),
        utilization=data.get("utilization"),
        reset_at=data.get("reset_at"),
        workload_policy=data.get("workload_policy"),
        sponsored_available=data.get("sponsored_available"),
        cloud_credential_source=data.get("cloud_credential_source"),
        limitations=list(data.get("limitations", [])),
        request_id=str(data.get("request_id", "")),
        raw=raw,
    )


class MetaProxyClient:
    """Client for an already-running, authenticated, loopback Meta Proxy
    sidecar (ADR-0025a).

    Independent of ``MetaProxyManager`` (ADR-0025b) -- construction never
    starts, installs, authenticates, probes, or reconfigures a process
    (ADR-0025a §D1).

    Every method on this class is ``preview`` maturity (ADR-0025a §D2: "All
    current methods begin preview until a complete contract bundle
    exists"). ``status``/``capabilities`` are the group with a defined path
    to ``Stable`` but have not reached it yet -- no D11 GA gate has passed.
    """

    def __init__(self, config: MetaProxyClientConfig | None = None) -> None:
        self._config = config or MetaProxyClientConfig()
        self._owns_transport = self._config.transport is None
        self._transport: httpx.AsyncClient = self._config.transport or httpx.AsyncClient()

    @property
    def config(self) -> MetaProxyClientConfig:
        """Read-only view of the effective configuration."""
        return self._config

    async def status(self) -> MetaProxyResult[MetaProxyStatus]:
        """``GET /status`` -- authenticated local runtime and routing state
        (ADR-0025a Context, §D4). ``proxy_token_valid: true`` (surfaced only
        as a successful auth, never as a raw token) means only that auth
        succeeded -- this method never returns tokens, keys, OAuth data,
        unsafe paths, or full account identifiers (§D4).
        """
        data, meta = await self._get_json("/status", "status")
        return MetaProxyResult(data=_parse_status(data), meta=meta)

    async def capabilities(self) -> MetaProxyResult[CapabilitiesResult]:
        """Versioned behavior safe for this caller (ADR-0025a §D4:
        "``capabilities()`` uses an authenticated endpoint when available.
        Until then it uses exact tested ``/status`` schema plus ADR-0020's
        pinned compatibility table. It never discovers support by sending a
        prompt."). No dedicated ``/capabilities`` route is published, so
        this calls the same authenticated ``/status`` endpoint ``status()``
        uses and merges it with ``config.capabilities_snapshot`` -- it
        never sends an inference request to probe support.
        """
        status_result = await self.status()
        status = status_result.data
        meta = status_result.meta
        snapshot = self._config.capabilities_snapshot
        warnings = list(meta.warnings or [])

        expected = self._config.expected_proxy_version
        if expected and expected != status.product_version:
            warnings.append(
                f'expected_proxy_version "{expected}" does not match the Proxy\'s '
                f'reported product_version "{status.product_version}" (ADR-0025a §D2: '
                "unknown versions receive a minimum-safe set)"
            )

        capabilities = CapabilitiesResult(
            product=_PRODUCT,
            product_version=status.product_version or _DEFAULT_CAPABILITY_VERSION,
            protocol=(snapshot.protocol if snapshot else "cognitum.meta-proxy.http"),
            protocol_version=status.protocol_version
            or (snapshot.protocol_version if snapshot else "1.0"),
            features=dict(snapshot.features) if snapshot else {},
            limitations=[*status.limitations, *(snapshot.limitations if snapshot else [])],
            auth_methods=list(snapshot.auth_methods) if snapshot else [],
            source="server",
            compatible_sdk_range=status.compatible_sdk_range,
            configured_plane=status.configured_plane,
            selected_plane=status.selected_plane,
        )

        new_meta = MetaProxyResponseMeta(
            request_id=meta.request_id,
            http_status=meta.http_status,
            product_version=meta.product_version,
            protocol_version=meta.protocol_version,
            retry_after=meta.retry_after,
            routing_receipt=meta.routing_receipt,
            upstream_receipt=meta.upstream_receipt,
            warnings=warnings or meta.warnings,
            unknown_headers=meta.unknown_headers,
        )
        return MetaProxyResult(data=capabilities, meta=new_meta)

    async def aclose(self) -> None:
        """Close local connections and wait only. Never stops the sidecar
        process (ADR-0025a §D3: "Closing it releases connections only and
        never stops the sidecar.").
        """
        if self._owns_transport:
            await self._transport.aclose()

    async def __aenter__(self) -> MetaProxyClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    # Internal HTTP glue shared by status()/capabilities()
    # ------------------------------------------------------------------

    async def _resolve_credential(self, operation: str) -> Credential | None:
        provider = self._config.local_credential_provider
        if provider is None:
            return None
        from cognitum.agentic import CredentialRequest

        return await provider.acquire(
            CredentialRequest(
                product=_PRODUCT,
                normalized_origin=self._config.origin,
                audience=self._config.origin,
                required_scopes=["meta-proxy.status"],
                operation=operation,
                interactive_allowed=False,
            )
        )

    @staticmethod
    def _apply_auth(headers: dict[str, str], credential: Credential | None) -> None:
        if credential is None:
            return
        if credential.scheme.lower() == "bearer":
            headers["Authorization"] = f"Bearer {credential.secret.reveal()}"
        else:
            headers[credential.scheme] = credential.secret.reveal()

    async def _get_json(self, path: str, operation: str) -> tuple[dict[str, Any], Any]:
        request_id = str(uuid.uuid4())
        started_at = time.monotonic()
        telemetry = self._config.telemetry
        if telemetry is not None:
            telemetry.on_request_start(operation, request_id)

        # ADR-0025a Context: `/status` is authenticated -- unlike
        # MetaLlmClient's health(), there is no unauthenticated Proxy
        # status route to fall back to, so a missing
        # local_credential_provider fails closed here.
        try:
            credential = await self._resolve_credential(operation)
        except AgenticError:
            raise
        except Exception as cause:  # pragma: no cover - defensive
            raise AgenticError(
                "authentication",
                f"failed to acquire local credential: {cause}",
                product=_PRODUCT,
                operation=operation,
                request_id=request_id,
                retryable=False,
                cause=cause,
            ) from cause

        if credential is None:
            raise AgenticError(
                "authentication",
                f"MetaProxyClient.{operation} requires a local_credential_provider "
                '(ADR-0025a Context: "GET /status | Authenticated local runtime and '
                'routing state")',
                product=_PRODUCT,
                operation=operation,
                request_id=request_id,
                retryable=False,
            )

        headers = {"Accept": "application/json", "X-Cognitum-Request-Id": request_id}
        self._apply_auth(headers, credential)

        url = f"{self._config.origin}{path}"
        try:
            response = await self._transport.get(url, headers=headers)
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
        if telemetry is not None:
            from cognitum.meta_proxy.config import MetaProxyTelemetryEvent

            telemetry.on_request_end(
                MetaProxyTelemetryEvent(
                    operation=operation,
                    request_id=request_id,
                    http_status=response.status_code,
                    duration_ms=duration_ms,
                )
            )

        if response.status_code >= 400:
            raise map_meta_proxy_http_error(response, operation, request_id)

        payload: dict[str, Any] = response.json()
        retry_after_header = response.headers.get("retry-after")
        meta = MetaProxyResponseMeta(
            request_id=response.headers.get("x-cognitum-request-id", request_id),
            http_status=response.status_code,
            product_version=response.headers.get("x-cognitum-product-version"),
            protocol_version=response.headers.get("x-cognitum-protocol-version"),
            retry_after=float(retry_after_header) if retry_after_header else None,
        )
        return payload, meta


__all__ = ["MetaProxyClient", "CapabilitiesResult"]
