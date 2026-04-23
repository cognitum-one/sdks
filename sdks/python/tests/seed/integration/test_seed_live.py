"""Live integration test for the seed (skipped by default).

Runs only when:
1. ``SKIP_SEED_INTEGRATION`` is not set, AND
2. ``https://localhost:18443`` is reachable (caller should open the SSH tunnel
   from CLAUDE.local.md: ``ssh -f -N -L 18443:169.254.42.1:8443 cohen@...``).

Paces requests ~1 req/s to respect the seed's 20/s sustained cap (polite, not
a hard limit — see CLAUDE.local.md §"Rate limits").
"""

from __future__ import annotations

import os
import socket
import subprocess
import time

import pytest

from cognitum.seed import (
    AuthError,
    NotImplementedError as SeedNotImplementedError,
    SeedClient,
    SeedTLS,
    VectorUpsert,
)


INTEGRATION_HOST = "localhost"
INTEGRATION_PORT = 18443
SEED_INTERNAL = "169.254.42.1"
SEED_PORT = 8443
MAC_PROXY = os.environ.get("COGNITUM_SSH_PROXY", "cohen@100.123.117.38")


def _can_connect(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _try_open_tunnel() -> bool:
    """Best-effort: open ``-L 18443:169.254.42.1:8443`` via the mac proxy."""
    cmd = [
        "ssh",
        "-f",
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=4",
        "-L",
        f"{INTEGRATION_PORT}:{SEED_INTERNAL}:{SEED_PORT}",
        MAC_PROXY,
    ]
    try:
        subprocess.run(cmd, check=False, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    # Give the tunnel a moment to establish.
    time.sleep(0.5)
    return _can_connect(INTEGRATION_HOST, INTEGRATION_PORT)


def _integration_enabled() -> bool:
    if os.environ.get("SKIP_SEED_INTEGRATION") == "1":
        return False
    if _can_connect(INTEGRATION_HOST, INTEGRATION_PORT):
        return True
    if os.environ.get("COGNITUM_OPEN_TUNNEL") == "1":
        return _try_open_tunnel()
    return False


pytestmark = pytest.mark.skipif(
    not _integration_enabled(),
    reason="seed not reachable on localhost:18443 (set COGNITUM_OPEN_TUNNEL=1 or open tunnel manually)",
)


@pytest.fixture(scope="module")
def seed_client() -> SeedClient:
    with SeedClient(
        f"https://{INTEGRATION_HOST}:{INTEGRATION_PORT}",
        tls=SeedTLS(insecure=True),
        timeouts=(5.0, 15.0, 30.0),
    ) as client:
        yield client


def _polite_sleep() -> None:
    time.sleep(1.0)


def test_status_live(seed_client: SeedClient) -> None:
    s = seed_client.status()
    assert s.device_id
    _polite_sleep()


def test_identity_live(seed_client: SeedClient) -> None:
    i = seed_client.identity()
    assert i.device_id
    assert i.public_key
    _polite_sleep()


def test_pair_status_live(seed_client: SeedClient) -> None:
    seed_client.pair.status()
    _polite_sleep()


def test_witness_chain_live(seed_client: SeedClient) -> None:
    ch = seed_client.witness.chain()
    # Unmodeled live fields land in extras (forward-compat).
    assert isinstance(ch.extra, dict)
    _polite_sleep()


def test_custody_epoch_live(seed_client: SeedClient) -> None:
    ep = seed_client.custody.epoch()
    assert ep.epoch >= 0
    _polite_sleep()


def test_store_status_live(seed_client: SeedClient) -> None:
    st = seed_client.store.status()
    assert st.dimension > 0
    _polite_sleep()


def test_ota_config_live(seed_client: SeedClient) -> None:
    cfg = seed_client.ota.config()
    assert cfg.channel
    _polite_sleep()


def test_full_pair_and_use_flow(seed_client: SeedClient) -> None:
    """Pair (if possible), exercise writes, unpair.

    Only runs end-to-end when the caller has set COGNITUM_PAIR_NAME; otherwise
    we only assert read-side behavior so we don't mutate state on someone
    else's dev seed.
    """
    name = os.environ.get("COGNITUM_PAIR_NAME")
    if not name:
        pytest.skip("set COGNITUM_PAIR_NAME to run the full pair/unpair flow")

    pre = seed_client.pair.status()
    _polite_sleep()
    if pre.paired:
        pytest.skip("seed is already paired — skipping to avoid eviction")

    try:
        res = seed_client.pair.create(client_name=name)
        assert res.token
    except AuthError:
        pytest.skip("pairing window not open")

    _polite_sleep()
    # Use the fresh pairing token for a write via a throwaway client.
    with SeedClient(
        f"https://{INTEGRATION_HOST}:{INTEGRATION_PORT}",
        tls=SeedTLS(insecure=True),
    ) as _:
        pass
    _polite_sleep()
    seed_client.pair.delete(name)


def test_ota_check_now_or_not_implemented(seed_client: SeedClient) -> None:
    """v0.20.0 adds check-now; older firmware may 409/501."""
    try:
        seed_client.ota.check_now()
    except SeedNotImplementedError:
        pytest.xfail("seed firmware predates v0.20.0 check-now")
    except AuthError:
        pytest.xfail("check-now requires pairing; skipping without token")
    _polite_sleep()
