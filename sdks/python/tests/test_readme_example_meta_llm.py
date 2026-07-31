"""Exercises the exact construction + streaming shape shown in this
package's README "Agentic layer (v0.3)" section end-to-end (mocked
transport), so a future API rename fails this test instead of only being
caught by manual inspection (see cognitum-one/sdks#122).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from cognitum.agentic import StaticApiKeyCredentialProvider
from cognitum.meta_llm import ChatCompletionRequest, ChatMessage, MetaLlmClient, MetaLlmClientConfig

BASE_URL = "https://api.cognitum.one"


class _ByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


@pytest.mark.asyncio
async def test_readme_example_streams_content_delta() -> None:
    chunks = [
        b'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        b"data: [DONE]\n\n",
    ]

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_ByteStream(chunks),
        )

    transport = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    llm = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=BASE_URL,
            credential_provider=StaticApiKeyCredentialProvider(
                product="meta-llm",
                normalized_origin=BASE_URL,
                audience=BASE_URL,  # must match base_url (ADR-0022 §D3)
                api_key="sk-test-canary",
            ),
            transport=transport,
        )
    )

    request = ChatCompletionRequest(
        model="cognitum-meta-llm",
        messages=[ChatMessage(role="user", content="hello")],
    )

    deltas: list[str] = []
    async for envelope in llm.chat.completions_stream(request):
        if envelope.event.type == "content_delta":
            deltas.append(envelope.event.delta)

    assert "".join(deltas) == "hello"
