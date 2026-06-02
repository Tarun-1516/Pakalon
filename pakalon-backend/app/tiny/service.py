"""Tiny service."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from sqlalchemy import String, Text, Float
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TinyKind(str, Enum):
    NOTE = "note"
    LINK = "link"
    SNIPPET = "snippet"
    BOOKMARK = "bookmark"
    REMINDER = "reminder"
    QUOTE = "quote"
    TODO = "todo"
    CONTACT = "contact"


class TinyRow(Base):
    __tablename__ = "tiny_items"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(512))
    body: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String(1024), default="")
    tags: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    updated_at: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class TinyItem:
    id: str
    user_id: str
    kind: TinyKind
    title: str
    body: str
    url: str
    tags: list[str] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "user_id": self.user_id, "kind": self.kind.value,
            "title": self.title, "body": self.body, "url": self.url,
            "tags": self.tags, "created_at": self.created_at, "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, r: TinyRow) -> "TinyItem":
        import json
        return cls(
            id=r.id, user_id=r.user_id, kind=TinyKind(r.kind),
            title=r.title, body=r.body, url=r.url,
            tags=json.loads(r.tags or "[]"),
            created_at=r.created_at, updated_at=r.updated_at,
        )


class TinyService:
    def _new_id(self) -> str:
        return f"tny_{uuid.uuid4().hex[:16]}"

    async def create(
        self,
        kind: TinyKind,
        title: str,
        *,
        body: str = "",
        url: str = "",
        tags: list[str] | None = None,
        user_id: str = "",
    ) -> TinyItem:
        from app.database import SessionLocal
        import json
        iid = self._new_id()
        now = time.time()
        row = TinyRow(
            id=iid, user_id=user_id, kind=kind.value, title=title,
            body=body, url=url, tags=json.dumps(tags or []),
            created_at=now, updated_at=now,
        )
        async with SessionLocal() as s:
            s.add(row)
            await s.commit()
        return TinyItem.from_row(row)

    async def get(self, iid: str) -> TinyItem | None:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            r = await s.get(TinyRow, iid)
        return TinyItem.from_row(r) if r else None

    async def list(
        self,
        user_id: str | None = None,
        kind: TinyKind | None = None,
        limit: int = 100,
    ) -> list[TinyItem]:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            stmt = select(TinyRow).order_by(TinyRow.created_at.desc()).limit(limit)
            if user_id:
                stmt = stmt.where(TinyRow.user_id == user_id)
            if kind:
                stmt = stmt.where(TinyRow.kind == kind.value)
            rows = (await s.execute(stmt)).scalars().all()
        return [TinyItem.from_row(r) for r in rows]

    async def delete(self, iid: str) -> bool:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            r = await s.get(TinyRow, iid)
            if not r:
                return False
            await s.delete(r)
            await s.commit()
        return True
