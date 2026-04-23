"""Unit tests for the mDNS ``fp=sha256:<hex>`` TXT parse path.

Covers :func:`cognitum.seed.discovery.mdns._parse_fp_txt` and the
propagation of the parsed fingerprint to
:attr:`DiscoveredPeer.tls_fingerprint` through :class:`MdnsDiscovery`.

Uses the same stubbed-``zeroconf`` pattern as ``test_discovery_mdns`` so
the tests run whether or not the real PyPI package is installed.
"""

from __future__ import annotations

import importlib
import sys
import types

import pytest


# ---- zeroconf stub (mirrors test_discovery_mdns, kept local to avoid
# cross-test ``sys.modules`` coupling) -------------------------------


class _FakeServiceStateChange:
    Added = "added"
    Removed = "removed"
    Updated = "updated"


class _FakeServiceInfo:
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
        return self._by_name.get(name)

    def close(self) -> None:
        self.closed = True


class _FakeServiceBrowser:
    def __init__(
        self,
        zc: _FakeZeroconf,
        service_type: str,
        handlers: list,
    ) -> None:
        for idx, info in enumerate(zc._services):
            name = f"seed{idx}.{service_type}"
            zc._by_name[name] = info
            for h in handlers:
                h(zc, service_type, name, _FakeServiceStateChange.Added)

    def cancel(self) -> None:
        pass


def _install_fake_zeroconf() -> types.ModuleType:
    module = types.ModuleType("zeroconf")
    module.Zeroconf = _FakeZeroconf  # type: ignore[attr-defined]
    module.ServiceBrowser = _FakeServiceBrowser  # type: ignore[attr-defined]
    module.ServiceStateChange = _FakeServiceStateChange  # type: ignore[attr-defined]
    sys.modules["zeroconf"] = module
    sys.modules.pop("cognitum.seed.discovery.mdns", None)
    return module


@pytest.fixture
def mdns_module() -> types.ModuleType:
    _install_fake_zeroconf()
    return importlib.import_module("cognitum.seed.discovery.mdns")


# ---- tests ---------------------------------------------------------------


_FP_HEX = "aa" * 32  # 64 hex chars, valid length for SHA-256


def test_mdns_parses_fp_sha256_into_tls_fingerprint(
    mdns_module: types.ModuleType,
) -> None:
    """``fp=sha256:<hex>`` TXT value lands on ``tls_fingerprint`` in
    lowercased-hex form (no colons, no prefix)."""
    zc = mdns_module.Zeroconf()
    zc.seed(
        _FakeServiceInfo(
            host="169.254.42.1",
            port=8443,
            device_id="dev-fp",
            cert_fp=f"sha256:{_FP_HEX.upper()}",
        )
    )
    provider = mdns_module.MdnsDiscovery(timeout_s=0.1, zeroconf=zc)
    peers = provider.discover()
    assert len(peers) == 1
    assert peers[0].tls_fingerprint == _FP_HEX
    provider.close()


def test_mdns_ignores_malformed_fp(
    mdns_module: types.ModuleType,
) -> None:
    """A malformed ``fp=`` value (wrong length, non-hex, wrong algo)
    must NOT populate the pin — downstream code refuses insecure
    fallback once a pin is present, so garbage in is a security bug."""
    zc = mdns_module.Zeroconf()
    zc.seed(
        _FakeServiceInfo(
            host="169.254.42.1",
            port=8443,
            device_id="dev-bad-fp",
            cert_fp="sha512:deadbeef",  # wrong algo + short
        )
    )
    provider = mdns_module.MdnsDiscovery(timeout_s=0.1, zeroconf=zc)
    peers = provider.discover()
    assert len(peers) == 1
    assert peers[0].tls_fingerprint is None
    provider.close()


def test_mdns_missing_fp_yields_none(
    mdns_module: types.ModuleType,
) -> None:
    """No ``fp=`` TXT entry → ``tls_fingerprint`` stays ``None`` so the
    transport falls through to its existing verify logic (CA/insecure)."""
    zc = mdns_module.Zeroconf()
    zc.seed(
        _FakeServiceInfo(
            host="169.254.42.1",
            port=8443,
            device_id="dev-no-fp",
        )
    )
    provider = mdns_module.MdnsDiscovery(timeout_s=0.1, zeroconf=zc)
    peers = provider.discover()
    assert len(peers) == 1
    assert peers[0].tls_fingerprint is None
    provider.close()
