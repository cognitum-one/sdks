"""Session handle that pins one peer for the life of a logical request
sequence (ADR-0016a §D4 / §D9).

Read-your-writes within a session: issuing an ingest followed by a query
through the same :class:`SeedSession` lands both calls on the same peer
unless the peer fails hard. On hard failure the transport's mesh loop
transparently cycles to the next peer (§D3) — the session's pin remains
advisory, not a hard lock.

Mirrors the Rust reference at ``sdks/rust/src/seed/session.rs``.
"""

from __future__ import annotations

from types import TracebackType
from typing import TYPE_CHECKING, Any

from cognitum.seed._call_options import CallOptions
from cognitum.seed._models import Identity, Status
from cognitum.seed.resources import (
    AsyncCustodyResource,
    AsyncMeshResource,
    AsyncOtaResource,
    AsyncPairResource,
    AsyncStoreResource,
    AsyncWitnessResource,
    CustodyResource,
    MeshResource,
    OtaResource,
    PairResource,
    StoreResource,
    WitnessResource,
)

if TYPE_CHECKING:  # pragma: no cover — type-only
    from cognitum.seed._async_client import AsyncSeedClient
    from cognitum.seed._client import SeedClient


class _PinnedTransport:
    """Adapter that rewrites every ``request(...)`` call to inject a
    pinned ``peer_key`` kwarg.

    Resource classes (``PairResource`` et al.) are constructed with this
    adapter in place of the raw transport, so no resource code needs to
    know about the session's peer pin.
    """

    __slots__ = ("_inner", "_peer_key")

    def __init__(self, inner: Any, peer_key: str) -> None:
        self._inner = inner
        self._peer_key = peer_key

    def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
        options: CallOptions | None = None,
    ) -> Any:
        return self._inner.request(
            method,
            path,
            json=json,
            params=params,
            idempotent=idempotent,
            peer_key=self._peer_key,
            options=options,
        )


class _AsyncPinnedTransport(_PinnedTransport):
    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        idempotent: bool | None = None,
        options: CallOptions | None = None,
    ) -> Any:
        return await self._inner.request(
            method,
            path,
            json=json,
            params=params,
            idempotent=idempotent,
            peer_key=self._peer_key,
            options=options,
        )


class SeedSession:
    """Synchronous session pinned to one peer (ADR-0016a §D9).

    Instantiate via :meth:`SeedClient.session` — do not construct
    directly. Use as a context manager::

        with client.session() as s:
            s.store.ingest(vectors=[...])
            s.store.query(vector=[...], k=10)
    """

    pair: PairResource
    store: StoreResource
    custody: CustodyResource
    witness: WitnessResource
    ota: OtaResource
    mesh: MeshResource

    def __init__(self, client: SeedClient, peer_key: str) -> None:
        self._client = client
        self._peer_key = peer_key
        # Each session owns its own pinned transport adapter; the underlying
        # httpx client is shared with the parent SeedClient so connection
        # pooling works.
        adapter = _PinnedTransport(client._transport, peer_key)
        self.pair = PairResource(adapter)
        self.store = StoreResource(adapter)
        self.custody = CustodyResource(adapter)
        self.witness = WitnessResource(adapter)
        self.ota = OtaResource(adapter)
        self.mesh = MeshResource(adapter)
        self._adapter = adapter

    @property
    def pinned_peer(self) -> str:
        """Canonical URL of the peer this session is pinned to."""
        return self._peer_key

    def status(self) -> Status:
        data = self._adapter.request("GET", "/api/v1/status")
        return Status.from_wire(data or {})

    def identity(self) -> Identity:
        data = self._adapter.request("GET", "/api/v1/identity")
        return Identity.from_wire(data or {})

    def close(self) -> None:
        """Release the session. The parent client stays open."""
        # Pin is advisory; nothing to tear down.
        return None

    def __enter__(self) -> SeedSession:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()


class AsyncSeedSession:
    """Asynchronous session pinned to one peer (mirror of :class:`SeedSession`)."""

    pair: AsyncPairResource
    store: AsyncStoreResource
    custody: AsyncCustodyResource
    witness: AsyncWitnessResource
    ota: AsyncOtaResource
    mesh: AsyncMeshResource

    def __init__(self, client: AsyncSeedClient, peer_key: str) -> None:
        self._client = client
        self._peer_key = peer_key
        adapter = _AsyncPinnedTransport(client._transport, peer_key)
        self.pair = AsyncPairResource(adapter)
        self.store = AsyncStoreResource(adapter)
        self.custody = AsyncCustodyResource(adapter)
        self.witness = AsyncWitnessResource(adapter)
        self.ota = AsyncOtaResource(adapter)
        self.mesh = AsyncMeshResource(adapter)
        self._adapter = adapter

    @property
    def pinned_peer(self) -> str:
        return self._peer_key

    async def status(self) -> Status:
        data = await self._adapter.request("GET", "/api/v1/status")
        return Status.from_wire(data or {})

    async def identity(self) -> Identity:
        data = await self._adapter.request("GET", "/api/v1/identity")
        return Identity.from_wire(data or {})

    async def close(self) -> None:
        return None

    async def __aenter__(self) -> AsyncSeedSession:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()


__all__ = ["AsyncSeedSession", "SeedSession"]
