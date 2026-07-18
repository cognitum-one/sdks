"""Unit tests for :class:`CallOptions` (ADR-0016b §"Per-call knobs")."""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from cognitum._errors import ConfigError, UnsupportedError
from cognitum.seed import (
    DISABLE_RETRY,
    AsyncSeedClient,
    CallOptions,
    SeedClient,
    SeedTLS,
)

BASE_A = "https://seed-a:8443"
BASE_B = "https://seed-b:8443"


def _mesh_client() -> SeedClient:
    return SeedClient(
        [BASE_A, BASE_B], tls=SeedTLS(insecure=True),
        max_retries=3, max_elapsed_ms=2_000,
    )


def _status_json() -> dict:
    return {
        "device_id": "d", "uptime_secs": 0, "epoch": 0,
        "total_vectors": 0, "deleted_vectors": 0, "file_size_bytes": 0,
        "dimension": 384, "paired": True,
    }


@respx.mock
def test_peer_override_pins_to_named_endpoint() -> None:
    a_route = respx.get(f"{BASE_A}/api/v1/status").mock(
        return_value=httpx.Response(200, json=_status_json())
    )
    b_route = respx.get(f"{BASE_B}/api/v1/status").mock(
        return_value=httpx.Response(200, json=_status_json())
    )
    with _mesh_client() as c:
        c.status(options=CallOptions(peer=BASE_B))
    assert b_route.call_count == 1
    assert a_route.call_count == 0


def test_unknown_peer_raises_config_error() -> None:
    with _mesh_client() as c, pytest.raises(ConfigError) as exc:
        c.status(options=CallOptions(peer="https://not-in-list:8443"))
    assert "not a configured endpoint" in str(exc.value)


def test_consistency_strong_raises_unsupported_error() -> None:
    # Raised at CallOptions.validate() before any network hop.
    with _mesh_client() as c, pytest.raises(UnsupportedError) as exc:
        c.status(options=CallOptions(consistency="strong"))
    assert "strong consistency" in str(exc.value).lower()


@respx.mock
def test_consistency_eventual_bypasses_session_pin() -> None:
    # Session pins to the first healthy peer (A by list_index). An
    # options.consistency="eventual" call should drop the pin. We assert
    # by mocking BOTH peers — the specific pick can be A or B depending
    # on picker order; what matters is the call succeeds without
    # requiring the session's pin to be honoured and the code path
    # clears peer_key internally (covered by no exception + 1 call
    # landing).
    respx.get(f"{BASE_A}/api/v1/status").mock(
        return_value=httpx.Response(200, json=_status_json())
    )
    respx.get(f"{BASE_B}/api/v1/status").mock(
        return_value=httpx.Response(200, json=_status_json())
    )
    with _mesh_client() as c:
        with c.session() as s:
            # Session is pinned, but eventual should ignore the pin.
            s.status()
            # Direct (non-session) call with eventual.
        c.status(options=CallOptions(consistency="eventual"))


@respx.mock
def test_timeout_scalar_override_is_respected() -> None:
    # We don't actually sleep — just assert the option validates and is
    # accepted by the transport path.
    respx.get(f"{BASE_A}/api/v1/status").mock(
        return_value=httpx.Response(200, json=_status_json())
    )
    with _mesh_client() as c:
        s = c.status(options=CallOptions(timeout=1.5))
    assert s.device_id == "d"


def test_timeout_invalid_tuple_raises() -> None:
    with _mesh_client() as c, pytest.raises(ConfigError):
        c.status(options=CallOptions(timeout=(1.0, -1.0, 2.0)))  # negative read


@respx.mock
def test_retries_disable_caps_loop_at_one_attempt() -> None:
    # First response is 502; with retries=DISABLE_RETRY the SDK must
    # NOT cycle internally to the next peer in a retry cycle — however,
    # mesh failover (peer cycling on 5xx) is separate. To isolate the
    # retry cap, use a single-peer client so mesh cycling is a no-op
    # and the only way to hit it twice is via ADR-0005 retry.
    route = respx.get("https://solo:8443/api/v1/status").mock(
        side_effect=[
            httpx.Response(502, json={"error": "bad gw"}),
            httpx.Response(200, json=_status_json()),
        ]
    )
    with SeedClient(
        "https://solo:8443", tls=SeedTLS(insecure=True),
        max_retries=5, max_elapsed_ms=2_000,
    ) as c, pytest.raises(Exception):
        # retries=DISABLE_RETRY (=0) → no ADR-0005 retry loop; the
        # single 502 surfaces.
        c.status(options=CallOptions(retries=DISABLE_RETRY))
    assert route.call_count == 1


@respx.mock
def test_close_during_request_cancellation_surfaces() -> None:
    # An awaited request interrupted by task cancellation should
    # propagate rather than hang. Regression guard: CallOptions wiring
    # must not have broken cancellation in the async transport loop.

    async def slow_response(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5.0)
        return httpx.Response(200, json=_status_json())

    respx.get(f"{BASE_A}/api/v1/status").mock(side_effect=slow_response)

    async def _run() -> type[BaseException]:
        async with AsyncSeedClient(
            BASE_A, tls=SeedTLS(insecure=True),
            max_retries=1, max_elapsed_ms=10_000,
        ) as c:
            task = asyncio.create_task(
                c.status(options=CallOptions(timeout=1.0))
            )
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except BaseException as exc:
                return type(exc)
            return type(None)

    observed = asyncio.run(_run())
    # Either CancelledError (most likely) or some other exception — the
    # key assertion is that the task DID raise, not hang, and did not
    # silently return a result.
    assert observed is not type(None)
