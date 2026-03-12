"""Brain resource for the shared knowledge base."""

from __future__ import annotations

from typing import Any

from cognitum._http import AsyncHttpClient, SyncHttpClient
from cognitum.types import BrainMemory, BrainSearchResult


def _parse_memory(data: Any) -> BrainMemory:
    return BrainMemory(
        id=data.get("id", ""),
        content=data.get("content", ""),
        author=data.get("author"),
        score=data.get("score", 0.0),
        created_at=data.get("created_at") or data.get("createdAt"),
        metadata=data.get("metadata", {}),
    )


def _parse_search_result(data: Any) -> BrainSearchResult:
    raw = data.get("memories", data.get("results", []))
    memories = [_parse_memory(m) for m in raw]
    return BrainSearchResult(
        memories=memories,
        total=data.get("total", len(memories)),
        query=data.get("query"),
    )


class BrainResource:
    """Synchronous brain knowledge-base resource."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def share(
        self,
        content: str,
        *,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> BrainMemory:
        """Share a piece of knowledge with the brain."""
        payload: dict[str, Any] = {"content": content}
        if tags:
            payload["tags"] = tags
        if metadata:
            payload["metadata"] = metadata
        data = self._http.post("/brainShare", json=payload)
        return _parse_memory(data)

    def search(self, query: str, *, limit: int = 10) -> BrainSearchResult:
        """Search the brain knowledge base."""
        data = self._http.get(
            "/brainSearch", params={"query": query, "limit": limit}
        )
        return _parse_search_result(data)

    def vote(self, memory_id: str, *, direction: str = "up") -> dict[str, Any]:
        """Vote on a brain memory entry."""
        return self._http.post(
            "/brainVote", json={"memoryId": memory_id, "direction": direction}
        )


class AsyncBrainResource:
    """Asynchronous brain knowledge-base resource."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def share(
        self,
        content: str,
        *,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> BrainMemory:
        """Share a piece of knowledge with the brain."""
        payload: dict[str, Any] = {"content": content}
        if tags:
            payload["tags"] = tags
        if metadata:
            payload["metadata"] = metadata
        data = await self._http.post("/brainShare", json=payload)
        return _parse_memory(data)

    async def search(self, query: str, *, limit: int = 10) -> BrainSearchResult:
        """Search the brain knowledge base."""
        data = await self._http.get(
            "/brainSearch", params={"query": query, "limit": limit}
        )
        return _parse_search_result(data)

    async def vote(self, memory_id: str, *, direction: str = "up") -> dict[str, Any]:
        """Vote on a brain memory entry."""
        return await self._http.post(
            "/brainVote", json={"memoryId": memory_id, "direction": direction}
        )
