"""Tailscale-native :class:`DiscoveryProvider` (ADR-0016a §D6, closes OQ-11).

Shells out to ``tailscale status --json``, walks the ``Peer`` map, keeps
the subset whose hostname matches a configurable prefix (default
``"cognitum-"``) or a caller-supplied predicate, and emits one
:class:`DiscoveredPeer` per kept peer with URL
``https://<DNSName>:<port>`` (trailing dot stripped).

The seed does not currently advertise a ``device_id`` or cert
fingerprint via the tailnet, so both stay ``None``. Callers that want
per-peer TLS pinning should combine this provider with :class:`MdnsDiscovery`
or supply ``tls.ca`` on the client.

No new dependency: uses :mod:`subprocess` and :mod:`asyncio` from the
stdlib. The Tailscale CLI binary is assumed to be on PATH; on Windows
Python's :mod:`subprocess` resolves ``tailscale`` to ``tailscale.exe``
via ``PATHEXT``.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from typing import Any, Callable, Sequence

from cognitum._errors import ConfigError
from cognitum.seed.discovery._types import DiscoveredPeer

_DEFAULT_PREFIX = "cognitum-"
_DEFAULT_PORT = 8443
_DEFAULT_COMMAND = "tailscale"


def _peer_host(peer: dict[str, Any]) -> str | None:
    """Return the best URL-ready host for a tailnet peer.

    Prefers the fully-qualified ``DNSName`` (trailing dot stripped) so
    the tailnet short hostname keeps working even across MagicDNS
    renames; falls back to the short ``HostName`` if ``DNSName`` is
    absent (single-tailnet setups sometimes elide it).
    """

    dns = peer.get("DNSName")
    if isinstance(dns, str):
        stripped = dns.strip().rstrip(".")
        if stripped:
            return stripped
    host = peer.get("HostName")
    if isinstance(host, str):
        trimmed = host.strip()
        if trimmed:
            return trimmed
    return None


class TailscaleDiscovery:
    """Discover seeds via the local Tailscale tailnet (OQ-11 / ADR-0016c).

    Usage::

        from cognitum.seed import SeedClient
        from cognitum.seed.discovery import TailscaleDiscovery

        client = SeedClient(
            endpoints=TailscaleDiscovery(prefix="cognitum-"),
            # The tailnet carries no TLS pin yet; combine with mDNS or
            # supply tls.ca / tls.insecure for self-signed seeds.
        )

    Parameters
    ----------
    prefix:
        Host-name prefix used to filter peers when ``predicate`` is not
        supplied. Defaults to ``"cognitum-"`` (case-insensitive match).
    port:
        TCP port inserted into each peer URL. Defaults to 8443.
    scheme:
        URL scheme. ``https`` by default.
    command:
        Path or name of the ``tailscale`` binary. Defaults to
        ``"tailscale"`` (resolved on PATH).
    predicate:
        Custom filter invoked for every peer. When provided it fully
        replaces the prefix check — the prefix is only consulted when
        this is ``None``.
    runner:
        Synchronous execution hook for unit tests. Must have the same
        shape as :func:`subprocess.run` (accept ``check``, ``capture_output``,
        ``text``, ``timeout`` kwargs; raise ``FileNotFoundError`` when
        the binary is missing).
    arunner:
        Optional async execution hook used by :meth:`adiscover`. When
        ``None`` (the default) :meth:`adiscover` runs :meth:`discover`
        in the default executor.
    """

    __slots__ = (
        "_prefix",
        "_port",
        "_scheme",
        "_command",
        "_predicate",
        "_runner",
        "_arunner",
    )

    def __init__(
        self,
        *,
        prefix: str = _DEFAULT_PREFIX,
        port: int = _DEFAULT_PORT,
        scheme: str = "https",
        command: str | Sequence[str] = _DEFAULT_COMMAND,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
        runner: Callable[..., Any] | None = None,
        arunner: Callable[..., Any] | None = None,
    ) -> None:
        if not (1 <= int(port) <= 65535):
            raise ConfigError(
                f"TailscaleDiscovery.port must be a TCP port in 1..65535 (got {port!r})",
                field="port",
            )
        self._prefix = prefix.lower()
        self._port = int(port)
        self._scheme = scheme
        self._command: list[str] = (
            [command] if isinstance(command, str) else list(command)
        )
        self._predicate = predicate
        self._runner = runner
        self._arunner = arunner

    # -- sync ---------------------------------------------------------

    def discover(self) -> list[DiscoveredPeer]:
        stdout = self._run_sync()
        status = self._parse_status(stdout)
        return self._map_status(status)

    # -- async --------------------------------------------------------

    async def adiscover(self) -> list[DiscoveredPeer]:
        if self._arunner is not None:
            stdout = await self._arunner(
                *self._command, "status", "--json"
            )
            status = self._parse_status(stdout)
            return self._map_status(status)
        # Default path: tailscale invocation is quick (<100ms locally),
        # but still offload the blocking subprocess call to a thread
        # so we don't stall the event loop.
        return await asyncio.get_running_loop().run_in_executor(None, self.discover)

    def close(self) -> None:  # pragma: no cover — nothing to release
        return None

    # -- helpers ------------------------------------------------------

    def _run_sync(self) -> str:
        argv = [*self._command, "status", "--json"]
        try:
            if self._runner is not None:
                result = self._runner(
                    argv,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            else:
                result = subprocess.run(  # noqa: S603 — argv is caller-controlled
                    argv,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
        except FileNotFoundError as exc:
            raise ConfigError(
                f"TailscaleDiscovery: `{argv[0]}` not found on PATH. "
                "Install the Tailscale CLI (https://tailscale.com/download) "
                "or pass `command=` with an absolute path.",
                field="command",
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ConfigError(
                f"TailscaleDiscovery: `{' '.join(argv)}` timed out after 10s",
                field="command",
            ) from exc

        if getattr(result, "returncode", 0) != 0:
            stderr = (getattr(result, "stderr", "") or "").strip()
            raise ConfigError(
                f"TailscaleDiscovery: `{' '.join(argv)}` exited "
                f"{result.returncode}"
                + (f" — stderr: {stderr}" if stderr else ""),
                field="command",
            )
        stdout = getattr(result, "stdout", "") or ""
        if not isinstance(stdout, str):
            # `text=True` should always hand us a str, but some test
            # stubs hand back bytes — decode defensively.
            stdout = stdout.decode("utf-8", "replace")
        return stdout

    def _parse_status(self, raw: str) -> dict[str, Any]:
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ConfigError(
                "TailscaleDiscovery: failed to parse `tailscale status --json` "
                f"output: {exc.msg}",
                field="command",
            ) from exc
        if not isinstance(obj, dict):
            raise ConfigError(
                "TailscaleDiscovery: `tailscale status --json` did not return a JSON object",
                field="command",
            )
        return obj

    def _map_status(self, status: dict[str, Any]) -> list[DiscoveredPeer]:
        peers: list[dict[str, Any]] = []
        raw_peers = status.get("Peer")
        if isinstance(raw_peers, dict):
            for value in raw_peers.values():
                if isinstance(value, dict):
                    peers.append(value)
        self_peer = status.get("Self")
        if isinstance(self_peer, dict):
            peers.append(self_peer)

        seen: dict[str, DiscoveredPeer] = {}
        for peer in peers:
            if not self._keep(peer):
                continue
            host = _peer_host(peer)
            if not host:
                continue
            url = f"{self._scheme}://{host}:{self._port}"
            if url in seen:
                continue
            seen[url] = DiscoveredPeer(url=url)
        # Preserve insertion order (py3.7+ dict is ordered).
        return list(seen.values())

    def _keep(self, peer: dict[str, Any]) -> bool:
        if self._predicate is not None:
            try:
                return bool(self._predicate(peer))
            except Exception:  # pragma: no cover — defensive
                return False
        candidate = peer.get("HostName") or peer.get("DNSName") or ""
        if not isinstance(candidate, str):
            return False
        return candidate.lower().startswith(self._prefix)


__all__ = ["TailscaleDiscovery"]
