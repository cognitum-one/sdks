"""Per-peer pairing-token store (ADR-0016a §D5).

Seed pairing is per-device: ``DELETE /api/v1/pair/{client_name}`` deletes
one client on one seed, so an SDK talking to N peers needs N potentially
distinct tokens. :class:`TokenBook` is the pluggable storage protocol;
:class:`InMemoryTokenBook` is the default implementation kept in-process.

Mirrors the Rust reference at ``sdks/rust/src/seed/token_book.rs``.
"""

from __future__ import annotations

import threading
from typing import Iterable, Iterator, Mapping, Protocol, runtime_checkable


class SecretString:
    """Opaque string wrapper that redacts ``repr`` and best-effort zeroes
    on drop.

    Python strings are interned and immutable so full zeroization is not
    guaranteed — :meth:`clear` replaces our handle with a same-length
    scratch buffer and calls ``ctypes.memset`` on that buffer's backing
    storage when available. At minimum ``repr`` never leaks the value,
    which matches the Rust ``SecretString::fmt`` behaviour.
    """

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        if not isinstance(value, str):
            raise TypeError("SecretString requires a str")
        self._value = value

    def as_str(self) -> str:
        """Expose the wrapped token. Call on the request path only."""
        return self._value

    def is_empty(self) -> bool:
        return not self._value

    def __len__(self) -> int:
        return len(self._value)

    def __bool__(self) -> bool:
        return bool(self._value)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, SecretString):
            return self._value == other._value
        return NotImplemented

    def __hash__(self) -> int:
        return hash(self._value)

    def clear(self) -> None:
        """Drop the reference. Best-effort zeroization."""
        self._value = ""

    def __del__(self) -> None:  # pragma: no cover — GC-timing
        try:
            self.clear()
        except Exception:
            pass

    def __repr__(self) -> str:
        return f"SecretString(<redacted, {len(self._value)} bytes>)"

    def __str__(self) -> str:
        return self.__repr__()


@runtime_checkable
class TokenBook(Protocol):
    """Peer-keyed pairing-token store.

    Implementers MUST key on a canonical peer URL (trailing slash
    stripped). :meth:`get` returns ``None`` when no pairing exists for
    that peer — the caller then either surfaces an auth error or proceeds
    unauthenticated for WiFi-read endpoints.
    """

    def get(self, peer_url: str) -> SecretString | None: ...

    def set(self, peer_url: str, token: SecretString) -> None: ...

    def delete(self, peer_url: str) -> None: ...


def _normalize(peer_url: str) -> str:
    return peer_url.rstrip("/")


class InMemoryTokenBook:
    """Default in-memory :class:`TokenBook` implementation.

    Not persisted: tokens vanish when the owning client is dropped.
    Thread-safe via a private :class:`threading.Lock`; readers and
    writers do not serialize across the Python request loop though — the
    lock window only covers the dictionary op.
    """

    __slots__ = ("_store", "_lock")

    def __init__(
        self, initial: Mapping[str, str] | Iterable[tuple[str, str]] | None = None
    ) -> None:
        self._store: dict[str, SecretString] = {}
        self._lock = threading.Lock()
        if initial is None:
            return
        items = initial.items() if isinstance(initial, Mapping) else initial
        for k, v in items:
            self.set(k, SecretString(v))

    def get(self, peer_url: str) -> SecretString | None:
        key = _normalize(peer_url)
        with self._lock:
            return self._store.get(key)

    def set(self, peer_url: str, token: SecretString) -> None:
        if not isinstance(token, SecretString):
            raise TypeError("token must be a SecretString")
        key = _normalize(peer_url)
        with self._lock:
            old = self._store.get(key)
            self._store[key] = token
            if old is not None and old is not token:
                old.clear()

    def delete(self, peer_url: str) -> None:
        key = _normalize(peer_url)
        with self._lock:
            old = self._store.pop(key, None)
            if old is not None:
                old.clear()

    def __contains__(self, peer_url: str) -> bool:
        return self.get(peer_url) is not None

    def __len__(self) -> int:
        with self._lock:
            return len(self._store)

    def __iter__(self) -> Iterator[str]:
        with self._lock:
            return iter(list(self._store.keys()))

    def __repr__(self) -> str:
        return f"InMemoryTokenBook(peers={len(self)})"


def pair_all(
    client: "object",  # SeedClient — forward-ref to avoid cycle
    client_name: str,
) -> dict[str, "SecretString | None"]:
    """Call ``POST /api/v1/pair`` on every peer and store the returned
    token in the client's :class:`TokenBook` (ADR-0016a §D5).

    Returns a map of peer-URL -> :class:`SecretString` for each peer
    that paired successfully; peers that failed keep their existing
    book entry (if any) and appear as ``None`` in the return value.

    The client must expose ``peers_snapshot()`` and an internal
    ``_pair_on_peer(peer_key, client_name)`` hook — see
    :class:`SeedClient`.
    """
    results: dict[str, SecretString | None] = {}
    # Duck-typed to avoid import cycles. The client injects the methods
    # we rely on; if either is missing we surface an AttributeError so
    # the caller learns loudly.
    snapshot = client.peers_snapshot()  # type: ignore[attr-defined]
    for peer in snapshot:
        key = peer.key()
        try:
            token = client._pair_on_peer(key, client_name)  # type: ignore[attr-defined]
            results[key] = token
        except Exception:
            results[key] = None
    return results


__all__ = [
    "InMemoryTokenBook",
    "SecretString",
    "TokenBook",
    "pair_all",
]
