"""mDNS-based :class:`DiscoveryProvider` (ADR-0016a §D6, opt-in Phase 1.5).

Queries ``_cognitum._tcp.local.`` via the ``zeroconf`` PyPI package.
Seeds advertise themselves per
``seed/src/cognitum-agent/src/discovery.rs`` with TXT entries:

- ``id=<device_id>`` — surfaced as :attr:`DiscoveredPeer.device_id`
- ``fp=sha256:<hex>`` — DER SHA-256 of the seed's self-signed cert,
  surfaced as :attr:`DiscoveredPeer.tls_fingerprint` (lowercased hex,
  no colons). Consumed by the transport to pin per-peer TLS
  handshakes (ADR-0007 §TLS, anti-spoof FINDING-28).

The port comes from the SRV record; the scheme is assumed ``https`` (the
seed's HTTPS API is the only supported transport — ADR-0002).

Multicast is blocked on many corporate / Docker networks; that is why
mDNS is opt-in and never the default (ADR-0016a §D6 "Rejected: mDNS
required in Phase 1"). The import of ``zeroconf`` happens lazily at
class import so the extra is only needed if a caller explicitly
instantiates :class:`MdnsDiscovery`.
"""

from __future__ import annotations

import socket
import threading
from typing import Any

from cognitum.seed.discovery._types import DiscoveredPeer

try:  # pragma: no cover — exercised by test_discovery_mdns stubs
    from zeroconf import ServiceBrowser, ServiceStateChange, Zeroconf
except ImportError as exc:  # pragma: no cover — import-guard branch
    raise ImportError(
        "cognitum.seed.discovery.MdnsDiscovery requires the 'mdns' extra. "
        "Install with: pip install cognitum-sdk[mdns]"
    ) from exc


_DEFAULT_SERVICE = "_cognitum._tcp.local."
_DEFAULT_TIMEOUT_S = 2.0


def _parse_fp_txt(raw: str | None) -> str | None:
    """Parse a TXT ``fp=sha256:<hex>`` value into lowercased hex.

    Accepts the canonical seed form (``sha256:`` prefix, 64 hex chars,
    colons optional) and returns ``None`` for anything else — malformed
    values MUST NOT be treated as pins, since the downstream verifier
    rejects insecure fallbacks once a pin is present.
    """

    if not raw:
        return None
    s = raw.strip()
    low = s.lower()
    if low.startswith("sha256:"):
        low = low[len("sha256:") :]
    # Strip any colons (``aa:bb:cc:...``) and whitespace.
    low = low.replace(":", "").replace(" ", "")
    if len(low) != 64:
        return None
    try:
        int(low, 16)
    except ValueError:
        return None
    return low


def _decode_txt(raw: dict[bytes | str, bytes | str | None]) -> dict[str, str]:
    """Normalise zeroconf's bytes-or-str TXT map to ``dict[str, str]``."""

    out: dict[str, str] = {}
    for k, v in raw.items():
        key = k.decode("utf-8", "replace") if isinstance(k, (bytes, bytearray)) else str(k)
        if v is None:
            continue
        val = v.decode("utf-8", "replace") if isinstance(v, (bytes, bytearray)) else str(v)
        out[key] = val
    return out


def _addr_to_host(info: Any) -> str | None:
    """Prefer the first parseable IPv4 address; fall back to the hostname.

    zeroconf exposes both ``addresses`` (raw bytes) and
    ``parsed_addresses()``; we use the latter for v4/v6 string form and
    accept whichever comes first. Hostname fallback is useful in
    containerised environments where the IP is not directly reachable.
    """

    # parsed_addresses() may not exist on very old zeroconf releases.
    parsed = getattr(info, "parsed_addresses", None)
    if callable(parsed):
        addrs = list(parsed() or [])
        if addrs:
            return str(addrs[0])
    raw_addrs = getattr(info, "addresses", None) or []
    for raw in raw_addrs:
        try:
            return socket.inet_ntoa(raw)
        except (OSError, ValueError):
            continue
    server = getattr(info, "server", None)
    if server:
        return str(server).rstrip(".")
    return None


class MdnsDiscovery:
    """Discover seeds via mDNS (ADR-0016a §D6, Phase 1.5 opt-in).

    Usage::

        from cognitum.seed import SeedClient
        from cognitum.seed.discovery import MdnsDiscovery

        client = SeedClient(endpoints=MdnsDiscovery())

    The provider performs a one-shot browse on :meth:`discover` /
    :meth:`adiscover`, waiting up to ``timeout_s`` for service
    announcements. If the caller holds a reference across multiple
    ``rediscover()`` passes the underlying :class:`Zeroconf` instance is
    re-used; :meth:`close` tears it down.

    Parameters
    ----------
    service_type:
        mDNS service name, trailing dot expected. Defaults to
        ``_cognitum._tcp.local.`` per the seed.
    timeout_s:
        How long to wait for service announcements per discovery pass.
        Defaults to 2 s (trades against first-request latency).
    zeroconf:
        Inject a pre-built ``Zeroconf`` instance (used by tests and by
        callers who already run one for other services).
    scheme:
        URL scheme to synthesise from TXT/SRV. Defaults to ``https``.
    """

    __slots__ = (
        "_service_type",
        "_timeout_s",
        "_scheme",
        "_zeroconf",
        "_owns_zeroconf",
        "_lock",
        "_closed",
    )

    def __init__(
        self,
        *,
        service_type: str = _DEFAULT_SERVICE,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        zeroconf: Zeroconf | None = None,
        scheme: str = "https",
    ) -> None:
        if not service_type.endswith("."):
            service_type = service_type + "."
        self._service_type = service_type
        self._timeout_s = float(timeout_s)
        self._scheme = scheme
        self._zeroconf: Zeroconf | None = zeroconf
        self._owns_zeroconf = zeroconf is None
        self._lock = threading.Lock()
        self._closed = False

    def _ensure_zc(self) -> Zeroconf:
        with self._lock:
            if self._closed:
                raise RuntimeError("MdnsDiscovery is closed")
            if self._zeroconf is None:
                self._zeroconf = Zeroconf()
                self._owns_zeroconf = True
            return self._zeroconf

    def _collect(self, zc: Zeroconf) -> list[DiscoveredPeer]:
        """Browse once and collect whatever announcements arrive.

        We rely on a ``threading.Event``-style signal inside a small
        handler; zeroconf delivers callbacks on its own thread. Any
        partial state at the timeout is returned as-is — callers fall
        back to an explicit list or retry.
        """

        found: dict[str, DiscoveredPeer] = {}
        done = threading.Event()

        def _handler(
            zeroconf: Zeroconf,
            service_type: str,
            name: str,
            state_change: ServiceStateChange,
        ) -> None:
            if state_change is not ServiceStateChange.Added:
                return
            info = zeroconf.get_service_info(service_type, name, timeout=500)
            if info is None:
                return
            host = _addr_to_host(info)
            if host is None:
                return
            port = getattr(info, "port", None)
            if not port:
                return
            txt = _decode_txt(getattr(info, "properties", {}) or {})
            device_id = txt.get("id")
            tls_fp = _parse_fp_txt(txt.get("fp"))
            url = f"{self._scheme}://{host}:{int(port)}"
            found[url] = DiscoveredPeer(
                url=url,
                device_id=device_id,
                tls_fingerprint=tls_fp,
            )

        browser = ServiceBrowser(
            zc, self._service_type, handlers=[_handler]
        )
        try:
            done.wait(self._timeout_s)
        finally:
            browser.cancel()
        # Preserve insertion order (dict is ordered since py3.7).
        return list(found.values())

    def discover(self) -> list[DiscoveredPeer]:
        zc = self._ensure_zc()
        return self._collect(zc)

    async def adiscover(self) -> list[DiscoveredPeer]:
        # zeroconf's native API is thread-based; running the blocking
        # browse in a worker thread keeps asyncio event loops unblocked.
        import asyncio

        return await asyncio.get_running_loop().run_in_executor(
            None, self.discover
        )

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            zc = self._zeroconf
            self._zeroconf = None
        if zc is not None and self._owns_zeroconf:
            try:
                zc.close()
            except Exception:  # pragma: no cover — defensive
                pass


__all__ = ["MdnsDiscovery"]
