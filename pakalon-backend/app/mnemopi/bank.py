"""Memory bank: storage and retrieval of memory items."""
from __future__ import annotations

import json
import math
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Sequence

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import Base
from sqlalchemy import String, Text, Integer, Float, Boolean
from sqlalchemy.orm import Mapped, mapped_column


@dataclass(slots=True)
class MemoryItem:
    """A single memory item stored in the bank."""
    id: str
    content: str
    embedding: list[float] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    scope: str = "global"  # global | project | session
    scope_id: str = ""
    created_at: float = field(default_factory=time.time)
    accessed_at: float = field(default_factory=time.time)
    access_count: int = 0
    strength: float = 1.0
    pinned: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_row(cls, row: "MemoryRow") -> "MemoryItem":
        return cls(
            id=row.id,
            content=row.content,
            embedding=json.loads(row.embedding or "[]"),
            tags=json.loads(row.tags or "[]"),
            scope=row.scope,
            scope_id=row.scope_id,
            created_at=row.created_at,
            accessed_at=row.accessed_at,
            access_count=row.access_count,
            strength=row.strength,
            pinned=row.pinned,
        )


class MemoryRow(Base):
    """SQLAlchemy row for memory items."""
    __tablename__ = "mnemopi_memory"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[str] = mapped_column(Text, default="[]")
    tags: Mapped[str] = mapped_column(Text, default="[]")
    scope: Mapped[str] = mapped_column(String(32), default="global")
    scope_id: Mapped[str] = mapped_column(String(128), default="")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    accessed_at: Mapped[float] = mapped_column(Float, default=time.time)
    access_count: Mapped[int] = mapped_column(Integer, default=0)
    strength: Mapped[float] = mapped_column(Float, default=1.0)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)


class MemoryBank:
    """Storage abstraction over memory items with cosine similarity search."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def put(self, item: MemoryItem) -> None:
        row = MemoryRow(
            id=item.id,
            content=item.content,
            embedding=json.dumps(item.embedding),
            tags=json.dumps(item.tags),
            scope=item.scope,
            scope_id=item.scope_id,
            created_at=item.created_at,
            accessed_at=item.accessed_at,
            access_count=item.access_count,
            strength=item.strength,
            pinned=item.pinned,
        )
        await self._session.merge(row)
        await self._session.commit()

    async def get(self, item_id: str) -> MemoryItem | None:
        row = await self._session.get(MemoryRow, item_id)
        return MemoryItem.from_row(row) if row else None

    async def delete(self, item_id: str) -> bool:
        row = await self._session.get(MemoryRow, item_id)
        if not row:
            return False
        await self._session.delete(row)
        await self._session.commit()
        return True

    async def list(
        self,
        scope: str | None = None,
        scope_id: str | None = None,
        limit: int = 100,
    ) -> list[MemoryItem]:
        stmt = select(MemoryRow).order_by(MemoryRow.created_at.desc()).limit(limit)
        if scope:
            stmt = stmt.where(MemoryRow.scope == scope)
        if scope_id:
            stmt = stmt.where(MemoryRow.scope_id == scope_id)
        rows = (await self._session.execute(stmt)).scalars().all()
        return [MemoryItem.from_row(r) for r in rows]

    async def search(
        self,
        query_embedding: Sequence[float],
        k: int = 5,
        scope: str | None = None,
        scope_id: str | None = None,
    ) -> list[tuple[MemoryItem, float]]:
        """Return top-k items by cosine similarity."""
        items = await self.list(scope=scope, scope_id=scope_id, limit=10_000)
        scored: list[tuple[MemoryItem, float]] = []
        for it in items:
            if not it.embedding:
                continue
            score = _cosine(query_embedding, it.embedding)
            scored.append((it, score))
        scored.sort(key=lambda t: t[1], reverse=True)
        # Update access counts on top results
        for it, _ in scored[:k]:
            await self._touch(it.id)
        return scored[:k]

    async def _touch(self, item_id: str) -> None:
        row = await self._session.get(MemoryRow, item_id)
        if row:
            row.accessed_at = time.time()
            row.access_count += 1
            await self._session.commit()

    async def clear_scope(self, scope: str, scope_id: str = "") -> int:
        stmt = delete(MemoryRow).where(MemoryRow.scope == scope)
        if scope_id:
            stmt = stmt.where(MemoryRow.scope_id == scope_id)
        result = await self._session.execute(stmt)
        await self._session.commit()
        return result.rowcount or 0


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def new_id() -> str:
    return f"mem_{uuid.uuid4().hex[:16]}"
