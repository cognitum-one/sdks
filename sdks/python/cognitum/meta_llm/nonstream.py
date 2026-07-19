"""Non-streaming HTTP call logic for the two "direct nonstream call[s]
whose accepted contract declares safe replay" named in ADR-0024a §D7:
``chat.completions`` and ``messages.create``. Issue #58 / M2 continuation.

Deliberately out of scope here (see the tracking issue): streaming/SSE
parsing (§D5) and the other three protocol operations (``completions``,
``responses``, ``embeddings``) -- both since folded into ``client.py``/this
module in later passes.

ADR-0024b D11 migration step 1 (issue #59): this module now also decodes a
``MetaLlmReceipt`` from the response body when the server includes one
(``cognitum_receipt``). ``routing_controls`` validation happens in
``client.py`` before this module's ``asdict``-produced ``body`` is even
constructed, not here -- this module only sees the plain dict, not the
original dataclass.

Retry (ADR-0023 §D3/§D4, ADR-0024a §D6):

- 401: at most one credential refresh after a verified challenge (the 401
  response itself), then retry once with the same idempotency key and
  body. A second 401 is returned as-is.
- 429/502/503: bounded retry using the frozen ``RetryPolicy`` /
  ``equal_jitter_delay_ms`` (ADR-0005/ADR-0023 verbatim), gated on the
  idempotency-with-key binding built in ``idempotency.py`` -- this is what
  makes the replay safe.
- 400/403/404/409/402/422 and anything else: never retried.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from typing import TYPE_CHECKING, Any, TypeVar

import httpx

from cognitum.agentic import DEFAULT_RETRY_POLICY, AgenticError, equal_jitter_delay_ms
from cognitum.agentic.scope_preflight import assert_scope_granted
from cognitum.meta_llm.envelope import MetaLlmResponseMeta
from cognitum.meta_llm.http_errors import map_meta_llm_http_error
from cognitum.meta_llm.idempotency import build_idempotency_binding, canonical_request_sha256
from cognitum.meta_llm.types.receipt import parse_meta_llm_receipt

if TYPE_CHECKING:
    from cognitum.agentic import Credential
    from cognitum.meta_llm.config import MetaLlmClientConfig

_PRODUCT = "meta-llm"
#: Required scope for the inference-serving operations in this pass.
#: Distinct from ``client.py``'s ``"meta-llm.read"`` -- these are mutating
#: generation calls, not discovery reads (ADR-0024a §D8).
_INFERENCE_SCOPE = "meta-llm.inference"

#: Per-operation required-scope map for ADR-0022 §D5's scope preflight,
#: covering every "completion-family route" per ADR-0024a §D8 that shares
#: this module's ``post_json_idempotent``/credential path.
#:
#: PROVISIONAL: no ADR-0020 OpenAPI/JSON-Schema contract bundle publishing
#: a real scope-token vocabulary exists yet (ADR-0024a §D9 gate #1/#8), so
#: every completion-family operation maps to the same literal
#: ``_INFERENCE_SCOPE`` already used in the ``CredentialRequest`` sent to
#: ``acquire()`` below -- this names the mapping explicitly so a real
#: per-operation vocabulary can slot in later without changing the
#: preflight call site.
_OPERATION_REQUIRED_SCOPE: dict[str, str] = {
    "chat.completions": _INFERENCE_SCOPE,
    "chat.completions_stream": _INFERENCE_SCOPE,
    "messages.create": _INFERENCE_SCOPE,
    "messages.count_tokens": _INFERENCE_SCOPE,
    "completions": _INFERENCE_SCOPE,
    "responses": _INFERENCE_SCOPE,
    "embeddings": _INFERENCE_SCOPE,
}

T = TypeVar("T")


def _apply_auth(headers: dict[str, str], credential: Credential) -> None:
    # The SDK sends exactly one contracted placement per operation
    # (ADR-0024a §D8) -- same rule as ``client.py``'s GET path.
    if credential.scheme.lower() == "bearer":
        headers["Authorization"] = f"Bearer {credential.secret.reveal()}"
    else:
        headers[credential.scheme] = credential.secret.reveal()


async def _require_credential(config: MetaLlmClientConfig, operation: str) -> Credential:
    from cognitum.agentic import CredentialRequest

    provider = config.credential_provider
    if provider is None:
        raise AgenticError(
            "authentication",
            f"MetaLlmClient.{operation} requires a credential_provider",
            product=_PRODUCT,
            operation=operation,
            retryable=False,
        )
    required_scope = _OPERATION_REQUIRED_SCOPE.get(operation, _INFERENCE_SCOPE)
    credential = await provider.acquire(
        CredentialRequest(
            product=_PRODUCT,
            normalized_origin=config.base_url,
            audience=config.base_url,
            required_scopes=[required_scope],
            operation=operation,
            interactive_allowed=False,
        )
    )
    # ADR-0022 §D5 scope preflight: fail closed BEFORE any I/O when the
    # credential's granted scopes are known and insufficient. A credential
    # with unknown (``None``) granted scopes -- e.g.
    # ``StaticApiKeyCredentialProvider``'s today -- is sent through
    # unchecked; the server remains authoritative for that case.
    assert_scope_granted(_PRODUCT, operation, required_scope, credential)
    return credential


async def _send_post_once(
    config: MetaLlmClientConfig,
    transport: httpx.AsyncClient,
    path: str,
    operation: str,
    body: dict[str, Any],
    credential: Credential,
    idempotency_key: str,
) -> tuple[dict[str, Any], MetaLlmResponseMeta]:
    """One HTTP attempt. Never retries by itself -- the caller owns that."""
    request_id = str(uuid.uuid4())
    telemetry = config.telemetry
    if telemetry is not None:
        telemetry.on_request_start(operation, request_id)
    started_at = time.monotonic()

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Cognitum-Request-Id": request_id,
        # ADR-0024a §D7 / ADR-0005: the caller-attested idempotency key,
        # stable across every retry of one logical call.
        "Idempotency-Key": idempotency_key,
    }
    _apply_auth(headers, credential)

    url = f"{config.base_url}{path}"
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
    idempotent_replay_header = response.headers.get("x-cognitum-idempotent-replay")
    idempotent_replay = (
        idempotent_replay_header.lower() == "true" if idempotent_replay_header is not None else None
    )

    if telemetry is not None:
        from cognitum.meta_llm.config import MetaLlmTelemetryEvent

        telemetry.on_request_end(
            MetaLlmTelemetryEvent(
                operation=operation,
                request_id=request_id,
                http_status=response.status_code,
                duration_ms=duration_ms,
                retry_after_ms=retry_after_ms,
                idempotent_replay=idempotent_replay,
            )
        )

    if response.status_code >= 400:
        err = map_meta_llm_http_error(response, operation, request_id)
        if err.retry_after_ms is None:
            err.retry_after_ms = retry_after_ms
        raise err

    data: dict[str, Any] = response.json()
    # ADR-0024b §D3/§D11 step 1: decode a `cognitum_receipt` field embedded
    # in the response body, if present, into the typed `MetaLlmReceipt` --
    # same wire key the SSE path already recognizes
    # (`stream/openai_events.py`).
    receipt = parse_meta_llm_receipt(data.get("cognitum_receipt"))
    meta = MetaLlmResponseMeta(
        request_id=response.headers.get("x-cognitum-request-id", request_id),
        http_status=response.status_code,
        protocol_version=response.headers.get("x-cognitum-protocol-version"),
        retry_after_ms=retry_after_ms,
        idempotent_replay=idempotent_replay,
        receipt=receipt,
    )
    return data, meta


async def post_json_idempotent(
    config: MetaLlmClientConfig,
    transport: httpx.AsyncClient,
    path: str,
    operation: str,
    body: dict[str, Any],
) -> tuple[dict[str, Any], MetaLlmResponseMeta]:
    """Shared idempotent-with-key POST used by ``chat.completions`` and
    ``messages.create``. Returns the parsed JSON body plus response
    metadata; callers construct their own protocol-specific response type.
    """
    credential = await _require_credential(config, operation)
    idempotency_key = str(uuid.uuid4())
    canonical_sha256 = canonical_request_sha256(body)
    tenant = config.default_request_context.tenant if config.default_request_context else None

    retry_policy = DEFAULT_RETRY_POLICY
    attempt = 0
    sleep_budget_used_ms = 0.0
    refreshed_once = False

    while True:
        # Binding is (re)built each attempt so a refreshed credential's
        # principal/tenant is reflected, but ``idempotency_key`` /
        # ``canonical_sha256`` (and therefore the binding's identity)
        # never change across retries.
        build_idempotency_binding(
            operation, path, credential, tenant, canonical_sha256, idempotency_key
        )

        try:
            return await _send_post_once(
                config, transport, path, operation, body, credential, idempotency_key
            )
        except AgenticError as err:
            if err.status == 401 and not refreshed_once:
                refreshed_once = True
                if config.credential_provider is not None:
                    await config.credential_provider.invalidate("401 challenge from meta-llm")
                credential = await _require_credential(config, operation)
                continue

            is_bounded_retryable = err.status in (429, 502, 503)
            if is_bounded_retryable and attempt + 1 < retry_policy.max_attempts:
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


__all__ = ["post_json_idempotent"]
