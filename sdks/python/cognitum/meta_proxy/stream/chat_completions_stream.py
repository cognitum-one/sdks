"""``chat_completions_stream`` HTTP + SSE orchestration for ``MetaProxyClient``
(ADR-0025a §D8, M3 continuation of issue #61).

§D8: "Chat and Messages use ADR-0024a's lossless protocol streams and add
plane and Proxy version metadata." This module REUSES, rather than
reimplements:

- PR #88's generic byte-level SSE parser (:mod:`cognitum.sse`);
- PR #88/#93's OpenAI event decoder
  (:mod:`cognitum.meta_llm.stream.openai_events`) -- the byte-forwarded
  stream is decoded exactly like direct Meta LLM streaming (the Proxy
  forwards the same OpenAI wire shape verbatim, §D7: "reuse only the wire
  types and stream events");
- :mod:`cognitum.meta_proxy.nonstream`'s §D7 header allowlist, credential
  acquisition, bearer placement, and routing-receipt decode helpers, so a
  caller sees byte-for-byte identical forwarding behavior whether they call
  the streaming or non-streaming method.

On top of the reused pieces, this module adds exactly what §D8 asks for
beyond ADR-0024a's stream contract:

- ``MetaProxyStreamEnvelope.proxy_meta`` (plane/version metadata,
  ``./envelope.py``);
- ``ProxyTimeBudget``'s ``connect_timeout_ms``/``overall_deadline_ms``
  (``../time_budget.py``), raced around the pre-byte HTTP attempt(s) in
  addition to the first-byte/idle races PR #88 already proved correct for
  the post-byte read loop;
- the §D5 rule 7 required-plane check
  (:func:`cognitum.meta_proxy.routing.assert_routing_receipt_matches_intent`,
  the SAME function the non-streaming path uses), applied to the LAST
  routing receipt observed on the wire before the stream's native terminal
  event.

Retry contract (ADR-0025a §D8, and the just-fixed eb553f7 bug this MUST NOT
reintroduce): the pre-byte phase performs at most one 401-triggered
credential refresh and NEVER bounded-retries a 429/502/503 -- "No Proxy POST
is automatically retried while it drops ``Idempotency-Key``" describes the
currently-deployed Proxy dropping the header server-side, not whether the
SDK attaches one; attaching one client-side does not make a retry safe. A
non-2xx pre-byte response is therefore always a single terminal,
non-retryable error (``err.retry_after_ms`` lets the CALLER retry manually).
Once any response byte has been read, there is NO retry at all, period --
mirroring PR #88's :mod:`cognitum.meta_llm.stream.chat_completions_stream`
exactly.

Sponsored streaming (``stream=True`` on a sponsored-plane call) is
explicitly OUT of scope this pass -- see
:meth:`cognitum.meta_proxy.client.MetaProxyClient`'s
``preview_sponsored_chat_completions`` for the fail-fast guard (§D8:
"Sponsored ``stream = true`` fails locally until an end-to-end stream
capability exists").
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Mapping
from typing import TYPE_CHECKING, Any

import httpx

from cognitum.agentic import AgenticError
from cognitum.meta_llm.stream.envelope import MetaLlmStreamEnvelope
from cognitum.meta_llm.stream.openai_events import OpenAiStreamEvent, decode_openai_sse_event
from cognitum.meta_proxy.envelope import MetaProxyUpstreamReceipt
from cognitum.meta_proxy.nonstream import (
    _apply_bearer,
    _require_bearer,
    filter_forwardable_headers,
    parse_meta_proxy_routing_receipt,
)
from cognitum.meta_proxy.routing import RoutingIntent, assert_routing_receipt_matches_intent
from cognitum.meta_proxy.status import MetaProxyRoutingReceipt
from cognitum.meta_proxy.stream.envelope import MetaProxyStreamEnvelope, MetaProxyStreamMeta
from cognitum.meta_proxy.time_budget import ProxyTimeBudget, resolve_proxy_time_budget
from cognitum.sse import SseEvent, SseParseError, SseParser

if TYPE_CHECKING:
    from cognitum.agentic import Credential
    from cognitum.meta_proxy.config import MetaProxyClientConfig

_PRODUCT = "meta-proxy"
_OPERATION = "chat.completions_stream"
_CHAT_PATH = "/v1/chat/completions"


def _new_request_id() -> str:
    return str(uuid.uuid4())


def _now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _deadline_error(request_id: str, code: str, message: str, sequence: int) -> AgenticError:
    return AgenticError(
        "deadline_exceeded",
        message,
        product=_PRODUCT,
        operation=_OPERATION,
        request_id=request_id,
        retryable=False,
        code=code,
        details={"partial": True, "events_received": sequence},
    )


async def _open_stream_with_pre_byte_retry(
    config: MetaProxyClientConfig,
    transport: httpx.AsyncClient,
    body: dict[str, Any],
    request_id: str,
    idempotency_key: str,
    forwarded_headers: dict[str, str],
    budget: Any,
    overall_started_at: float,
) -> tuple[httpx.Response, Any]:
    """The pre-byte phase: acquire a credential, send the request, and retry
    ONLY on a verified 401 (once) -- never on 429/502/503 (ADR-0025a §D8, the
    just-fixed eb553f7 bug this must not reintroduce). Each attempt is raced
    against ``min(connect_timeout_ms, overall_deadline_ms remaining)``.
    Returns the entered response plus its context manager (the caller is
    responsible for exiting it once streaming is done).
    """
    credential: Credential = await _require_bearer(config, _OPERATION)

    refreshed_once = False

    while True:
        now = time.monotonic()
        elapsed_ms = (now - overall_started_at) * 1000
        if budget.overall_deadline_ms is not None and elapsed_ms > budget.overall_deadline_ms:
            raise _deadline_error(
                request_id,
                "overall_deadline_exceeded",
                f"{_OPERATION} exceeded overall_deadline_ms ({budget.overall_deadline_ms}ms) "
                "before a response was received",
                0,
            )
        overall_remaining_ms = (
            max(0.0, budget.overall_deadline_ms - elapsed_ms)
            if budget.overall_deadline_ms is not None
            else None
        )
        connect_remaining_ms = (
            min(budget.connect_timeout_ms, overall_remaining_ms)
            if overall_remaining_ms is not None
            else budget.connect_timeout_ms
        )

        headers = dict(forwarded_headers)
        headers["Accept"] = "text/event-stream"
        headers["Content-Type"] = "application/json"
        headers["X-Cognitum-Request-Id"] = request_id
        headers["Idempotency-Key"] = idempotency_key

        from cognitum.meta_proxy.config import bearer_target_allowed

        if not bearer_target_allowed(config.origin, config.allow_non_loopback):
            raise AgenticError(
                "authentication",
                f"{_OPERATION} refused to attach a local bearer to non-loopback origin "
                f'"{config.origin}" (ADR-0025a §D6/§D10)',
                product=_PRODUCT,
                operation=_OPERATION,
                request_id=request_id,
                retryable=False,
            )
        _apply_bearer(headers, credential)

        url = f"{config.origin}{_CHAT_PATH}"
        cm = transport.stream("POST", url, headers=headers, json=body)
        try:
            response = await asyncio.wait_for(
                cm.__aenter__(), timeout=connect_remaining_ms / 1000
            )
        except asyncio.TimeoutError as cause:
            overall_exceeded = (
                budget.overall_deadline_ms is not None
                and (time.monotonic() - overall_started_at) * 1000 > budget.overall_deadline_ms
            )
            raise _deadline_error(
                request_id,
                "overall_deadline_exceeded" if overall_exceeded else "connect_timeout",
                (
                    f"{_OPERATION} exceeded overall_deadline_ms ({budget.overall_deadline_ms}ms) "
                    "before a response was received"
                    if overall_exceeded
                    else f"{_OPERATION} exceeded connect_timeout_ms "
                    f"({budget.connect_timeout_ms}ms) waiting for a response"
                ),
                0,
            ) from cause
        except httpx.HTTPError as cause:
            raise AgenticError(
                "transport",
                f"{_OPERATION} request failed: {cause}",
                product=_PRODUCT,
                operation=_OPERATION,
                request_id=request_id,
                retryable=True,
                cause=cause,
            ) from cause

        if response.status_code < 400:
            return response, cm

        try:
            await response.aread()
            from cognitum.meta_proxy.http_errors import map_meta_proxy_http_error

            err = map_meta_proxy_http_error(response, _OPERATION, request_id)
            retry_after_header = response.headers.get("retry-after")
            if err.retry_after_ms is None and retry_after_header:
                err.retry_after_ms = int(float(retry_after_header) * 1000)
        finally:
            await cm.__aexit__(None, None, None)

        if err.status == 401 and not refreshed_once:
            refreshed_once = True
            if config.local_credential_provider is not None:
                await config.local_credential_provider.invalidate("401 challenge from meta-proxy")
            credential = await _require_bearer(config, _OPERATION)
            continue

        # ADR-0025a §D8 / eb553f7: NEVER bounded-retry 429/502/503 (or any
        # other status) here -- a single terminal error, exactly matching
        # non-streaming `post_chat_forwarding` in `../nonstream.py`.
        raise err


def _decode_proxy_chunk(
    raw_event: SseEvent,
) -> tuple[list[OpenAiStreamEvent], dict[str, Any] | None, MetaProxyRoutingReceipt | None, Any]:
    decoded = decode_openai_sse_event(raw_event)
    unknown = decoded.unknown_fields or {}
    routing_receipt = parse_meta_proxy_routing_receipt(unknown.get("cognitum_routing_receipt"))
    upstream_receipt = unknown.get("cognitum_upstream_receipt")
    return decoded.events, decoded.unknown_fields, routing_receipt, upstream_receipt


async def _read_proxy_sse_body(
    response: httpx.Response,
    request_id: str,
    budget: Any,
    overall_started_at: float,
    cancellation: Any,
    routing_intent: RoutingIntent | None,
) -> AsyncIterator[MetaProxyStreamEnvelope]:
    """Post-byte phase: read the SSE body, decode into ``MetaProxyStreamEnvelope``s,
    applying ``idle_stream_timeout_ms``/``first_byte_timeout_ms``/
    ``overall_deadline_ms`` and cooperative cancellation. The blocking
    ``body_iter.__anext__()`` await is ALWAYS raced against the smallest
    remaining budget (never merely checked before/after) -- PR #88 shipped
    an initial version that only checked-before, letting a server that goes
    silent without closing hang forever; this mirrors the fixed pattern from
    the start.
    """
    parser = SseParser()
    sequence_box = [0]
    saw_native_terminal = False
    last_byte_at = overall_started_at
    received_first_byte = False
    latest_routing_receipt: MetaProxyRoutingReceipt | None = None
    latest_upstream_receipt: MetaProxyUpstreamReceipt | None = None

    product_version = response.headers.get("x-cognitum-product-version")
    protocol_version = response.headers.get("x-cognitum-protocol-version")

    body_iter = response.aiter_bytes().__aiter__()

    def build_envelopes(raw_event: SseEvent) -> list[MetaProxyStreamEnvelope]:
        nonlocal latest_routing_receipt, latest_upstream_receipt
        events, unknown_fields, routing_receipt, upstream_receipt = _decode_proxy_chunk(raw_event)
        if routing_receipt is not None:
            latest_routing_receipt = routing_receipt
        if upstream_receipt is not None:
            latest_upstream_receipt = upstream_receipt
        envelopes = []
        for event in events:
            sequence_box[0] += 1
            inner = MetaLlmStreamEnvelope(
                event=event,
                sequence=sequence_box[0],
                received_at=_now_iso(),
                request_id=request_id,
                raw_event_name=raw_event.event,
                unknown_fields=unknown_fields,
            )
            proxy_meta = MetaProxyStreamMeta(
                product_version=product_version,
                protocol_version=protocol_version,
                routing_receipt=latest_routing_receipt,
                upstream_receipt=latest_upstream_receipt,
            )
            envelopes.append(MetaProxyStreamEnvelope(inner=inner, proxy_meta=proxy_meta))
        return envelopes

    def is_terminal(event: OpenAiStreamEvent) -> bool:
        # A wire-level terminal error event is ALSO a valid stream terminus
        # (ADR-0025a §D8: "still requires ... terminal error") -- not just
        # the clean done/finish_reason path.
        return event.type in ("done", "finish_reason", "error")

    try:
        while True:
            if cancellation is not None and cancellation.is_cancelled:
                raise AgenticError(
                    "cancelled",
                    f"{_OPERATION} was cancelled locally",
                    product=_PRODUCT,
                    operation=_OPERATION,
                    request_id=request_id,
                    retryable=False,
                    code="local_cancellation",
                    details={"partial": True, "events_received": sequence_box[0]},
                )

            now = time.monotonic()
            elapsed_overall_ms = (now - overall_started_at) * 1000
            overall_deadline_ms = budget.overall_deadline_ms
            if overall_deadline_ms is not None and elapsed_overall_ms > overall_deadline_ms:
                raise _deadline_error(
                    request_id,
                    "overall_deadline_exceeded",
                    f"{_OPERATION} exceeded overall_deadline_ms ({overall_deadline_ms}ms)",
                    sequence_box[0],
                )

            idle_limit_ms = (
                budget.idle_stream_timeout_ms
                if received_first_byte
                else budget.first_byte_timeout_ms
            )
            idle_field_name = (
                "idle_stream_timeout_ms" if received_first_byte else "first_byte_timeout_ms"
            )
            if idle_limit_ms is not None:
                silence_ms = (now - last_byte_at) * 1000
                if silence_ms > idle_limit_ms:
                    raise _deadline_error(
                        request_id,
                        "idle_stream_timeout" if received_first_byte else "first_byte_timeout",
                        f"{_OPERATION} exceeded {idle_field_name} ({idle_limit_ms}ms)",
                        sequence_box[0],
                    )

            remaining_wait_candidates: list[float] = []
            if idle_limit_ms is not None:
                idle_remaining = idle_limit_ms / 1000 - (now - last_byte_at)
                remaining_wait_candidates.append(max(0.0, idle_remaining))
            if budget.overall_deadline_ms is not None:
                remaining_wait_candidates.append(
                    max(0.0, budget.overall_deadline_ms / 1000 - (now - overall_started_at))
                )
            remaining_wait = min(remaining_wait_candidates) if remaining_wait_candidates else None

            try:
                if remaining_wait is not None:
                    chunk = await asyncio.wait_for(
                        body_iter.__anext__(), timeout=remaining_wait or 0.001
                    )
                else:
                    chunk = await body_iter.__anext__()
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                continue  # loop back around; the top-of-loop deadline check will raise precisely
            except httpx.HTTPError as cause:
                raise AgenticError(
                    "transport",
                    f"{_OPERATION} stream read failed: {cause}",
                    product=_PRODUCT,
                    operation=_OPERATION,
                    request_id=request_id,
                    retryable=False,
                    code="stream_disconnected",
                    details={"partial": True, "events_received": sequence_box[0]},
                    cause=cause,
                ) from cause

            received_first_byte = True
            last_byte_at = time.monotonic()

            try:
                raw_events = parser.feed(chunk)
            except SseParseError as cause:
                raise AgenticError(
                    "protocol",
                    f"{_OPERATION} SSE parse failure: {cause}",
                    product=_PRODUCT,
                    operation=_OPERATION,
                    request_id=request_id,
                    retryable=False,
                    code="sse_parse_error",
                    details={"partial": True, "events_received": sequence_box[0]},
                    cause=cause,
                ) from cause

            for raw_event in raw_events:
                for envelope in build_envelopes(raw_event):
                    if is_terminal(envelope.event):
                        saw_native_terminal = True
                    yield envelope

        try:
            finish_result = parser.finish()
        except SseParseError as cause:
            raise AgenticError(
                "protocol",
                f"{_OPERATION} SSE parse failure at end of stream: {cause}",
                product=_PRODUCT,
                operation=_OPERATION,
                request_id=request_id,
                retryable=False,
                code="sse_parse_error",
                details={"partial": True, "events_received": sequence_box[0]},
                cause=cause,
            ) from cause

        for raw_event in finish_result.events:
            for envelope in build_envelopes(raw_event):
                if is_terminal(envelope.event):
                    saw_native_terminal = True
                yield envelope
    except GeneratorExit:
        raise

    if not saw_native_terminal:
        raise AgenticError(
            "protocol",
            f"{_OPERATION} stream ended without ever observing a terminal event",
            product=_PRODUCT,
            operation=_OPERATION,
            request_id=request_id,
            retryable=False,
            code="stream_ended_without_terminal_event",
            details={"partial": True, "events_received": sequence_box[0]},
        )

    # ADR-0025a §D5 rule 7, applied to the streaming case exactly like
    # non-streaming `post_chat_forwarding` (`../nonstream.py`): a caller
    # `required_plane` that the final observed receipt contradicts (or that
    # no receipt ever arrived to verify) is a protocol violation even though
    # the stream otherwise completed normally.
    if routing_intent is not None and routing_intent.required_plane is not None:
        if latest_routing_receipt is None:
            raise AgenticError(
                "protocol",
                f"{_OPERATION} required_plane "
                f'"{routing_intent.required_plane}" cannot be verified: the stream never '
                "carried a routing receipt (ADR-0025a §D4: every inference must return "
                "selected-plane evidence)",
                product=_PRODUCT,
                operation=_OPERATION,
                request_id=request_id,
                retryable=False,
            )
        assert_routing_receipt_matches_intent(routing_intent, latest_routing_receipt)


async def chat_completions_stream(
    config: MetaProxyClientConfig,
    transport: httpx.AsyncClient,
    request: dict[str, Any],
    *,
    forward_headers: Mapping[str, str] | None = None,
    routing_intent: RoutingIntent | None = None,
    time_budget: ProxyTimeBudget | None = None,
    cancellation: Any = None,
    request_id: str | None = None,
) -> AsyncIterator[MetaProxyStreamEnvelope]:
    """``POST /v1/chat/completions`` through the Proxy with ``stream=True``
    (ADR-0025a §D8). Async-generator function -- iterate with ``async for``.
    """
    forwarded = filter_forwardable_headers(forward_headers)
    idempotency_key = forwarded.pop("Idempotency-Key", None) or str(uuid.uuid4())
    resolved_request_id = request_id or _new_request_id()
    budget = resolve_proxy_time_budget(time_budget)
    overall_started_at = time.monotonic()

    body = {**request, "stream": True}
    response, cm = await _open_stream_with_pre_byte_retry(
        config,
        transport,
        body,
        resolved_request_id,
        idempotency_key,
        forwarded,
        budget,
        overall_started_at,
    )
    try:
        async for envelope in _read_proxy_sse_body(
            response, resolved_request_id, budget, overall_started_at, cancellation, routing_intent
        ):
            yield envelope
    finally:
        await cm.__aexit__(None, None, None)


__all__ = ["chat_completions_stream"]
