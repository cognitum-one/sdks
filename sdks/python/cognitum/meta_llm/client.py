"""MetaLlmClient (ADR-0024a). Issue #58 / M2 start.

This pass:

- implements real, HTTP-backed ``health()``, ``whoami()``, and ``models()``
  -- the "Stable-track, simplest" group per §D2's maturity table;
- implements ``capabilities()`` from the static compatibility snapshot (no
  I/O -- no runtime capabilities endpoint is published yet, §D9 gate #3);
- fails closed on ``ready(feature)`` (dependency readiness is only
  published "when published", §D1 -- nothing is published yet);
- freezes typed placeholders for ``chat.completions``, ``completions``,
  ``messages.create``, ``messages.count_tokens``, ``responses``, and
  ``embeddings`` that reject with :class:`AgenticError` until their HTTP
  logic lands in a follow-up issue.

Explicitly out of scope this pass (see PR description): streaming (§D5),
the five protocol operations' HTTP logic, and ADR-0024b routing controls.

This client is async-only (mirrors Node's Promise-native design and Rust's
async-only ``Client``) -- a sync facade may follow in a later issue if
needed, once streaming (inherently async-friendly) lands.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import AgenticError, CapabilitySet
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
from cognitum.meta_llm.types import (
    AnthropicMessage,
    AnthropicUsage,
    ChatCompletion,
    ChatCompletionChoice,
    ChatCompletionUsage,
    ChatMessage,
)

if TYPE_CHECKING:
    from cognitum.agentic import Credential
    from cognitum.meta_llm.types import (
        AnthropicMessageRequest,
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

_PRODUCT = "meta-llm"
_DEFAULT_CAPABILITY_VERSION = "0.0.0"


def _not_implemented(operation: str) -> None:
    raise AgenticError(
        "unsupported_capability",
        f"MetaLlmClient.{operation} is not implemented yet (ADR-0024a §D2/§D3 wire "
        "types only landed in issue #58 / M2 -- HTTP logic is a follow-up issue)",
        product=_PRODUCT,
        operation=operation,
        retryable=False,
    )


def _parse_chat_completion(data: dict[str, Any]) -> ChatCompletion:
    usage_data = data.get("usage")
    usage = (
        ChatCompletionUsage(
            prompt_tokens=usage_data["prompt_tokens"],
            completion_tokens=usage_data["completion_tokens"],
            total_tokens=usage_data["total_tokens"],
        )
        if usage_data
        else None
    )
    choices = [
        ChatCompletionChoice(
            index=c["index"],
            message=ChatMessage(
                role=c["message"]["role"],
                content=c["message"].get("content"),
                name=c["message"].get("name"),
                tool_call_id=c["message"].get("tool_call_id"),
                tool_calls=c["message"].get("tool_calls"),
            ),
            finish_reason=c.get("finish_reason"),
            logprobs=c.get("logprobs"),
        )
        for c in data.get("choices", [])
    ]
    return ChatCompletion(
        id=data["id"],
        object=data.get("object", "chat.completion"),
        created=data["created"],
        model=data["model"],
        choices=choices,
        usage=usage,
        system_fingerprint=data.get("system_fingerprint"),
    )


def _parse_anthropic_message(data: dict[str, Any]) -> AnthropicMessage:
    usage_data = data["usage"]
    return AnthropicMessage(
        id=data["id"],
        type=data.get("type", "message"),
        role=data["role"],
        content=data.get("content", []),
        model=data["model"],
        stop_reason=data.get("stop_reason"),
        usage=AnthropicUsage(
            input_tokens=usage_data["input_tokens"],
            output_tokens=usage_data["output_tokens"],
        ),
        stop_sequence=data.get("stop_sequence"),
    )


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
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._client._config,
            self._client._transport,
            "/v1/chat/completions",
            "chat.completions",
            body,
        )
        return MetaLlmResult(data=_parse_chat_completion(data), meta=meta)


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
        body = asdict(request)
        data, meta = await post_json_idempotent(
            self._client._config,
            self._client._transport,
            "/v1/messages",
            "messages.create",
            body,
        )
        return MetaLlmResult(data=_parse_anthropic_message(data), meta=meta)

    async def count_tokens(
        self, request: CountTokensRequest, **_kwargs: Any
    ) -> MetaLlmResult[CountTokensResult]:
        _not_implemented("messages.count_tokens")
        raise AssertionError("unreachable")


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
    # D3: protocol-specific wire types only this pass -- placeholders below
    # ------------------------------------------------------------------

    async def completions(
        self, request: LegacyCompletionRequest, **_kwargs: Any
    ) -> MetaLlmResult[LegacyCompletion]:
        _not_implemented("completions")
        raise AssertionError("unreachable")

    async def responses(
        self, request: ResponsesRequest, **_kwargs: Any
    ) -> MetaLlmResult[ResponsesResponse]:
        _not_implemented("responses")
        raise AssertionError("unreachable")

    async def embeddings(
        self, request: EmbeddingRequest, **_kwargs: Any
    ) -> MetaLlmResult[EmbeddingResponse]:
        _not_implemented("embeddings")
        raise AssertionError("unreachable")

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
