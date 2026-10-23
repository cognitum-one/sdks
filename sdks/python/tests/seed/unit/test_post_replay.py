"""A mutating POST is sent once when the seed may already have acted on it.

ADR-0005 §Idempotency rule, issue #190. A 500/502/504, a 503 without
``Retry-After``, a read timeout or a connection dropped after the request was
written may all follow a request the seed already committed, so a
non-idempotent POST (``store.ingest``) is neither resent to the same peer nor
replayed on the next one. Failures before the request left the process
(connection refused, connect timeout) are still retried and failed over, and
attested-idempotent POSTs (``store.query``) and GETs keep their retries.
"""

from __future__ import annotations

from unittest import mock

import httpx
import pytest
import respx

from cognitum._errors import CognitumError
from cognitum.seed import AsyncSeedClient, SeedClient, SeedTLS, VectorUpsert

BASE_A = "https://a:8443"
BASE_B = "https://b:8443"
INGEST = "/api/v1/store/ingest"
QUERY = "/api/v1/store/query"
STATUS = "/api/v1/status"
OK_STATUS = {
    "device_id": "dev",
    "uptime_secs": 1,
    "epoch": 0,
    "total_vectors": 0,
    "deleted_vectors": 0,
    "file_size_bytes": 0,
    "dimension": 3,
    "paired": True,
}
VECTORS = [VectorUpsert(id="a", values=(0.1, 0.2, 0.3))]

# Failures after which the seed may already have committed the request.
AMBIGUOUS = [
    pytest.param(httpx.Response(500), id="500"),
    pytest.param(httpx.Response(502), id="502"),
    pytest.param(httpx.Response(503), id="503-without-retry-after"),
    pytest.param(httpx.Response(504), id="504"),
    pytest.param(httpx.ReadTimeout("slow"), id="read-timeout"),
    pytest.param(httpx.RemoteProtocolError("dropped"), id="connection-dropped"),
    pytest.param(httpx.ReadError("reset"), id="read-error"),
    pytest.param(httpx.WriteError("broken pipe"), id="write-error"),
    pytest.param(httpx.WriteTimeout("slow upload"), id="write-timeout"),
]
# Failures before the request left the process: safe to retry and fail over.
PRE_SEND = [
    pytest.param(httpx.ConnectError("refused"), id="connect-error"),
    pytest.param(httpx.ConnectTimeout("connect"), id="connect-timeout"),
    pytest.param(httpx.PoolTimeout("no connection"), id="pool-timeout"),
    pytest.param(httpx.ProxyError("tunnel refused"), id="proxy-refused"),
]


def _outcome(effect: httpx.Response | Exception) -> dict[str, object]:
    if isinstance(effect, Exception):
        return {"side_effect": effect}
    return {"return_value": effect}


def _sync(endpoints: str | list[str]) -> SeedClient:
    return SeedClient(endpoints, tls=SeedTLS(insecure=True), max_retries=2, max_elapsed_ms=5_000)


def _async(endpoints: str | list[str]) -> AsyncSeedClient:
    return AsyncSeedClient(
        endpoints, tls=SeedTLS(insecure=True), max_retries=2, max_elapsed_ms=5_000
    )


@pytest.fixture(autouse=True)
def _no_sleep():
    with (
        mock.patch("cognitum.seed._client.time.sleep"),
        mock.patch("cognitum.seed._async_client.asyncio.sleep", new=mock.AsyncMock()),
    ):
        yield


# ---------------------------------------------------------------------------
# Sync client
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("effect", AMBIGUOUS)
@respx.mock
def test_ingest_is_not_replayed_on_the_next_peer(effect: object) -> None:
    a = respx.post(BASE_A + INGEST).mock(**_outcome(effect))
    b = respx.post(BASE_B + INGEST).mock(return_value=httpx.Response(200, json={}))
    with _sync([BASE_A, BASE_B]) as c, pytest.raises(CognitumError):
        c.store.ingest(vectors=VECTORS)
    assert (a.call_count, b.call_count) == (1, 0)


@pytest.mark.parametrize("effect", AMBIGUOUS)
@respx.mock
def test_ingest_is_not_resent_to_a_single_peer(effect: object) -> None:
    a = respx.post(BASE_A + INGEST).mock(**_outcome(effect))
    with _sync(BASE_A) as c, pytest.raises(CognitumError):
        c.store.ingest(vectors=VECTORS)
    assert a.call_count == 1


@pytest.mark.parametrize("effect", PRE_SEND)
@respx.mock
def test_ingest_fails_over_when_the_request_was_never_sent(effect: object) -> None:
    a = respx.post(BASE_A + INGEST).mock(**_outcome(effect))
    b = respx.post(BASE_B + INGEST).mock(return_value=httpx.Response(200, json={}))
    with _sync([BASE_A, BASE_B]) as c:
        c.store.ingest(vectors=VECTORS)
    assert (a.call_count, b.call_count) == (1, 1)


@respx.mock
def test_ingest_retries_a_503_that_carries_retry_after() -> None:
    a = respx.post(BASE_A + INGEST).mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": "0"}),
            httpx.Response(200, json={}),
        ]
    )
    with _sync(BASE_A) as c:
        c.store.ingest(vectors=VECTORS)
    assert a.call_count == 2


@respx.mock
def test_ingest_still_retries_after_429() -> None:
    a = respx.post(BASE_A + INGEST).mock(
        side_effect=[httpx.Response(429), httpx.Response(200, json={})]
    )
    with _sync(BASE_A) as c:
        c.store.ingest(vectors=VECTORS)
    assert a.call_count == 2


@respx.mock
def test_idempotent_query_still_fails_over_after_500() -> None:
    a = respx.post(BASE_A + QUERY).mock(return_value=httpx.Response(500))
    b = respx.post(BASE_B + QUERY).mock(return_value=httpx.Response(200, json={"results": []}))
    with _sync([BASE_A, BASE_B]) as c:
        c.store.query(vector=[0.1, 0.2, 0.3], k=1)
    assert (a.call_count, b.call_count) == (1, 1)


@respx.mock
def test_get_still_fails_over_after_read_timeout() -> None:
    a = respx.get(BASE_A + STATUS).mock(side_effect=httpx.ReadTimeout("slow"))
    b = respx.get(BASE_B + STATUS).mock(return_value=httpx.Response(200, json=OK_STATUS))
    with _sync([BASE_A, BASE_B]) as c:
        assert c.status().device_id == "dev"
    assert (a.call_count, b.call_count) == (1, 1)


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("effect", AMBIGUOUS)
@respx.mock
async def test_async_ingest_is_not_replayed_on_the_next_peer(effect: object) -> None:
    a = respx.post(BASE_A + INGEST).mock(**_outcome(effect))
    b = respx.post(BASE_B + INGEST).mock(return_value=httpx.Response(200, json={}))
    async with _async([BASE_A, BASE_B]) as c:
        with pytest.raises(CognitumError):
            await c.store.ingest(vectors=VECTORS)
    assert (a.call_count, b.call_count) == (1, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("effect", AMBIGUOUS)
@respx.mock
async def test_async_ingest_is_not_resent_to_a_single_peer(effect: object) -> None:
    a = respx.post(BASE_A + INGEST).mock(**_outcome(effect))
    async with _async(BASE_A) as c:
        with pytest.raises(CognitumError):
            await c.store.ingest(vectors=VECTORS)
    assert a.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("effect", PRE_SEND)
@respx.mock
async def test_async_ingest_fails_over_when_the_request_was_never_sent(effect: object) -> None:
    a = respx.post(BASE_A + INGEST).mock(**_outcome(effect))
    b = respx.post(BASE_B + INGEST).mock(return_value=httpx.Response(200, json={}))
    async with _async([BASE_A, BASE_B]) as c:
        await c.store.ingest(vectors=VECTORS)
    assert (a.call_count, b.call_count) == (1, 1)


@pytest.mark.asyncio
@respx.mock
async def test_async_idempotent_query_still_fails_over_after_500() -> None:
    a = respx.post(BASE_A + QUERY).mock(return_value=httpx.Response(500))
    b = respx.post(BASE_B + QUERY).mock(return_value=httpx.Response(200, json={"results": []}))
    async with _async([BASE_A, BASE_B]) as c:
        await c.store.query(vector=[0.1, 0.2, 0.3], k=1)
    assert (a.call_count, b.call_count) == (1, 1)


@respx.mock
def test_repeat_safe_ota_check_still_fails_over_after_500() -> None:
    a = respx.post(BASE_A + "/api/v1/ota/check-now").mock(return_value=httpx.Response(500))
    b = respx.post(BASE_B + "/api/v1/ota/check-now").mock(
        return_value=httpx.Response(200, json={"status": "checking"})
    )
    with _sync([BASE_A, BASE_B]) as c:
        c.ota.check_now()
    assert (a.call_count, b.call_count) == (1, 1)
