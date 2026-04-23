"""Unit tests for :class:`MdnsDiscovery` (ADR-0016a §D6).

These tests must pass whether or not the real ``zeroconf`` package is
installed in the venv. A stub module is injected into ``sys.modules``
before importing :mod:`cognitum.seed.discovery.mdns` so the test logic
never makes real multicast calls.
"""

from __future__ import annotations

import importlib
import sys
import types
from typing import Any
from unittest.mock import patch

import pytest


# ---- zeroconf stub -------------------------------------------------------


class _FakeServiceStateChange:
    Added = "added"
    Removed = "removed"
    Updated = "updated"


class _FakeServiceInfo:
    """Minimal stand-in for ``zeroconf.ServiceInfo``."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        device_id: str | None = None,
        cert_fp: str | None = None,
    ) -> None:
        self._host = host
        self.port = port
        self.server = f"{device_id or 'seed'}.local."
        props: dict[bytes, bytes] = {}
        if device_id is not None:
            props[b"id"] = device_id.encode()
        if cert_fp is not None:
            props[b"fp"] = cert_fp.encode()
        self.properties = props

    def parsed_addresses(self) -> list[str]:
        return [self._host]


class _FakeZeroconf:
    def __init__(self) -> None:
        self._services: list[_FakeServiceInfo] = []
        self._by_name: dict[str, _FakeServiceInfo] = {}
        self.closed = False

    def seed(self, info: _FakeServiceInfo) -> None:
        self._services.append(info)

    def get_service_info(
        self, service_type: str, name: str, timeout: int = 500
    ) -> _FakeServiceInfo | None:
        # Look up by the name the browser advertised.
        return self._by_name.get(name)

    def close(self) -> None:
        self.closed = True


class _FakeServiceBrowser:
    def __init__(
        self,
        zc: _FakeZeroconf,
        service_type: str,
        handlers: list[Any],
    ) -> None:
        self._cancelled = False
        # Immediately deliver one Added callback per seeded service so
        # the collector drains before its wait timeout. Register each
        # service by its synthetic name so get_service_info() returns
        # the correct one.
        for idx, info in enumerate(zc._services):
            name = f"seed{idx}.{service_type}"
            zc._by_name[name] = info
            for h in handlers:
                h(zc, service_type, name, _FakeServiceStateChange.Added)

    def cancel(self) -> None:
        self._cancelled = True


def _install_fake_zeroconf() -> types.ModuleType:
    module = types.ModuleType("zeroconf")
    module.Zeroconf = _FakeZeroconf  # type: ignore[attr-defined]
    module.ServiceBrowser = _FakeServiceBrowser  # type: ignore[attr-defined]
    module.ServiceStateChange = _FakeServiceStateChange  # type: ignore[attr-defined]
    sys.modules["zeroconf"] = module
    # Force a fresh import of the mdns module so it binds against the
    # stub regardless of whether a prior test loaded the real package.
    sys.modules.pop("cognitum.seed.discovery.mdns", None)
    return module


@pytest.fixture
def mdns_module() -> types.ModuleType:
    _install_fake_zeroconf()
    mod = importlib.import_module("cognitum.seed.discovery.mdns")
    return mod


# ---- tests ---------------------------------------------------------------


def test_mdns_discovery_collects_one_seed(mdns_module: types.ModuleType) -> None:
    zc = mdns_module.Zeroconf()  # our fake
    zc.seed(_FakeServiceInfo(host="169.254.42.1", port=8443, device_id="dev-1"))

    provider = mdns_module.MdnsDiscovery(
        timeout_s=0.1, zeroconf=zc,
    )
    peers = provider.discover()

    assert len(peers) == 1
    assert peers[0].url == "https://169.254.42.1:8443"
    assert peers[0].device_id == "dev-1"

    provider.close()
    # Injected Zeroconf instances are NOT owned by the provider; we
    # should NOT close them on the caller's behalf (common case:
    # sharing one Zeroconf with other services in the app).
    assert zc.closed is False


def test_mdns_discovery_returns_empty_when_no_services(
    mdns_module: types.ModuleType,
) -> None:
    zc = mdns_module.Zeroconf()
    provider = mdns_module.MdnsDiscovery(timeout_s=0.05, zeroconf=zc)
    peers = provider.discover()
    assert peers == []
    provider.close()


def test_mdns_discovery_empty_triggers_config_error_in_client(
    mdns_module: types.ModuleType,
) -> None:
    """ADR-0016b §"Open": provider must resolve to a non-empty list at
    construction; zero peers is a config error (fail-fast)."""

    from cognitum._errors import ConfigError
    from cognitum.seed import SeedClient, SeedTLS

    zc = mdns_module.Zeroconf()
    provider = mdns_module.MdnsDiscovery(timeout_s=0.05, zeroconf=zc)
    with pytest.raises(ConfigError):
        SeedClient(endpoints=provider, tls=SeedTLS(insecure=True))


def test_mdns_discovery_wires_into_seed_client(
    mdns_module: types.ModuleType,
) -> None:
    """End-to-end: ``SeedClient(endpoints=MdnsDiscovery(...))`` opens
    and ``peers()`` reflects the discovered list."""

    from cognitum.seed import SeedClient, SeedTLS

    zc = mdns_module.Zeroconf()
    zc.seed(_FakeServiceInfo(host="169.254.42.1", port=8443, device_id="a"))
    zc.seed(_FakeServiceInfo(host="10.0.0.2", port=8443, device_id="b"))

    provider = mdns_module.MdnsDiscovery(timeout_s=0.1, zeroconf=zc)
    with SeedClient(
        endpoints=provider,
        tls=SeedTLS(insecure=True),
        max_retries=1,
        max_elapsed_ms=500,
    ) as client:
        urls = sorted(p.endpoint.url for p in client.peers())
        assert urls == ["https://10.0.0.2:8443", "https://169.254.42.1:8443"]
        # `rediscover()` re-queries the provider.
        zc.seed(_FakeServiceInfo(host="10.0.0.3", port=8443, device_id="c"))
        client.rediscover()
        urls2 = sorted(p.endpoint.url for p in client.peers())
        assert "https://10.0.0.3:8443" in urls2


def test_mdns_import_error_without_extra() -> None:
    """When ``zeroconf`` is NOT importable, the mdns submodule import
    raises a helpful :class:`ImportError` pointing at the extra."""

    # Remove any cached copies and block the real zeroconf import.
    sys.modules.pop("zeroconf", None)
    sys.modules.pop("cognitum.seed.discovery.mdns", None)

    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def _blocked(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "zeroconf" or name.startswith("zeroconf."):
            raise ImportError("blocked for test")
        return real_import(name, *args, **kwargs)

    with patch("builtins.__import__", side_effect=_blocked):
        with pytest.raises(ImportError, match=r"mdns"):
            importlib.import_module("cognitum.seed.discovery.mdns")

    # Cleanup — reinstate the stub so downstream tests still work.
    sys.modules.pop("cognitum.seed.discovery.mdns", None)
    _install_fake_zeroconf()
