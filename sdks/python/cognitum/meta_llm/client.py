"""MetaLlmClient (ADR-0024a). Issue #58 / M2.

M2 start (PR #85):

- real, HTTP-backed ``health()``, ``whoami()``, and ``models()`` -- the
  "Stable-track, simplest" group per §D2's maturity table;
- ``capabilities()`` from the static compatibility snapshot (no I/O -- no
  runtime capabilities endpoint is published yet, §D9 gate #3);
- fails closed on ``ready(feature)`` (dependency readiness is only
  published "when published", §D1 -- nothing is published yet).

M2 continuation (PR #86): real HTTP call logic for ``chat.completions`` and
``messages.create`` -- idempotency-key generation, bounded 429/502/503
retry, and a single 401-refresh (``nonstream.py``).

This pass (issue #58 / M2 continuation): the same real HTTP call logic for
the remaining direct nonstream operations named in ADR-0024a §D7 --
``completions`` (legacy OpenAI completions), ``responses``, ``embeddings``,
and ``messages.count_tokens`` -- reusing ``nonstream.py``'s
``post_json_idempotent`` verbatim rather than a per-operation
reimplementation.

ADR-0024b D11 migration step 1 (issue #59): ``MetaLlmRoutingControls`` is
now the concrete §D2 shape and lands as an optional field on
``chat.completions``/``messages.create``/``completions``/``responses``
requests (``types/openai.py``/``types/anthropic.py``); ``usage()`` is the
new read-only, authenticated-account-scoped §D3 endpoint; and every
nonstream/stream response now decodes a ``MetaLlmReceipt`` when the server
includes one. Explicitly still out of scope: batches, pods, bench,
webhooks, guidance, collaboration, evolution, MicroLoRA, flywheel, genome,
brain, vectors, and conditional hosts (§D5-§D8) -- separate future issues
per §D11 steps 2-4.

This client is async-only (mirrors Node's Promise-native design and Rust's
async-only ``Client``) -- a sync facade may follow in a later issue if
needed, once streaming (inherently async-friendly) lands.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import AgenticError, CapabilitySet
from cognitum.agentic.scope_preflight import assert_scope_granted
from cognitum.meta_llm.config import MetaLlmClientConfig
from cognitum.meta_llm.discovery import (
    MetaLlmHealth,
    MetaLlmModelInfo,
    MetaLlmModelList,
    MetaLlmWhoAmI,
)
from cognitum.meta_llm.envelope import MetaLlmResult
from cognitum.meta_llm.http_errors import map_meta_llm_http_error
from cognitum.meta_llm.nonstream import post_json_idempotent
from cognitum.meta_llm.parsing import (
    parse_anthropic_message,
    parse_chat_completion,
    parse_count_tokens_result,
    parse_embedding_response,
    parse_legacy_completion,
    parse_responses_response,
)
from cognitum.meta_llm.stream.anthropic_events import AnthropicStreamEvent
from cognitum.meta_llm.stream.chat_completions_stream import chat_completions_stream
from cognitum.meta_llm.stream.messages_stream import messages_stream
from cognitum.meta_llm.types.routing import (
    MetaLlmRoutingControls,
    UnsendableRoutingControlsError,
    assert_sendable_routing_controls,
)
from cognitum.meta_llm.types.usage import (
    InvalidUsageQueryError,
    UsageQuery,
    UsageSummary,
    assert_valid_usage_query,
    parse_usage_summary,
)

if TYPE_CHECKING:
    from cognitum.agentic import Credential, RequestContext
    from cognitum.meta_llm.stream.envelope import MetaLlmStreamEnvelope
    from cognitum.meta_llm.stream.openai_events import OpenAiStreamEvent
    from cognitum.meta_llm.types import (
        AnthropicMessage,
        AnthropicMessageRequest,
        ChatCompletion,
        ChatCompletionRequest,
        CountTokensRequest,
        CountTokensResult,
        EmbeddingRequest,
        EmbeddingResponse,
        LegacyCompletion,
        LegacyCompletionRequest,
        ResponsesRequest,
        ResponsesResponse,
    )


def _assert_routing_controls_sendable(
    operation: str, controls: MetaLlmRoutingControls | None
) -> None:
    """Fails locally, before any network I/O or credential acquisition,
    rather than sending an unrecognized enum member or a raw provider model
    ID the resolver would reject anyway (ADR-0024b §D2).
    """
    try:
        assert_sendable_routing_controls(controls)
    except UnsendableRoutingControlsError as cause:
        raise AgenticError(
            "validation",
            f"{operation} routing_controls rejected: {cause}",
            product=_PRODUCT,
            operation=operation,
            retryable=False,
            cause=cause,
        ) from cause


_PRODUCT = "meta-llm"
_DEFAULT_CAPABILITY_VERSION = "0.0.0"


class _ChatNamespace:
    def __init__(self, client: MetaLlmClient) -> None:
        self._client = client

    async def completions(
        self, request: ChatCompletionRequest, **_kwargs: Any
    ) -> MetaLlmResult[ChatCompletion]:
        """``POST /v1/chat/completions`` (OpenAI-style). Real HTTP call
        logic (issue #58 / M2 continuation): idempotency-key generation,
        bounded 429/502/503 retry, and a single 401-refresh -- see
        ``nonstream.py``. Streaming (``request.stream = True``) is not
        validated against here -- this pass only implements the nonstream
        path (§D5 is a follow-up issue).
        """
        _assert_routing_controls_sendable("chat.completions", request.routing_controls)
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._client._config,
            self._client._transport,
            "/v1/chat/completions",
            "chat.completions",
            body,
        )
        return MetaLlmResult(data=parse_chat_completion(data), meta=meta)

    def completions_stream(
        self,
        request: ChatCompletionRequest,
        request_context: RequestContext | None = None,
        **_kwargs: Any,
    ) -> AsyncIterator[MetaLlmStreamEnvelope[OpenAiStreamEvent]]:
        """``POST /v1/chat/completions`` with ``stream=True`` (ADR-0024a
        §D5). Issue #58 / M2 continuation -- the first protocol wired onto
        the generic SSE parser (:mod:`cognitum.sse`); Anthropic Messages and
        Responses streaming are deferred follow-ups that reuse the same
        parser. Returns an async iterator -- iterate with ``async for``; it
        completes normally only after the OpenAI wire terminal condition
        (``[DONE]`` or a ``finish_reason``) is observed, otherwise it raises
        a typed ``AgenticError`` describing why (see
        ``stream/chat_completions_stream.py``).
        """
        return chat_completions_stream(
            self._client._config, self._client._transport, request, request_context
        )


class _MessagesNamespace:
    def __init__(self, client: MetaLlmClient) -> None:
        self._client = client

    async def create(
        self, request: AnthropicMessageRequest, **_kwargs: Any
    ) -> MetaLlmResult[AnthropicMessage]:
        """``POST /v1/messages`` (Anthropic-style). Real HTTP call logic
        (issue #58 / M2 continuation) -- see ``_ChatNamespace.completions``'s
        docstring and ``nonstream.py`` for the shared idempotency/retry logic.
        """
        _assert_routing_controls_sendable("messages.create", request.routing_controls)
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._client._config,
            self._client._transport,
            "/v1/messages",
            "messages.create",
            body,
        )
        return MetaLlmResult(data=parse_anthropic_message(data), meta=meta)

    async def count_tokens(
        self, request: CountTokensRequest, **_kwargs: Any
    ) -> MetaLlmResult[CountTokensResult]:
        """``POST /v1/messages/count_tokens``. Same "direct nonstream
        call" class as ``messages.create`` (ADR-0024a §D7) -- reuses
        ``post_json_idempotent`` verbatim.
        """
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._client._config,
            self._client._transport,
            "/v1/messages/count_tokens",
            "messages.count_tokens",
            body,
        )
        return MetaLlmResult(data=parse_count_tokens_result(data), meta=meta)

    def create_stream(
        self,
        request: AnthropicMessageRequest,
        request_context: RequestContext | None = None,
        **_kwargs: Any,
    ) -> AsyncIterator[MetaLlmStreamEnvelope[AnthropicStreamEvent]]:
        """``POST /v1/messages`` with ``stream=True`` (ADR-0024a §D5).
        Issue #58 / M2 continuation, item 2 of the tracked "what's left"
        list -- reuses the same generic SSE parser (:mod:`cognitum.sse`)
        ``chat.completions_stream`` wired up in PR #88. Returns an async
        iterator -- iterate with ``async for``; it completes normally only
        after the Anthropic wire terminal condition (``message_stop``) is
        observed, otherwise it raises a typed ``AgenticError`` describing
        why (see ``stream/messages_stream.py``).
        """
        return messages_stream(
            self._client._config, self._client._transport, request, request_context
        )


class MetaLlmClient:
    """Serving-protocol client for Meta LLM (ADR-0024a).

    Construction performs no I/O (ADR-0024a §D1, ADR-0019 §D3).
    """

    def __init__(self, config: MetaLlmClientConfig) -> None:
        self._config = config
        self._owns_transport = config.transport is None
        self._transport: httpx.AsyncClient = config.transport or httpx.AsyncClient()
        self.chat = _ChatNamespace(self)
        self.messages = _MessagesNamespace(self)

    # ------------------------------------------------------------------
    # D2: health, models, whoami, capabilities, ready -- implemented here
    # ------------------------------------------------------------------

    async def health(self) -> MetaLlmResult[MetaLlmHealth]:
        """Process-level health only -- never identity or readiness (ADR-0024a §D1)."""
        result = await self._get_json("/v1/health", "health", require_credential=False)
        data, meta = result
        known = {"status", "version"}
        return MetaLlmResult(
            data=MetaLlmHealth(
                status=data.get("status", "unknown"),
                version=data.get("version"),
                raw={k: v for k, v in data.items() if k not in known},
            ),
            meta=meta,
        )

    async def models(self) -> MetaLlmResult[MetaLlmModelList]:
        """``/v1/models``. May not list every alias the resolver accepts."""
        data, meta = await self._get_json("/v1/models", "models", require_credential=True)
        known_model_fields = {"id", "object", "owned_by", "created"}
        models = [
            MetaLlmModelInfo(
                id=m["id"],
                object=m.get("object"),
                owned_by=m.get("owned_by") or m.get("ownedBy"),
                created=m.get("created"),
                raw={k: v for k, v in m.items() if k not in known_model_fields},
            )
            for m in data.get("models", data.get("data", []))
        ]
        known = {"models", "data", "object"}
        return MetaLlmResult(
            data=MetaLlmModelList(
                models=models,
                object=data.get("object"),
                raw={k: v for k, v in data.items() if k not in known},
            ),
            meta=meta,
        )

    async def whoami(self) -> MetaLlmResult[MetaLlmWhoAmI]:
        """Authenticated account and credential type only (ADR-0024a §D1)."""
        data, meta = await self._get_json("/v1/whoami", "whoami", require_credential=True)
        known = {
            "account_id",
            "accountId",
            "credential_type",
            "credentialType",
            "scopes",
            "tenant_id",
            "tenantId",
        }
        return MetaLlmResult(
            data=MetaLlmWhoAmI(
                account_id=data.get("account_id") or data.get("accountId"),
                credential_type=data.get("credential_type") or data.get("credentialType"),
                scopes=data.get("scopes", []),
                tenant_id=data.get("tenant_id") or data.get("tenantId"),
                raw={k: v for k, v in data.items() if k not in known},
            ),
            meta=meta,
        )

    async def usage(self, query: UsageQuery) -> MetaLlmResult[UsageSummary]:
        """``GET /v1/usage`` (ADR-0024b §D1's ``client.usage``, D11
        migration step 1). Strictly authenticated-account scoped -- every
        query is bound to the caller's own credential; there is no
        parameter that can select another account's usage. Uses the
        contract's bounded ``YYYY-MM`` range plus optional
        ``model``/``provider``/``group_by`` grouping (§D3). An empty
        result is returned exactly as reported -- never reinterpreted as
        "no usage anywhere" vs. "this account genuinely has none" (§D3: no
        speculative fallback logic is layered on top).
        """
        try:
            assert_valid_usage_query(query)
        except InvalidUsageQueryError as cause:
            raise AgenticError(
                "validation",
                f"usage query rejected: {cause}",
                product=_PRODUCT,
                operation="usage",
                retryable=False,
                cause=cause,
            ) from cause

        from urllib.parse import urlencode

        params: dict[str, str] = {"from": query.from_, "to": query.to}
        if query.model:
            params["model"] = query.model
        if query.provider:
            params["provider"] = query.provider
        if query.group_by:
            params["group_by"] = query.group_by

        data, meta = await self._get_json(
            f"/v1/usage?{urlencode(params)}", "usage", require_credential=True
        )
        return MetaLlmResult(data=parse_usage_summary(data), meta=meta)

    def capabilities(self) -> CapabilitySet:
        """Versioned behavior safe for this caller, from the static snapshot.

        No I/O -- ADR-0024a §D9 gate #3 is not yet published. Unknown server
        versions receive the intersection of proven-safe capabilities, never
        the union (ADR-0019 §D6).
        """
        if self._config.capabilities_snapshot is not None:
            return self._config.capabilities_snapshot
        return CapabilitySet(
            product=_PRODUCT,
            product_version=_DEFAULT_CAPABILITY_VERSION,
            protocol="cognitum.meta-llm.http",
            protocol_version="1.0",
            source="static-compatibility-table",
            features={},
            limitations=["no capabilities_snapshot configured"],
            auth_methods=[],
        )

    async def ready(self, feature: str) -> None:
        """Dependency readiness for a named feature.

        Fails closed: no readiness endpoint is published yet (ADR-0024a
        §D1: "when published").
        """
        raise AgenticError(
            "unsupported_capability",
            f'ready("{feature}") is unsupported: no readiness endpoint is '
            "published for meta-llm yet",
            product=_PRODUCT,
            operation="ready",
            retryable=False,
        )

    # ------------------------------------------------------------------
    # D3/D7: remaining direct nonstream operations -- real HTTP call logic
    # (issue #58 / M2 continuation), reusing `post_json_idempotent` verbatim
    # ------------------------------------------------------------------

    async def completions(
        self, request: LegacyCompletionRequest, **_kwargs: Any
    ) -> MetaLlmResult[LegacyCompletion]:
        """``POST /v1/completions`` (legacy OpenAI completions). Real HTTP
        call logic (issue #58 / M2 continuation) -- this is a "direct
        nonstream call whose accepted contract declares safe replay" per
        ADR-0024a §D7, the same class as ``chat.completions``/
        ``messages.create``, so it reuses ``post_json_idempotent`` from
        ``nonstream.py`` verbatim.
        """
        _assert_routing_controls_sendable("completions", request.routing_controls)
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._config, self._transport, "/v1/completions", "completions", body
        )
        return MetaLlmResult(data=parse_legacy_completion(data), meta=meta)

    async def responses(
        self, request: ResponsesRequest, **_kwargs: Any
    ) -> MetaLlmResult[ResponsesResponse]:
        """``POST /v1/responses``. Current server is stateless: callers
        resend conversation input. ``previous_response_id`` is preview and
        MUST NOT be described as recovery (ADR-0024a §D3) -- this method
        does not restore or synthesize any prior conversation state; it
        only sends ``request`` as given. Real HTTP call logic (issue #58 /
        M2 continuation) reuses ``post_json_idempotent`` verbatim, same as
        ``chat.completions``.
        """
        _assert_routing_controls_sendable("responses", request.routing_controls)
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._config, self._transport, "/v1/responses", "responses", body
        )
        return MetaLlmResult(data=parse_responses_response(data), meta=meta)

    async def embeddings(
        self, request: EmbeddingRequest, **_kwargs: Any
    ) -> MetaLlmResult[EmbeddingResponse]:
        """``POST /v1/embeddings``. Real HTTP call logic (issue #58 / M2
        continuation) reuses ``post_json_idempotent`` verbatim --
        infrastructure is identical to the other direct nonstream
        operations even though embeddings has its own separate maturity
        gate criteria in ADR-0024a §D2 ("input limits, dimensions, usage,
        errors and auth published").
        """
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._config, self._transport, "/v1/embeddings", "embeddings", body
        )
        return MetaLlmResult(data=parse_embedding_response(data), meta=meta)

    async def aclose(self) -> None:
        """Close local connections and wait only.

        Never cancels a remote operation, stops a pod, releases a
        reservation, or revokes a credential (ADR-0024a §D1).
        """
        if self._owns_transport:
            await self._transport.aclose()

    async def __aenter__(self) -> MetaLlmClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    # Internal HTTP glue shared by health/whoami/models
    # ------------------------------------------------------------------

    async def _resolve_credential(self, operation: str) -> Credential | None:
        provider = self._config.credential_provider
        if provider is None:
            return None
        from cognitum.agentic import CredentialRequest

        return await provider.acquire(
            CredentialRequest(
                product=_PRODUCT,
                normalized_origin=self._config.base_url,
                audience=self._config.base_url,
                required_scopes=["meta-llm.read"],
                operation=operation,
                interactive_allowed=False,
            )
        )

    @staticmethod
    def _apply_auth(headers: dict[str, str], credential: Credential | None) -> None:
        if credential is None:
            return
        # The SDK sends exactly one contracted placement per operation
        # (ADR-0024a §D8). ``credential.scheme`` is either the literal
        # header name (e.g. ``StaticApiKeyCredentialProvider``'s default
        # "X-API-Key") or "bearer", mapped to the standard ``Authorization``
        # header.
        if credential.scheme.lower() == "bearer":
            headers["Authorization"] = f"Bearer {credential.secret.reveal()}"
        else:
            headers[credential.scheme] = credential.secret.reveal()

    async def _get_json(
        self, path: str, operation: str, *, require_credential: bool
    ) -> tuple[dict[str, Any], Any]:
        from cognitum.meta_llm.envelope import MetaLlmResponseMeta

        request_id = str(uuid.uuid4())
        started_at = time.monotonic()
        telemetry = self._config.telemetry
        if telemetry is not None:
            telemetry.on_request_start(operation, request_id)

        # ADR-0024a §D1: ``health()`` is process-level response only --
        # never identity or readiness -- so it must not acquire (or
        # attempt to acquire) a credential at all when one isn't required.
        # Only ``whoami``/``models`` (both ``require_credential=True``)
        # touch ``credential_provider`` here.
        credential: Credential | None = None
        if require_credential:
            try:
                credential = await self._resolve_credential(operation)
            except AgenticError:
                raise
            except Exception as cause:  # pragma: no cover - defensive
                raise AgenticError(
                    "authentication",
                    f"failed to acquire credential: {cause}",
                    product=_PRODUCT,
                    operation=operation,
                    request_id=request_id,
                    retryable=False,
                    cause=cause,
                ) from cause

            if credential is None:
                raise AgenticError(
                    "authentication",
                    f"MetaLlmClient.{operation} requires a credential_provider",
                    product=_PRODUCT,
                    operation=operation,
                    request_id=request_id,
                    retryable=False,
                )

            # ADR-0022 §D5 scope preflight, before any I/O below. Also
            # serves ADR-0024a §D8's "does not assume OAuth platform
            # access": an ``OAuthTokenCredentialProvider`` whose granted
            # scopes are known and cover only completion-family scopes
            # (e.g. ``meta-llm.inference``) is refused here for
            # ``usage``/``whoami``/``models`` rather than silently sent
            # through -- it never reaches "meta-llm.read".
            assert_scope_granted(_PRODUCT, operation, "meta-llm.read", credential)

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
        if telemetry is not None:
            from cognitum.meta_llm.config import MetaLlmTelemetryEvent

            telemetry.on_request_end(
                MetaLlmTelemetryEvent(
                    operation=operation,
                    request_id=request_id,
                    http_status=response.status_code,
                    duration_ms=duration_ms,
                )
            )

        if response.status_code >= 400:
            raise self._map_http_error(response, operation, request_id)

        payload: dict[str, Any] = response.json()
        meta = MetaLlmResponseMeta(
            request_id=response.headers.get("x-cognitum-request-id", request_id),
            http_status=response.status_code,
            protocol_version=response.headers.get("x-cognitum-protocol-version"),
        )
        return payload, meta

    @staticmethod
    def _map_http_error(response: httpx.Response, operation: str, request_id: str) -> AgenticError:
        # Delegates to the shared ADR-0024a §D6 table in ``http_errors.py``,
        # which also backs the idempotent-with-key POST path in
        # ``nonstream.py`` -- see that module for the full status list
        # (this pass added 400/409/402/422).
        return map_meta_llm_http_error(response, operation, request_id)


__all__ = ["MetaLlmClient"]
