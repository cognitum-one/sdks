"""Unit tests for the seed typed models."""

from __future__ import annotations

import json
from pathlib import Path

from cognitum.seed import (
    Epoch,
    Identity,
    OtaCheckNowResponse,
    OtaConfig,
    PairCreateResponse,
    PairStatus,
    QueryMatch,
    Status,
    StoreIngestRequest,
    StoreQueryResult,
    StoreStatus,
    VectorUpsert,
    WitnessChain,
)


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "seed"


def test_status_from_fixture_keeps_extra() -> None:
    data = json.loads((FIXTURES / "status_ok.json").read_text())
    st = Status.from_wire(data)
    assert st.device_id.startswith("ad7d")
    assert st.dimension == 384
    assert st.paired is True
    # Unknown fields preserved.
    assert st.extra["witness_chain_length"] == 123
    assert st.extra["optimizer_state"] == "idle"


def test_identity_from_wire() -> None:
    i = Identity.from_wire({"device_id": "d", "public_key": "k", "aux": 1})
    assert i.device_id == "d"
    assert i.extra["aux"] == 1


def test_pair_status_routes_unknown_to_extra() -> None:
    ps = PairStatus.from_wire(
        {
            "paired": True,
            "client_count": 1,
            "pairing_window_open": False,
            "window_remaining_secs": 0,
            "clients": [{"client_name": "a", "paired_at": 123}],
        }
    )
    assert ps.paired is True
    # `clients` is not modeled (live seed never populates it) — forward-compat extras catch-all.
    assert ps.extra["clients"][0]["client_name"] == "a"


def test_pair_create_response_from_wire() -> None:
    r = PairCreateResponse.from_wire(
        {"paired": True, "token": "t", "client_name": "c"}
    )
    # token is wrapped in SecretString (issue #15); unwrap to compare.
    assert r.token.as_str() == "t"
    assert r.paired is True
    assert r.client_name == "c"


def test_store_query_result_accepts_results_or_matches_key() -> None:
    a = StoreQueryResult.from_wire(
        {"results": [{"id": 1, "distance": 0.1}], "query_ms": 1.0}
    )
    b = StoreQueryResult.from_wire(
        {"matches": [{"id": 2, "distance": 0.2}], "query_ms": 2.0}
    )
    assert a.results[0].id == 1
    assert b.results[0].id == 2


def test_store_status_extra() -> None:
    st = StoreStatus.from_wire(
        {
            "total_vectors": 1,
            "deleted_vectors": 0,
            "dimension": 384,
            "file_size_bytes": 1,
            "epoch": 0,
            "shards": 1,
        }
    )
    assert st.extra["shards"] == 1


def test_witness_chain_routes_all_fields_to_extra() -> None:
    # Live seed returns {"depth": N, "epoch": N, "head_hash": "..."} — none
    # modeled as typed fields; all land in extras (forward-compat).
    ch = WitnessChain.from_wire(
        {"depth": 3, "epoch": 7, "head_hash": "abc"}
    )
    assert ch.extra["depth"] == 3
    assert ch.extra["head_hash"] == "abc"


def test_epoch_model() -> None:
    e = Epoch.from_wire({"epoch": 5, "started_at": 99})
    assert e.epoch == 5
    # `started_at` unmodeled — lives in extras.
    assert e.extra["started_at"] == 99


def test_ota_models() -> None:
    c = OtaConfig.from_wire({"enabled": True, "channel": "beta", "check_interval_secs": 10})
    assert c.channel == "beta"
    r = OtaCheckNowResponse.from_wire(
        {"triggered": True, "message": "ok", "check_interval_secs": 10, "channel": "beta"}
    )
    assert r.triggered is True


def test_store_ingest_request_accepts_dicts_and_vectors() -> None:
    req = StoreIngestRequest.from_any(
        [
            {"id": "a", "values": [1.0, 2.0]},
            VectorUpsert(id="b", values=(3.0,), metadata={"x": 1}),
        ]
    )
    wire = req.to_wire()
    assert wire["vectors"][0]["id"] == "a"
    assert wire["vectors"][1]["metadata"] == {"x": 1}


def test_query_match_routes_unknown_fields_to_extra() -> None:
    m = QueryMatch.from_wire({"id": 1, "distance": 0.1, "text": "hello"})
    assert m.extra["text"] == "hello"


def test_frozen_dataclasses() -> None:
    s = Status.from_wire({"device_id": "d"})
    import dataclasses

    with pytest.raises((dataclasses.FrozenInstanceError, AttributeError)):
        s.device_id = "other"  # type: ignore[misc]


import pytest  # noqa: E402 — after-use to keep top clean
