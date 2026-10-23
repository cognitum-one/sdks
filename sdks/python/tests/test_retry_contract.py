"""ADR-0005 transport-retry rule and RFC 9110 ``Retry-After`` handling.

- A POST is resent after a transport failure only when the request never
  left this process (connect refused/timed out, no pooled connection). A
  ReadTimeout may follow a request the server already accepted, so it is
  not resent; Node behaves the same way.
- ``Retry-After`` may be an HTTP-date. ``float()`` on one raised a bare
  ``ValueError`` while an error was being mapped, instead of the typed SDK
  error.
"""

from __future__ import annotations

import time
from email.utils import formatdate
from unittest import mock

import httpx
import pytest
import respx

from cognitum import Cognitum, CognitumError
from cognitum._http import AsyncHttpClient
from cognitum.agentic import StaticApiKeyCredentialProvider
from cognitum.errors import RateLimitError
from cognitum.meta_llm import ChatCompletionRequest, ChatMessage, MetaLlmClient, MetaLlmClientConfig

BASE_URL = "https://api.test.cognitum.one"
LLM_URL = "https://meta-llm.test.cognitum.one"
MESSAGE = {"name": "Ada", "email": "ada@example.com", "message": "hello"}


def _http_date(offset_s: int) -> str:
    return formatdate(time.time() + offset_s, usegmt=True)


@pytest.fixture(autouse=True)
def sleeps():
    with mock.patch("cognitum._http.time.sleep") as sync_sleep, mock.patch(
        "asyncio.sleep", new=mock.AsyncMock()
    ) as async_sleep:
        yield sync_sleep, async_sleep


# ---------------------------------------------------------------------------
# Transport failures
# ---------------------------------------------------------------------------


@respx.mock
def test_post_is_not_resent_after_read_timeout() -> None:
    route = respx.post(f"{BASE_URL}/sendContactEmail").mock(
        side_effect=httpx.ReadTimeout("read timed out")
    )
    with Cognitum(api_key="k", base_url=BASE_URL, max_retries=3) as client:
        with pytest.raises(CognitumError, match="Transport error"):
            client.contact.send(**MESSAGE)
    assert route.call_count == 1


@respx.mock
def test_post_is_retried_after_connect_error() -> None:
    route = respx.post(f"{BASE_URL}/sendContactEmail").mock(
        side_effect=[httpx.ConnectError("refused"), httpx.Response(200, json={})]
    )
    with Cognitum(api_key="k", base_url=BASE_URL, max_retries=3) as client:
        client.contact.send(**MESSAGE)
    assert route.call_count == 2


@respx.mock
def test_get_is_retried_after_read_timeout() -> None:
    route = respx.get(f"{BASE_URL}/health").mock(
        side_effect=[httpx.ReadTimeout("slow"), httpx.Response(200, json={"status": "ok"})]
    )
    with Cognitum(api_key="k", base_url=BASE_URL, max_retries=3) as client:
        assert client.health().status == "ok"
    assert route.call_count == 2


@pytest.mark.asyncio
@respx.mock
async def test_async_post_is_not_resent_after_read_timeout() -> None:
    route = respx.post(f"{BASE_URL}/sendContactEmail").mock(
        side_effect=httpx.ReadTimeout("read timed out")
    )
    client = AsyncHttpClient(BASE_URL, "k", max_retries=3)
    try:
        with pytest.raises(CognitumError, match="Transport error"):
            await client.post("/sendContactEmail", json=MESSAGE)
    finally:
        await client.close()
    assert route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_async_post_is_retried_after_connect_timeout() -> None:
    route = respx.post(f"{BASE_URL}/sendContactEmail").mock(
        side_effect=[httpx.ConnectTimeout("connect timed out"), httpx.Response(200, json={})]
    )
    client = AsyncHttpClient(BASE_URL, "k", max_retries=3)
    try:
        await client.post("/sendContactEmail", json=MESSAGE)
    finally:
        await client.close()
    assert route.call_count == 2


# ---------------------------------------------------------------------------
# Retry-After as an HTTP-date
# ---------------------------------------------------------------------------


@respx.mock
def test_429_with_http_date_retry_after_raises_rate_limit_error() -> None:
    respx.post(f"{BASE_URL}/sendContactEmail").mock(
        return_value=httpx.Response(
            429, json={"error": "slow down"}, headers={"Retry-After": _http_date(120)}
        )
    )
    with Cognitum(api_key="k", base_url=BASE_URL) as client:
        with pytest.raises(RateLimitError) as excinfo:
            client.contact.send(**MESSAGE)
    assert excinfo.value.retry_after_seconds is not None
    assert 100 <= excinfo.value.retry_after_seconds <= 120


@respx.mock
def test_retry_loop_waits_for_http_date_retry_after(sleeps) -> None:
    sync_sleep, _ = sleeps
    route = respx.get(f"{BASE_URL}/health").mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": _http_date(20)}),
            httpx.Response(200, json={"status": "ok"}),
        ]
    )
    with Cognitum(api_key="k", base_url=BASE_URL, max_retries=2) as client:
        assert client.health().status == "ok"
    assert route.call_count == 2
    # The hint, not the 0.5 s backoff, decides the wait.
    (delay,), _ = sync_sleep.call_args
    assert 15 <= delay <= 20


@respx.mock
def test_retry_after_hint_is_capped_at_30_seconds(sleeps) -> None:
    sync_sleep, _ = sleeps
    respx.get(f"{BASE_URL}/health").mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": _http_date(3600)}),
            httpx.Response(200, json={"status": "ok"}),
        ]
    )
    with Cognitum(api_key="k", base_url=BASE_URL, max_retries=2) as client:
        client.health()
    sync_sleep.assert_called_once_with(30.0)


@pytest.mark.asyncio
@respx.mock
async def test_async_retry_after_hint_is_honoured_and_capped(sleeps) -> None:
    _, async_sleep = sleeps
    respx.get(f"{BASE_URL}/health").mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": _http_date(20)}),
            httpx.Response(503, headers={"Retry-After": "7200"}),
            httpx.Response(200, json={"status": "ok"}),
        ]
    )
    client = AsyncHttpClient(BASE_URL, "k", max_retries=3)
    try:
        await client.get("/health")
    finally:
        await client.close()
    delays = [call.args[0] for call in async_sleep.call_args_list]
    assert len(delays) == 2
    assert 15 <= delays[0] <= 20
    assert delays[1] == 30.0


@pytest.mark.asyncio
@respx.mock
async def test_meta_llm_accepts_http_date_retry_after() -> None:
    respx.post(f"{LLM_URL}/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 1,
                "model": "meta-llm-large",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "hi"},
                        "finish_reason": "stop",
                    }
                ],
            },
            headers={"Retry-After": _http_date(30)},
        )
    )
    client = MetaLlmClient(
        MetaLlmClientConfig(
            base_url=LLM_URL,
            credential_provider=StaticApiKeyCredentialProvider(
                api_key="sk-test-canary-1234",
                product="meta-llm",
                normalized_origin=LLM_URL,
                audience=LLM_URL,
            ),
        )
    )
    result = await client.chat.completions(
        ChatCompletionRequest(
            model="meta-llm-large", messages=[ChatMessage(role="user", content="hello")]
        )
    )
    assert result.meta.retry_after_ms is not None
    assert 20_000 <= result.meta.retry_after_ms <= 30_000


@pytest.mark.parametrize("product", ["meta-proxy", "harnessaas"])
def test_product_429_mapping_accepts_http_date_retry_after(product: str) -> None:
    from cognitum.harnessaas.http_errors import map_harnessaas_http_error
    from cognitum.meta_proxy.http_errors import map_meta_proxy_http_error

    mapper = map_meta_proxy_http_error if product == "meta-proxy" else map_harnessaas_http_error
    response = httpx.Response(429, text="slow down", headers={"Retry-After": _http_date(60)})
    err = mapper(response, "test.operation", "req-1")
    assert err.kind == "rate_limited"
    assert err.retry_after_ms is not None
    assert 50_000 <= err.retry_after_ms <= 60_000
