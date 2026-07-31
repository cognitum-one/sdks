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

- §D5 data-plane and policy model (``RoutingIntent``, plane/policy rules) --
  implemented (:mod:`cognitum.meta_proxy.routing`);
- §D6 authentication and workload capabilities beyond the minimal
  ``CredentialProvider`` this pass's constructor accepts;
- §D7 inference/forwarding contract (``chat.completions``, ``messages``) --
  implemented (:mod:`cognitum.meta_proxy.nonstream`);
- §D8 streaming, errors, cancellation, and retry for the data plane --
  implemented (:mod:`cognitum.meta_proxy.stream.chat_completions_stream`);
- §D9 consent, sponsor budget, and usage -- the TRACTABLE slice (consent
  gating for the ``cognitum_cloud`` plane, :mod:`cognitum.meta_proxy.consent`)
  is implemented; sponsor budget/usage remain BLOCKED on ADR-0025b's
  lifecycle/state fixes and are explicitly out of scope (see
  ``preview.sponsored`` below);
- §D10 loopback and browser security -- loopback-origin validation
  (:mod:`cognitum.meta_proxy.config`) is implemented; browser-runtime
  rejection is N/A (Python has no browser/WASM distribution surface for
  this package); non-loopback remote exposure remains dangerous preview,
  unimplemented by design.

This client is async-only, mirroring :class:`cognitum.meta_llm.client.MetaLlmClient`.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import AgenticError, UnsupportedCapabilityError
from cognitum.meta_proxy.config import MetaProxyClientConfig
from cognitum.meta_proxy.consent import assert_consent_for_routing_intent
from cognitum.meta_proxy.envelope import (
    MetaProxyResponseMeta,
    MetaProxyResult,
    collect_unknown_headers,
)
from cognitum.meta_proxy.http_errors import map_meta_proxy_http_error
from cognitum.meta_proxy.nonstream import post_chat_forwarding
from cognitum.meta_proxy.routing import (
    RoutingIntent,
    assert_routing_receipt_matches_intent,
)
from cognitum.meta_proxy.status import MetaProxyStatus
from cognitum.meta_proxy.stream.chat_completions_stream import chat_completions_stream
from cognitum.meta_proxy.time_budget import ProxyTimeBudget

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping

    from cognitum.agentic import Credential, RequestContext
    from cognitum.meta_llm.types import ChatCompletion, ChatCompletionRequest
    from cognitum.meta_proxy.stream.envelope import MetaProxyStreamEnvelope

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


@dataclass(frozen=True)
class MetaProxyChatCallOptions:
    """Per-call options for ``chat.completions()`` (ADR-0025a §D5/§D7).

    ``forward_headers`` is a caller-supplied header bag that is
    ALLOWLIST-FILTERED before anything reaches the wire (§D7): only the
    approved forwarding headers survive, so a caller cannot smuggle an
    ``Authorization`` override, ``Host``, sponsor marker, or training-consent
    header through it -- those are derived from validated local state.
    """

    routing_intent: RoutingIntent | None = None
    forward_headers: Mapping[str, str] | None = None
    request_context: RequestContext | None = None


class _ChatNamespace:
    """``client.chat`` namespace object, mirroring
    :class:`cognitum.meta_llm.client.MetaLlmClient`'s ``chat`` attribute.
    """

    def __init__(self, client: MetaProxyClient) -> None:
        self._client = client

    async def completions(
        self,
        request: ChatCompletionRequest,
        options: MetaProxyChatCallOptions | None = None,
    ) -> MetaProxyResult[ChatCompletion]:
        """``POST /v1/chat/completions`` through the Proxy (non-streaming
        only, ADR-0025a §D7). Reuses the Meta LLM ``ChatCompletionRequest``/
        ``ChatCompletion`` wire types (§D7: "reuse only the wire types")
        while remaining a Proxy method that returns a Proxy routing receipt.

        Forwards ONLY the §D7-allowlisted caller headers plus SDK-owned
        headers and the validated local bearer; generates an idempotency
        key; performs a single 401 refresh and bounded 429/502/503 retry;
        rejects redirects (§D10). When ``options.routing_intent`` pins a
        ``required_plane``, the returned routing receipt is verified against
        it at decode time -- a mismatch raises a non-retryable
        ``protocol`` error even on an otherwise-valid 200 (§D5 rule 7).
        """
        from dataclasses import asdict

        from cognitum.meta_llm.parsing import parse_chat_completion

        opts = options or MetaProxyChatCallOptions()

        # ADR-0025a §D9: fail closed on missing consent BEFORE any HTTP I/O --
        # a valid local bearer credential is never a substitute for the
        # ADR-0022 consent grant a cognitum_cloud RoutingIntent requires.
        assert_consent_for_routing_intent(
            opts.routing_intent,
            self._client._config.consent_grants or [],
            self._client._config.origin,
            "chat.completions",
        )

        body = asdict(request)
        data, meta = await post_chat_forwarding(
            self._client._config,
            self._client._transport,
            "/v1/chat/completions",
            "chat.completions",
            body,
            opts.forward_headers,
        )

        intent = opts.routing_intent
        if intent is not None and intent.required_plane is not None:
            receipt = meta.routing_receipt
            if receipt is None:
                raise AgenticError(
                    "protocol",
                    "chat.completions required_plane "
                    f'"{intent.required_plane}" cannot be verified: the Proxy '
                    "returned no routing receipt (ADR-0025a §D4: every inference "
                    "must return selected-plane evidence)",
                    product=_PRODUCT,
                    operation="chat.completions",
                    request_id=meta.request_id,
                    retryable=False,
                )
            assert_routing_receipt_matches_intent(intent, receipt)

        return MetaProxyResult(data=parse_chat_completion(data), meta=meta)

    def completions_stream(
        self,
        request: ChatCompletionRequest,
        options: MetaProxyChatCallOptions | None = None,
        *,
        time_budget: ProxyTimeBudget | None = None,
        cancellation: Any = None,
    ) -> AsyncIterator[MetaProxyStreamEnvelope]:
        """``POST /v1/chat/completions`` through the Proxy with
        ``stream=True`` (ADR-0025a §D8). Async-generator method -- iterate
        with ``async for``. Reuses the same §D7 forwarding allowlist,
        credential acquisition, and routing-receipt decode as
        :meth:`completions`; adds `ProxyTimeBudget`, plane/version stream
        metadata, and the §D5 rule 7 required-plane check applied to the
        final observed streaming receipt. See
        :mod:`cognitum.meta_proxy.stream.chat_completions_stream` for the
        full contract.
        """
        from dataclasses import asdict

        opts = options or MetaProxyChatCallOptions()
        body = asdict(request)
        return chat_completions_stream(
            self._client._config,
            self._client._transport,
            body,
            forward_headers=opts.forward_headers,
            routing_intent=opts.routing_intent,
            time_budget=time_budget,
            cancellation=cancellation,
        )


class _SponsoredChatNamespace:
    """``client.preview.sponsored.chat`` namespace (ADR-0025a §D1 topology, §D9 preview).

    Sponsored forwarding itself (budget, receipts, atomic spend) is
    explicitly OUT of scope this pass (§D9 defers to ADR-0025b's
    lifecycle/state fixes) -- this namespace exists ONLY to fail fast, with
    zero HTTP I/O, per §D1 ("Such a call returns ``UnsupportedCapabilityError``
    before HTTP I/O") and §D8 ("Sponsored ``stream = true`` fails locally
    until an end-to-end stream capability exists"). Streaming and
    non-streaming sponsored calls both fail this pass; the error message
    distinguishes the two so a caller who only hit the streaming
    restriction isn't told sponsor support is entirely absent when
    non-stream sponsor lands in a later pass.
    """

    async def completions(
        self, request: ChatCompletionRequest, **_kwargs: Any
    ) -> MetaProxyResult[ChatCompletion]:
        if getattr(request, "stream", False):
            raise UnsupportedCapabilityError(
                _PRODUCT,
                "preview.sponsored.chat.completions",
                "sponsored-inference-streaming",
                "Sponsored stream=True fails locally until an end-to-end stream "
                "capability exists (ADR-0025a §D8) -- this SDK pass does not "
                "implement sponsored streaming at all.",
            )
        raise UnsupportedCapabilityError(
            _PRODUCT,
            "preview.sponsored.chat.completions",
            "sponsored-inference",
            "Sponsored chat.completions forwarding is not implemented this pass "
            "(ADR-0025a §D9 consent/sponsor-budget/usage is explicitly out of "
            "scope; ADR-0025b's lifecycle/state fixes are a prerequisite for "
            "stable sponsor support).",
        )


class _PreviewNamespace:
    """``client.preview`` namespace (ADR-0025a §D1)."""

    def __init__(self) -> None:
        self.sponsored = _SponsoredNamespace()


class _SponsoredNamespace:
    def __init__(self) -> None:
        self.chat = _SponsoredChatNamespace()


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
        # ADR-0025a §D6/§D10: the default transport ignores ambient HTTP
        # proxy env vars (``trust_env=False`` -- httpx honors HTTP_PROXY/
        # HTTPS_PROXY by default) and never follows redirects
        # (``follow_redirects=False``, pinned explicitly rather than relying
        # on the library default silently staying safe).
        self._transport: httpx.AsyncClient = self._config.transport or httpx.AsyncClient(
            trust_env=False, follow_redirects=False
        )
        self.chat = _ChatNamespace(self)
        self.preview = _PreviewNamespace()

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
            unknown_headers=collect_unknown_headers(response.headers),
        )
        return payload, meta


__all__ = ["MetaProxyClient", "CapabilitiesResult", "MetaProxyChatCallOptions"]
