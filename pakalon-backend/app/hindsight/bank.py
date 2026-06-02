"""Hindsight multi-bank storage.

Banks: global, project, branch, session.
Each bank stores entries with a pointer into the underlying mnemopi store.
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import String, Text, Float, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.mnemopi.bank import MemoryBank, MemoryItem


@dataclass(slots=True)
class HindsightEntry:
    bank: str  # global | project | branch | session
    scope_id: str
    memory_id: str
    relevance: float = 1.0
    created_at: float = field(default_factory=time.time)


class HindsightIndexRow(Base):
    __tablename__ = "hindsight_index"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    bank: Mapped[str] = mapped_column(String(32))
    scope_id: Mapped[str] = mapped_column(String(128), default="")
    memory_id: Mapped[str] = mapped_column(String(64))
    relevance: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


class HindsightBank:
    """Index layer over a mnemopi MemoryBank."""

    def __init__(self, mnemopi: MemoryBank) -> None:
        self.mnemopi = mnemopi

    async def add(
        self,
        bank: str,
        scope_id: str,
        memory_id: str,
        relevance: float = 1.0,
    ) -> HindsightEntry:
        from app.database import SessionLocal  # late import
        async with SessionLocal() as s:
            row = HindsightIndexRow(
                id=f"hi_{uuid.uuid4().hex[:16]}",
                bank=bank,
                scope_id=scope_id,
                memory_id=memory_id,
                relevance=relevance,
            )
            s.add(row)
            await s.commit()
        return HindsightEntry(
            bank=bank, scope_id=scope_id, memory_id=memory_id, relevance=relevance
        )

    async def resolve(self, entry: HindsightEntry) -> MemoryItem | None:
        return await self.mnemopi.get(entry.memory_id)

    async def list_banks(self) -> list[str]:
        return ["global", "project", "branch", "session"]
