"""Unit tests for :class:`TailscaleDiscovery` (ADR-0016a §D6, closes OQ-11).

No real ``tailscale`` invocation happens — tests inject a ``runner``
stub that mirrors :func:`subprocess.run`'s return shape. Fixture JSON
models a tailnet with two cognitum seeds plus unrelated noise.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Any

import pytest

from cognitum.seed.discovery.tailscale import TailscaleDiscovery
from cognitum._errors import ConfigError


FIXTURE_STATUS: dict[str, Any] = {
    "Self": {
        "HostName": "ruvultra",
        "DNSName": "ruvultra.tail1234.ts.net.",
        "Online": True,
    },
    "Peer": {
        "nodekey_a": {
            "HostName": "cognitum-61bc",
            "DNSName": "cognitum-61bc.tail1234.ts.net.",
            "Online": True,
        },
        "nodekey_b": {
            "HostName": "cognitum-aaaa",
            "DNSName": "cognitum-aaaa.tail1234.ts.net.",
            "Online": True,
        },
        "nodekey_c": {
            "HostName": "laptop-joe",
            "DNSName": "laptop-joe.tail1234.ts.net.",
            "Online": True,
        },
        "nodekey_d": {
            "HostName": "router-home",
            "DNSName": "router-home.tail1234.ts.net.",
            "Online": False,
        },
    },
}


@dataclass
class _Result:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


def _make_runner(*, stdout: str = "", stderr: str = "", returncode: int = 0,
                 exc: BaseException | None = None) -> Any:
    calls: list[tuple[Any, ...]] = []

    def runner(argv, *args, **kwargs):
        calls.append((tuple(argv), args, kwargs))
        if exc is not None:
            raise exc
        return _Result(returncode=returncode, stdout=stdout, stderr=stderr)

    runner.calls = calls  # type: ignore[attr-defined]
    return runner


def test_filters_by_prefix_and_maps_to_https_urls() -> None:
    runner = _make_runner(stdout=json.dumps(FIXTURE_STATUS))
    provider = TailscaleDiscovery(runner=runner)
    peers = provider.discover()

    urls = sorted(p.url for p in peers)
    assert urls == [
        "https://cognitum-61bc.tail1234.ts.net:8443",
        "https://cognitum-aaaa.tail1234.ts.net:8443",
    ]
    for p in peers:
        assert p.device_id is None
        assert p.tls_fingerprint is None

    # Exactly one invocation with `tailscale status --json`.
    assert len(runner.calls) == 1  # type: ignore[attr-defined]
    argv, _, _ = runner.calls[0]  # type: ignore[attr-defined]
    assert argv == ("tailscale", "status", "--json")


def test_custom_predicate_and_port_override() -> None:
    runner = _make_runner(stdout=json.dumps(FIXTURE_STATUS))
    provider = TailscaleDiscovery(
        runner=runner,
        port=18443,
        predicate=lambda p: p.get("HostName") == "cognitum-61bc",
    )
    peers = provider.discover()
    assert len(peers) == 1
    assert peers[0].url == "https://cognitum-61bc.tail1234.ts.net:18443"


def test_missing_binary_raises_config_error() -> None:
    runner = _make_runner(exc=FileNotFoundError("[Errno 2] No such file: 'tailscale'"))
    provider = TailscaleDiscovery(runner=runner)
    with pytest.raises(ConfigError, match="not found on PATH"):
        provider.discover()


def test_malformed_json_raises_config_error() -> None:
    runner = _make_runner(stdout="this is not json")
    provider = TailscaleDiscovery(runner=runner)
    with pytest.raises(ConfigError, match="failed to parse"):
        provider.discover()


def test_non_zero_exit_raises_config_error() -> None:
    runner = _make_runner(returncode=1, stderr="tailscale: not logged in")
    provider = TailscaleDiscovery(runner=runner)
    with pytest.raises(ConfigError, match="exited 1"):
        provider.discover()


def test_timeout_raises_config_error() -> None:
    runner = _make_runner(
        exc=subprocess.TimeoutExpired(cmd=["tailscale", "status", "--json"], timeout=10)
    )
    provider = TailscaleDiscovery(runner=runner)
    with pytest.raises(ConfigError, match="timed out"):
        provider.discover()
