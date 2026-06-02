"""Mnemopi service: high-level memory operations."""
from __future__ import annotations

import time
from typing import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from .bank import MemoryBank, MemoryItem, new_id
from .embeddings import EmbeddingProvider, HashingEmbedder


class MnemopiService:
    """Coordinates embedding + bank for memory ops."""

    def __init__(
        self,
        session: AsyncSession,
        embedder: EmbeddingProvider | None = None,
    ) -> None:
        self.session = session
        self.bank = MemoryBank(session)
        self.embedder: EmbeddingProvider = embedder or HashingEmbedder()

    async def remember(
        self,
        content: str,
        *,
        tags: Sequence[str] = (),
        scope: str = "global",
        scope_id: str = "",
        strength: float = 1.0,
        pinned: bool = False,
    ) -> MemoryItem:
        emb = await self.embedder.embed_query(content)
        item = MemoryItem(
            id=new_id(),
            content=content,
            embedding=emb,
            tags=list(tags),
            scope=scope,
            scope_id=scope_id,
            strength=strength,
            pinned=pinned,
        )
        await self.bank.put(item)
        return item

    async def recall(
        self,
        query: str,
        *,
        k: int = 5,
        scope: str | None = None,
        scope_id: str | None = None,
    ) -> list[tuple[MemoryItem, float]]:
        emb = await self.embedder.embed_query(query)
        return await self.bank.search(emb, k=k, scope=scope, scope_id=scope_id)

    async def forget(self, item_id: str) -> bool:
        return await self.bank.delete(item_id)

    async def list_recent(
        self,
        scope: str | None = None,
        scope_id: str | None = None,
        limit: int = 50,
    ) -> list[MemoryItem]:
        return await self.bank.list(scope=scope, scope_id=scope_id, limit=limit)

    async def decay(self, factor: float = 0.95) -> int:
        """Reduce strength of all items by `factor` (called periodically)."""
        items = await self.bank.list(limit=10_000)
        n = 0
        now = time.time()
        for it in items:
            if it.pinned:
                continue
            it.strength *= factor
            await self.bank.put(it)
            n += 1
        return n
