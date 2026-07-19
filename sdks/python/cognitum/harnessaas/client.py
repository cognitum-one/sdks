"""``HarnessaaSClient`` (ADR-0027a, ADR-0019 §D2). Issue #67/#68 / M5 start.

**Scope (2026-07-19 reconciliation audit, issue #67):** this pass covers
ONLY the real, deployed, SYNCHRONOUS surface of ``cognitum-one/harnessaas``
-- construction (zero I/O), ``health()``, ``solve()``, and ``lineage()``. It
deliberately does NOT build against ADR-0027a's "Decision" section (an async
``SolveHandle``/job/poll/SSE/approval/cancel/artifact contract under
``/v1/solves/*``) -- that is an explicit PROPOSAL for something that does
not exist in the running service yet (``docs/adr/0027a-*.md``'s
reconciliation note; ``src/server.ts:367-501`` at ``908e4a99`` is one HTTP
request in, one ``SolveResponse`` out, full stop). Also explicitly out of
scope this pass: the webhook admin routes, the MicroLoRA flywheel API
(``/microlora/*`` -- confirmed a SEPARATE future decision by the same
reconciliation audit), and the authenticated ``/api/v1/*`` IBO-console relay.

**Auth:** a ``cog_``-prefixed API key, sent as ``X-API-Key`` (preferred) or
``Authorization: Bearer`` (verified at ``src/auth.ts:1-24,256-264``) -- the
SAME shape Meta LLM uses, so ``StaticApiKeyCredentialProvider`` works as-is.

**Retry safety (ADR-0023, the Meta Proxy PR #93 lesson):** ``solve()`` is
genuinely non-idempotent from this client's point of view -- no
``Idempotency-Key`` handling of any kind exists anywhere in the upstream
service and there is no in-app rate limiter, so a lost response after a
429/502/503/5xx/transport failure cannot be distinguished from "the sandbox
clone/model call/test run already started spending." Automatically
retrying would risk exactly the duplicate-spend/duplicate-execution failure
mode independent review found in Meta Proxy's non-streaming forwarding
(ADR-0025a, PR #93, commit ``eb553f7``). ``solve()`` therefore makes exactly
ONE HTTP attempt for every outcome except a verified 401 challenge (auth
happens server-side BEFORE any spend -- ``src/server.ts`` calls
``authenticate()`` as the very first thing in the ``POST /solve`` handler --
so a single credential-refresh-and-retry there is provably zero-spend-safe).
``lineage()`` is a plain ``GET`` (a safe read per ADR-0023 §D3) and gets a
bounded 429/502/503 retry; ``health()`` is a single unauthenticated ``GET``
with no retry loop, matching ``MetaLlmClient.health()``'s pattern.

This client is async-only, matching ``MetaLlmClient``/``MetaProxyClient``.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import (
    DEFAULT_RETRY_POLICY,
    AgenticError,
    CapabilitySet,
    equal_jitter_delay_ms,
)
from cognitum.harnessaas.config import HarnessaaSClientConfig
from cognitum.harnessaas.discovery import HarnessaaSHealth, parse_harnessaas_health
from cognitum.harnessaas.envelope import HarnessaaSResponseMeta, HarnessaaSResult
from cognitum.harnessaas.http_errors import map_harnessaas_http_error
from cognitum.harnessaas.types import (
    HarnessaaSLineageResult,
    HarnessaaSSolveRequest,
    HarnessaaSSolveResponse,
    parse_lineage_result,
    parse_solve_response,
)

if TYPE_CHECKING:
    from cognitum.agentic import Credential

_PRODUCT = "harnessaas"
_DEFAULT_CAPABILITY_VERSION = "0.0.0"


class HarnessaaSClient:
    """Client for the real, deployed, synchronous HarnessaaS surface
    (ADR-0027a). Construction performs no I/O (ADR-0019 §D3). Never composes
    Meta LLM, Meta Proxy, or MetaHarness (ADR-0019 §D4).
    """

    def __init__(self, config: HarnessaaSClientConfig) -> None:
        self._config = config
        self._owns_transport = config.transport is None
        self._transport: httpx.AsyncClient = config.transport or httpx.AsyncClient()

    def capabilities(self) -> CapabilitySet:
        """Versioned behavior safe for this caller, from the static
        compatibility snapshot (no I/O). Unknown server versions receive
        the intersection of proven-safe capabilities, never the union.
        """
        if self._config.capabilities_snapshot is not None:
            return self._config.capabilities_snapshot
        return CapabilitySet(
            product=_PRODUCT,
            product_version=_DEFAULT_CAPABILITY_VERSION,
            protocol="cognitum.harnessaas.http",
            protocol_version="1.0",
            source="static-compatibility-table",
            features={},
            limitations=["no capabilities_snapshot configured"],
            auth_methods=[],
        )

    async def health(self) -> HarnessaaSResult[HarnessaaSHealth]:
        """``GET /health`` -- process health only. Unauthenticated on the
        real service (never acquires a credential, even when one is
        configured). Single HTTP attempt, no retry loop.

        Calls ``GET /health``, NOT ``/healthz`` -- see
        ``cognitum.harnessaas.discovery``'s module docstring for why
        ``/healthz`` is unreliable from outside the container on Cloud Run.
        """
        data, meta = await self._send_get_once("/health", "health", credential=None)
        return HarnessaaSResult(data=parse_harnessaas_health(data), meta=meta)

    async def solve(
        self, request: HarnessaaSSolveRequest
    ) -> HarnessaaSResult[HarnessaaSSolveResponse]:
        """``POST /solve`` -- genuinely synchronous: one HTTP request, one
        full ``SolveResponse`` back inline. See this module's docstring for
        why this makes exactly one HTTP attempt for every outcome except a
        verified 401 (safe to refresh-and-retry once) --
        429/502/503/5xx/transport failures are NEVER retried automatically.

        This pass does not perform local ADR-0022 §D5 scope preflight:
        unlike Meta LLM/Meta Proxy's single required-scope-string
        convention, the real server-side authorization is a tier-ladder CAP
        over multiple alternative scopes (any of
        ``completions:low``/``mid``/``high`` lets a solve proceed, just at a
        capped tier -- ``src/auth.ts``'s ``authorizeGenome``), which this
        client does not replicate client-side. The server remains
        authoritative; a 403 surfaces as ``permission_denied``.
        """
        body = request.to_wire()
        credential = await self._require_credential("solve")
        refreshed_once = False

        while True:
            try:
                data, meta = await self._send_post_once("/solve", "solve", body, credential)
                return HarnessaaSResult(data=parse_solve_response(data), meta=meta)
            except AgenticError as err:
                if err.status == 401 and not refreshed_once:
                    refreshed_once = True
                    if self._config.credential_provider is not None:
                        await self._config.credential_provider.invalidate(
                            "401 challenge from harnessaas"
                        )
                    credential = await self._require_credential("solve")
                    continue
                # Every other outcome -- 429/502/503/5xx/transport included
                # -- is a single terminal error. No idempotency-key contract
                # exists server-side, so a retry here risks duplicate
                # untrusted-repository execution and duplicate model spend
                # (the exact Meta Proxy PR #93 failure mode).
                raise

    async def lineage(self, request_id: str) -> HarnessaaSResult[HarnessaaSLineageResult]:
        """``GET /lineage/:id`` -- a safe read (ADR-0023 §D3), so bounded
        429/502/503 retry is appropriate here, unlike ``solve()``. A
        ``request_id`` from another tenant collapses to the same 404 as an
        absent one (anti-enumeration).
        """
        if not request_id:
            raise AgenticError(
                "validation",
                "lineage request_id is required",
                product=_PRODUCT,
                operation="lineage",
                retryable=False,
            )
        from urllib.parse import quote

        path = f"/lineage/{quote(request_id, safe='')}"
        credential = await self._require_credential("lineage")
        refreshed_once = False
        retry_policy = DEFAULT_RETRY_POLICY
        attempt = 0
        sleep_budget_used_ms = 0.0

        while True:
            try:
                data, meta = await self._send_get_once(path, "lineage", credential=credential)
                return HarnessaaSResult(data=parse_lineage_result(data), meta=meta)
            except AgenticError as err:
                if err.status == 401 and not refreshed_once:
                    refreshed_once = True
                    if self._config.credential_provider is not None:
                        await self._config.credential_provider.invalidate(
                            "401 challenge from harnessaas"
                        )
                    credential = await self._require_credential("lineage")
                    continue
                is_bounded_retryable = err.status in (429, 502, 503)
                if is_bounded_retryable and attempt + 1 < retry_policy.max_attempts:
                    import random

                    server_hint_ms = err.retry_after_ms or 0
                    jitter_ms = random.uniform(0, retry_policy.base_ms)
                    delay_ms = equal_jitter_delay_ms(
                        attempt, retry_policy, server_hint_ms, int(jitter_ms)
                    )
                    if sleep_budget_used_ms + delay_ms > retry_policy.retry_sleep_budget_ms:
                        raise
                    sleep_budget_used_ms += delay_ms
                    await asyncio.sleep(delay_ms / 1000)
                    attempt += 1
                    continue
                raise

    async def aclose(self) -> None:
        """Close local connections and wait only. Never cancels a remote
        solve -- there is no remote job to cancel.
        """
        if self._owns_transport:
            await self._transport.aclose()

    async def __aenter__(self) -> HarnessaaSClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    # Internal HTTP glue
    # ------------------------------------------------------------------

    async def _require_credential(self, operation: str) -> Credential:
        provider = self._config.credential_provider
        if provider is None:
            raise AgenticError(
                "authentication",
                f"HarnessaaSClient.{operation} requires a credential_provider",
                product=_PRODUCT,
                operation=operation,
                retryable=False,
            )
        from cognitum.agentic import CredentialRequest

        return await provider.acquire(
            CredentialRequest(
                product=_PRODUCT,
                normalized_origin=self._config.base_url,
                audience=self._config.base_url,
                # No single required-scope string -- see `solve()`'s docstring.
                required_scopes=[],
                operation=operation,
                interactive_allowed=False,
            )
        )

    @staticmethod
    def _apply_auth(headers: dict[str, str], credential: Credential | None) -> None:
        if credential is None:
            return
        # Exactly one contracted placement per operation (`src/auth.ts:256-264`
        # accepts EITHER `X-API-Key` OR `Authorization: Bearer`, never both).
        if credential.scheme.lower() == "bearer":
            headers["Authorization"] = f"Bearer {credential.secret.reveal()}"
        else:
            headers[credential.scheme] = credential.secret.reveal()

    async def _send_get_once(
        self, path: str, operation: str, *, credential: Credential | None
    ) -> tuple[dict[str, Any], HarnessaaSResponseMeta]:
        request_id = str(uuid.uuid4())
        started_at = time.monotonic()
        telemetry = self._config.telemetry
        if telemetry is not None:
            telemetry.on_request_start(operation, request_id)

        headers = {"Accept": "application/json", "X-Cognitum-Request-Id": request_id}
        self._apply_auth(headers, credential)

        url = f"{self._config.base_url}{path}"
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
        retry_after_header = response.headers.get("retry-after")
        retry_after_ms = int(float(retry_after_header) * 1000) if retry_after_header else None
        if telemetry is not None:
            from cognitum.harnessaas.config import HarnessaaSTelemetryEvent

            telemetry.on_request_end(
                HarnessaaSTelemetryEvent(
                    operation=operation,
                    request_id=request_id,
                    http_status=response.status_code,
                    duration_ms=duration_ms,
                    retry_after_ms=retry_after_ms,
                )
            )

        if response.status_code >= 400:
            err = map_harnessaas_http_error(response, operation, request_id)
            if err.retry_after_ms is None and retry_after_ms is not None:
                err.retry_after_ms = retry_after_ms
            raise err

        payload: dict[str, Any] = response.json()
        meta = HarnessaaSResponseMeta(
            request_id=response.headers.get("x-cognitum-request-id", request_id),
            http_status=response.status_code,
            retry_after_ms=retry_after_ms,
        )
        return payload, meta

    async def _send_post_once(
        self, path: str, operation: str, body: dict[str, Any], credential: Credential
    ) -> tuple[dict[str, Any], HarnessaaSResponseMeta]:
        request_id = str(uuid.uuid4())
        started_at = time.monotonic()
        telemetry = self._config.telemetry
        if telemetry is not None:
            telemetry.on_request_start(operation, request_id)

        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Cognitum-Request-Id": request_id,
        }
        self._apply_auth(headers, credential)

        url = f"{self._config.base_url}{path}"
        try:
            response = await self._transport.post(url, headers=headers, json=body)
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
            from cognitum.harnessaas.config import HarnessaaSTelemetryEvent

            telemetry.on_request_end(
                HarnessaaSTelemetryEvent(
                    operation=operation,
                    request_id=request_id,
                    http_status=response.status_code,
                    duration_ms=duration_ms,
                    retry_after_ms=retry_after_ms,
                )
            )

        if response.status_code >= 400:
            err = map_harnessaas_http_error(response, operation, request_id)
            if err.retry_after_ms is None and retry_after_ms is not None:
                err.retry_after_ms = retry_after_ms
            raise err

        payload: dict[str, Any] = response.json()
        meta = HarnessaaSResponseMeta(
            request_id=response.headers.get("x-cognitum-request-id", request_id),
            http_status=response.status_code,
            retry_after_ms=retry_after_ms,
        )
        return payload, meta


__all__ = ["HarnessaaSClient"]
