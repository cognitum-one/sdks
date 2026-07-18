"""Real HTTP call logic for `chat.completions` (OpenAI-style) and
`messages.create` (Anthropic-style) -- issue #58 / M2 continuation.

Split from `test_client.py` (already covering construction/health/whoami/
models/placeholders) per ADR-0024a §D6 (error mapping) and §D7
(idempotency and retry).
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import AgenticError, StaticApiKeyCredentialProvider
from cognitum.agentic.credentials import Credential, CredentialAuthority, RedactedSecret
from cognitum.meta_llm import MetaLlmClient, MetaLlmClientConfig

BASE_URL = "https://meta-llm.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="sk-test-canary-1234",
        product="meta-llm",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


class _RefreshingCredentialProvider:
    """Credential provider that returns a fresh secret each `acquire()`
    call, so the 401-refresh-once tests can distinguish "first credential"
    from "refreshed credential" -- unlike `StaticApiKeyCredentialProvider`,
    whose `invalidate()` makes every subsequent `acquire()` fail
    permanently."""

    def __init__(self) -> None:
        self.acquire_calls = 0
        self.invalidate_calls = 0

    async def describe_authority(self, request: object) -> CredentialAuthority:
        return CredentialAuthority(
            provider_fingerprint="refreshing",
            product="meta-llm",
            normalized_origin=BASE_URL,
            audience=BASE_URL,
            principal="acct_refresh",
        )

    async def acquire(self, request: object) -> Credential:
        secret = "sk-v1" if self.acquire_calls == 0 else "sk-v2"
        self.acquire_calls += 1
        return Credential(
            scheme="X-API-Key",
            secret=RedactedSecret(secret),
            audience=BASE_URL,
            source="refreshing",
            authority=CredentialAuthority(
                provider_fingerprint="refreshing",
                product="meta-llm",
                normalized_origin=BASE_URL,
                audience=BASE_URL,
                principal="acct_refresh",
            ),
        )

    def identity(self) -> str:
        return "refreshing-credential-provider"

    async def invalidate(self, reason: str) -> None:
        del reason
        self.invalidate_calls += 1


def _chat_completion_body() -> dict:
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "meta-llm-large",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "hi there"},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def _anthropic_message_body() -> dict:
    return {
        "id": "msg-1",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": "hi there"}],
        "model": "meta-llm-large",
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


def _chat_request() -> dict:
    from cognitum.meta_llm import ChatCompletionRequest, ChatMessage

    return dict(
        request=ChatCompletionRequest(
            model="meta-llm-large", messages=[ChatMessage(role="user", content="hello")]
        )
    )


def _messages_request() -> dict:
    from cognitum.meta_llm import AnthropicMessageParam, AnthropicMessageRequest

    return dict(
        request=AnthropicMessageRequest(
            model="meta-llm-large",
            messages=[AnthropicMessageParam(role="user", content="hello")],
            max_tokens=16,
        )
    )


# ---------------------------------------------------------------------------
# Success paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_success_sends_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_chat_completion_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.chat.completions(**_chat_request())

    assert result.data.id == "chatcmpl-1"
    assert result.meta.http_status == 200
    assert route.call_count == 1
    assert "idempotency-key" in {k.lower() for k in respx.calls.last.request.headers.keys()}
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_messages_create_success_sends_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/messages").mock(
        return_value=httpx.Response(200, json=_anthropic_message_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.messages.create(**_messages_request())

    assert result.data.id == "msg-1"
    assert result.meta.http_status == 200
    assert route.call_count == 1
    await client.aclose()


# ---------------------------------------------------------------------------
# D6 error mapping -- newly added statuses (400/409/402/422)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_maps_400_to_non_retryable_validation() -> None:
    respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(400, json={"error": "bad request"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(**_chat_request())

    assert exc_info.value.kind == "validation"
    assert exc_info.value.retryable is False
    assert exc_info.value.status == 400
    assert len(respx.calls) == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_maps_409_to_non_retryable_conflict() -> None:
    respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(409, json={"error": "idempotency_mismatch"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(**_chat_request())

    assert exc_info.value.kind == "conflict"
    assert exc_info.value.retryable is False
    assert exc_info.value.status == 409
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_messages_create_maps_402_to_non_retryable_budget_exceeded() -> None:
    respx.post(f"{BASE_URL}/v1/messages").mock(
        return_value=httpx.Response(402, json={"error": "budget exceeded"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.messages.create(**_messages_request())

    assert exc_info.value.kind == "budget_exceeded"
    assert exc_info.value.retryable is False
    assert exc_info.value.status == 402
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_messages_create_maps_422_to_non_retryable_safety_blocked() -> None:
    respx.post(f"{BASE_URL}/v1/messages").mock(
        return_value=httpx.Response(422, json={"error": "safety_blocked"})
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.messages.create(**_messages_request())

    assert exc_info.value.kind == "safety_blocked"
    assert exc_info.value.retryable is False
    assert exc_info.value.status == 422
    await client.aclose()


# ---------------------------------------------------------------------------
# D7 idempotency + bounded 502/503/429 retry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_retries_502_reusing_the_same_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions")
    route.side_effect = [
        httpx.Response(502, json={"error": "bad gateway"}),
        httpx.Response(200, json=_chat_completion_body()),
    ]
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.chat.completions(**_chat_request())

    assert result.data.id == "chatcmpl-1"
    assert route.call_count == 2
    key_1 = respx.calls[0].request.headers.get("idempotency-key")
    key_2 = respx.calls[1].request.headers.get("idempotency-key")
    assert key_1 is not None
    assert key_1 == key_2, "idempotency key MUST be reused across a retry, not regenerated"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_messages_create_retries_503_reusing_the_same_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/messages")
    route.side_effect = [
        httpx.Response(503, json={"error": "unavailable"}),
        httpx.Response(200, json=_anthropic_message_body()),
    ]
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.messages.create(**_messages_request())

    assert result.data.id == "msg-1"
    assert route.call_count == 2
    key_1 = respx.calls[0].request.headers.get("idempotency-key")
    key_2 = respx.calls[1].request.headers.get("idempotency-key")
    assert key_1 == key_2
    await client.aclose()


# ---------------------------------------------------------------------------
# D6 401: at most one refresh after a verified challenge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_refreshes_credential_once_after_401_then_succeeds() -> None:
    route = respx.post(f"{BASE_URL}/v1/chat/completions")
    route.side_effect = [
        httpx.Response(401, json={"error": "expired"}),
        httpx.Response(200, json=_chat_completion_body()),
    ]
    provider = _RefreshingCredentialProvider()
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL, credential_provider=provider))

    result = await client.chat.completions(**_chat_request())

    assert result.data.id == "chatcmpl-1"
    assert route.call_count == 2
    assert provider.acquire_calls == 2
    assert provider.invalidate_calls == 1
    assert respx.calls[0].request.headers.get("x-api-key") == "sk-v1"
    assert respx.calls[1].request.headers.get("x-api-key") == "sk-v2"
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_chat_completions_does_not_retry_a_second_401() -> None:
    respx.post(f"{BASE_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(401, json={"error": "expired"})
    )
    provider = _RefreshingCredentialProvider()
    client = MetaLlmClient(MetaLlmClientConfig(base_url=BASE_URL, credential_provider=provider))

    with pytest.raises(AgenticError) as exc_info:
        await client.chat.completions(**_chat_request())

    assert exc_info.value.kind == "authentication"
    assert len(respx.calls) == 2, "exactly 2 total HTTP attempts -- original + one refresh retry"
    assert provider.acquire_calls == 2
    assert provider.invalidate_calls == 1
    await client.aclose()
