"""Retry loop and end-to-end parsing via respx mocks.

These are still unit tests (no live seed) — they just exercise the sync client
end-to-end with respx intercepting httpx.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from cognitum._errors import (
    AuthError,
    AuthReason,
    NotFoundError,
    NotImplementedError as SeedNotImplementedError,
    RateLimitError,
    ValidationError,
)
from cognitum.seed import SeedClient, SeedTLS, VectorUpsert


BASE = "https://localhost:18443"


def _client() -> SeedClient:
    # max_elapsed_ms tiny so slow paths fail fast in CI.
    return SeedClient(
        BASE,
        tls=SeedTLS(insecure=True),
        max_retries=2,
        max_elapsed_ms=2_000,
    )


@respx.mock
def test_status_parses_extra() -> None:
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(
            200,
            json={
                "device_id": "dev",
                "uptime_secs": 1,
                "epoch": 0,
                "total_vectors": 0,
                "deleted_vectors": 0,
                "file_size_bytes": 0,
                "dimension": 384,
                "paired": True,
                "witness_chain_length": 42,
            },
        )
    )
    with _client() as c:
        s = c.status()
    assert s.device_id == "dev"
    assert s.extra["witness_chain_length"] == 42


@respx.mock
def test_identity() -> None:
    respx.get(f"{BASE}/api/v1/identity").mock(
        return_value=httpx.Response(200, json={"device_id": "d", "public_key": "k"})
    )
    with _client() as c:
        i = c.identity()
    assert i.device_id == "d"
    assert i.public_key == "k"


@respx.mock
def test_pair_status_and_create_and_delete() -> None:
    respx.get(f"{BASE}/api/v1/pair/status").mock(
        return_value=httpx.Response(
            200,
            json={
                "paired": False,
                "client_count": 0,
                "pairing_window_open": True,
                "window_remaining_secs": 25,
            },
        )
    )
    respx.post(f"{BASE}/api/v1/pair").mock(
        return_value=httpx.Response(
            200,
            json={"paired": True, "token": "tok", "client_name": "tester"},
        )
    )
    respx.delete(f"{BASE}/api/v1/pair/tester").mock(
        return_value=httpx.Response(204)
    )
    with _client() as c:
        st = c.pair.status()
        assert st.pairing_window_open is True
        res = c.pair.create(client_name="tester")
        assert res.token == "tok"
        c.pair.delete("tester")


@respx.mock
def test_witness_chain() -> None:
    respx.get(f"{BASE}/api/v1/witness/chain").mock(
        return_value=httpx.Response(
            200,
            json={
                "entries": [
                    {
                        "index": 0,
                        "parent_hash": "",
                        "action_hash": "abc",
                        "signature": "sig",
                        "epoch": 0,
                    }
                ],
                "chain_length": 1,
            },
        )
    )
    with _client() as c:
        ch = c.witness.chain()
    assert ch.chain_length == 1
    assert ch.entries[0].action_hash == "abc"


@respx.mock
def test_custody_epoch() -> None:
    respx.get(f"{BASE}/api/v1/custody/epoch").mock(
        return_value=httpx.Response(200, json={"epoch": 7, "started_at": 123})
    )
    with _client() as c:
        ep = c.custody.epoch()
    assert ep.epoch == 7


@respx.mock
def test_store_status_query_ingest() -> None:
    respx.get(f"{BASE}/api/v1/store/status").mock(
        return_value=httpx.Response(
            200,
            json={
                "total_vectors": 10,
                "deleted_vectors": 0,
                "dimension": 384,
                "file_size_bytes": 4096,
                "epoch": 1,
            },
        )
    )
    respx.post(f"{BASE}/api/v1/store/query").mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {"id": 1, "distance": 0.1, "metadata": {"k": "v"}},
                    {"id": 2, "distance": 0.2, "metadata": {}},
                ],
                "query_ms": 3.5,
            },
        )
    )
    respx.post(f"{BASE}/api/v1/store/ingest").mock(
        return_value=httpx.Response(200, json={"ingested": 1})
    )
    with _client() as c:
        st = c.store.status()
        assert st.dimension == 384
        res = c.store.query(vector=[0.1, 0.2, 0.3], k=2)
        assert len(res.matches) == 2
        assert res.matches[0].metadata == {"k": "v"}
        ing = c.store.ingest(
            vectors=[VectorUpsert(id="a", values=(0.1, 0.2, 0.3))]
        )
        assert ing["ingested"] == 1


@respx.mock
def test_ota_config_and_check_now() -> None:
    respx.get(f"{BASE}/api/v1/ota/config").mock(
        return_value=httpx.Response(
            200,
            json={"enabled": True, "channel": "stable", "check_interval_secs": 3600},
        )
    )
    respx.post(f"{BASE}/api/v1/ota/check-now").mock(
        return_value=httpx.Response(
            200,
            json={
                "triggered": True,
                "message": "ok",
                "check_interval_secs": 3600,
                "channel": "stable",
            },
        )
    )
    with _client() as c:
        cfg = c.ota.config()
        assert cfg.enabled is True
        chk = c.ota.check_now()
        assert chk.triggered is True


@respx.mock
def test_401_maps_to_auth_error() -> None:
    respx.get(f"{BASE}/api/v1/status").mock(
        return_value=httpx.Response(401, json={"error": "nope"})
    )
    with _client() as c, pytest.raises(AuthError) as exc:
        c.status()
    assert exc.value.reason == AuthReason.INVALID_CREDENTIALS


@respx.mock
def test_403_not_paired_maps_correctly() -> None:
    respx.post(f"{BASE}/api/v1/store/ingest").mock(
        return_value=httpx.Response(403, json={"error": "not paired"})
    )
    with _client() as c, pytest.raises(AuthError) as exc:
        c.store.ingest(vectors=[VectorUpsert(id="a", values=(1.0,))])
    assert exc.value.reason == AuthReason.NOT_PAIRED


@respx.mock
def test_404_maps_to_not_found() -> None:
    respx.get(f"{BASE}/api/v1/custody/epoch").mock(
        return_value=httpx.Response(404, json={"error": "nope"})
    )
    with _client() as c, pytest.raises(NotFoundError):
        c.custody.epoch()


@respx.mock
def test_501_maps_to_not_implemented() -> None:
    respx.get(f"{BASE}/api/v1/witness/chain").mock(
        return_value=httpx.Response(501, json={"error": "nyi"})
    )
    with _client() as c, pytest.raises(SeedNotImplementedError) as exc:
        c.witness.chain()
    assert "/api/v1/witness/chain" in exc.value.endpoint


@respx.mock
def test_validation_on_empty_vector_is_local() -> None:
    # Never hits the network — local ValidationError.
    with _client() as c, pytest.raises(ValidationError):
        c.store.query(vector=[], k=1)


@respx.mock
def test_post_500_does_not_retry_non_idempotent() -> None:
    # ADR-0005 + issue #9: POST /store/ingest is mutating, so 500 should
    # surface without retry.
    route = respx.post(f"{BASE}/api/v1/store/ingest").mock(
        return_value=httpx.Response(500, json={"error": "boom"})
    )
    with _client() as c, pytest.raises(Exception):
        c.store.ingest(vectors=[VectorUpsert(id="a", values=(1.0,))])
    assert route.call_count == 1


@respx.mock
def test_post_query_retries_because_idempotent() -> None:
    # POST /store/query is semantically idempotent; SDK sets idempotent=True
    # internally (ADR-0005 §Caller-attested idempotency).
    route = respx.post(f"{BASE}/api/v1/store/query").mock(
        side_effect=[
            httpx.Response(500, json={"error": "boom"}),
            httpx.Response(
                200, json={"results": [], "query_ms": 1.0}
            ),
        ]
    )
    with _client() as c:
        res = c.store.query(vector=[0.1], k=1)
    assert route.call_count == 2
    assert len(res.matches) == 0


@respx.mock
def test_get_500_retries_then_succeeds() -> None:
    route = respx.get(f"{BASE}/api/v1/status").mock(
        side_effect=[
            httpx.Response(502, json={"error": "bad gw"}),
            httpx.Response(503, json={"error": "down"}),
            httpx.Response(
                200,
                json={
                    "device_id": "d",
                    "uptime_secs": 0,
                    "epoch": 0,
                    "total_vectors": 0,
                    "deleted_vectors": 0,
                    "file_size_bytes": 0,
                    "dimension": 384,
                    "paired": True,
                },
            ),
        ]
    )
    with _client() as c:
        s = c.status()
    assert route.call_count == 3
    assert s.device_id == "d"


@respx.mock
def test_429_respects_retry_after_header() -> None:
    route = respx.get(f"{BASE}/api/v1/status").mock(
        side_effect=[
            httpx.Response(
                429,
                json={"error": "rate limited"},
                headers={"Retry-After": "0"},
            ),
            httpx.Response(
                200,
                json={
                    "device_id": "d",
                    "uptime_secs": 0,
                    "epoch": 0,
                    "total_vectors": 0,
                    "deleted_vectors": 0,
                    "file_size_bytes": 0,
                    "dimension": 384,
                    "paired": True,
                },
            ),
        ]
    )
    with _client() as c:
        s = c.status()
    assert route.call_count == 2
    assert s.paired is True
