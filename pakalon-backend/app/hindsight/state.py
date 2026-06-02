"""Hindsight state: per-session derived state (focus, summary, todos)."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import String, Text, Float
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class HindsightStateRow(Base):
    __tablename__ = "hindsight_state"
    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    focus: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    todos: Mapped[str] = mapped_column(Text, default="[]")
    open_threads: Mapped[str] = mapped_column(Text, default="[]")
    updated_at: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class HindsightState:
    session_id: str
    focus: str = ""
    summary: str = ""
    todos: list[str] = field(default_factory=list)
    open_threads: list[str] = field(default_factory=list)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "focus": self.focus,
            "summary": self.summary,
            "todos": self.todos,
            "open_threads": self.open_threads,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, r: HindsightStateRow) -> "HindsightState":
        return cls(
            session_id=r.session_id,
            focus=r.focus,
            summary=r.summary,
            todos=json.loads(r.todos or "[]"),
            open_threads=json.loads(r.open_threads or "[]"),
            updated_at=r.updated_at,
        )


class HindsightStateStore:
    async def get(self, session_id: str) -> HindsightState:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            row = await s.get(HindsightStateRow, session_id)
            if not row:
                return HindsightState(session_id=session_id)
            return HindsightState.from_row(row)

    async def save(self, state: HindsightState) -> None:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            row = await s.get(HindsightStateRow, state.session_id)
            now = time.time()
            if not row:
                row = HindsightStateRow(session_id=state.session_id)
                s.add(row)
            row.focus = state.focus
            row.summary = state.summary
            row.todos = json.dumps(state.todos)
            row.open_threads = json.dumps(state.open_threads)
            row.updated_at = now
            await s.commit()
            state.updated_at = now
