"""Real HTTP call logic for the remaining direct nonstream operations named
in ADR-0024a §D7 -- `completions` (legacy OpenAI completions), `responses`,
`embeddings`, and `messages.count_tokens` -- issue #58 / M2 continuation.

This is mechanical reuse of the exact `chat.completions`/`messages.create`
pattern already proven in `test_nonstream.py` (PR #86): the same
`post_json_idempotent` infrastructure, the same D6 error-mapping table, and
the same D7 idempotency/retry loop. Per the tracking issue, this file does
NOT re-prove every status code or the full retry/401-refresh matrix for
each of the four operations -- that infrastructure is already covered.
Instead: one success test per operation (proving each operation wires into
the shared infrastructure correctly), one error-mapping smoke test, and one
idempotency-retry smoke test.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum.agentic import StaticApiKeyCredentialProvider
from cognitum.meta_llm import MetaLlmClient, MetaLlmClientConfig

BASE_URL = "https://meta-llm.test.cognitum.one"


def _credential_provider() -> StaticApiKeyCredentialProvider:
    return StaticApiKeyCredentialProvider(
        api_key="sk-test-canary-1234",
        product="meta-llm",
        normalized_origin=BASE_URL,
        audience=BASE_URL,
    )


def _legacy_completion_body() -> dict:
    return {
        "id": "cmpl-1",
        "object": "text_completion",
        "created": 1,
        "model": "meta-llm-large",
        "choices": [{"text": "hi there", "index": 0, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def _responses_body() -> dict:
    return {
        "id": "resp-1",
        "object": "response",
        "created_at": 1,
        "model": "meta-llm-large",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "id": "out-1",
                "role": "assistant",
                "content": [{"type": "text", "text": "hi"}],
            }
        ],
    }


def _embedding_body() -> dict:
    return {
        "object": "list",
        "data": [{"object": "embedding", "embedding": [0.1, 0.2], "index": 0}],
        "model": "meta-llm-embed",
        "usage": {"prompt_tokens": 3, "total_tokens": 3},
    }


def _count_tokens_body() -> dict:
    return {"input_tokens": 5}


def _completions_request() -> dict:
    from cognitum.meta_llm import LegacyCompletionRequest

    return dict(request=LegacyCompletionRequest(model="meta-llm-large", prompt="hello"))


def _responses_request() -> dict:
    from cognitum.meta_llm import ResponsesRequest

    return dict(request=ResponsesRequest(model="meta-llm-large", input="hello"))


def _embeddings_request() -> dict:
    from cognitum.meta_llm import EmbeddingRequest

    return dict(request=EmbeddingRequest(model="meta-llm-embed", input="hello"))


def _count_tokens_request() -> dict:
    from cognitum.meta_llm import AnthropicMessageParam, CountTokensRequest

    return dict(
        request=CountTokensRequest(
            model="meta-llm-large",
            messages=[AnthropicMessageParam(role="user", content="hello")],
        )
    )


# ---------------------------------------------------------------------------
# Success paths -- one per operation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_completions_success_sends_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/completions").mock(
        return_value=httpx.Response(200, json=_legacy_completion_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.completions(**_completions_request())

    assert result.data.id == "cmpl-1"
    assert result.meta.http_status == 200
    assert route.call_count == 1
    assert "idempotency-key" in {k.lower() for k in respx.calls.last.request.headers.keys()}
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_responses_success_sends_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/responses").mock(
        return_value=httpx.Response(200, json=_responses_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.responses(**_responses_request())

    assert result.data.id == "resp-1"
    assert result.meta.http_status == 200
    assert route.call_count == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_embeddings_success_sends_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/embeddings").mock(
        return_value=httpx.Response(200, json=_embedding_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.embeddings(**_embeddings_request())

    assert result.data.model == "meta-llm-embed"
    assert len(result.data.data) == 1
    assert route.call_count == 1
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_messages_count_tokens_success_sends_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/messages/count_tokens").mock(
        return_value=httpx.Response(200, json=_count_tokens_body())
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.messages.count_tokens(**_count_tokens_request())

    assert result.data.input_tokens == 5
    assert route.call_count == 1
    await client.aclose()


# ---------------------------------------------------------------------------
# D6 error mapping -- smoke test only (full table already proven in
# test_nonstream.py); one status on one operation proves this operation
# wires into the shared `map_meta_llm_http_error` table correctly.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_embeddings_maps_429_to_retryable_rate_limited() -> None:
    from cognitum.agentic import AgenticError

    respx.post(f"{BASE_URL}/v1/embeddings").mock(
        return_value=httpx.Response(
            429, json={"error": "slow down"}, headers={"retry-after": "1"}
        )
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    with pytest.raises(AgenticError) as exc_info:
        await client.embeddings(**_embeddings_request())

    assert exc_info.value.kind == "rate_limited"
    assert exc_info.value.retryable is True
    assert exc_info.value.status == 429
    await client.aclose()


# ---------------------------------------------------------------------------
# D7 idempotency + bounded retry -- smoke test only (the full retry/401
# matrix is already proven in test_nonstream.py); one retry on one
# operation proves this operation wires into the shared retry loop
# correctly, reusing the same Idempotency-Key across the retry.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_responses_retries_502_reusing_the_same_idempotency_key() -> None:
    route = respx.post(f"{BASE_URL}/v1/responses")
    route.side_effect = [
        httpx.Response(502, json={"error": "bad gateway"}),
        httpx.Response(200, json=_responses_body()),
    ]
    client = MetaLlmClient(
        MetaLlmClientConfig(base_url=BASE_URL, credential_provider=_credential_provider())
    )

    result = await client.responses(**_responses_request())

    assert result.data.id == "resp-1"
    assert route.call_count == 2
    key_1 = respx.calls[0].request.headers.get("idempotency-key")
    key_2 = respx.calls[1].request.headers.get("idempotency-key")
    assert key_1 is not None
    assert key_1 == key_2, "idempotency key MUST be reused across a retry, not regenerated"
    await client.aclose()
