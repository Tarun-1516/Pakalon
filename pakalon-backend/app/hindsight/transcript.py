"""Transcript buffer for hindsight: captures session events for later synthesis."""
from __future__ import annotations

import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Literal

from sqlalchemy import String, Text, Float
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

EventKind = Literal[
    "user_message",
    "assistant_message",
    "tool_call",
    "tool_result",
    "file_change",
    "error",
    "note",
]


@dataclass(slots=True)
class TranscriptEvent:
    id: str
    session_id: str
    kind: EventKind
    payload: str
    ts: float = field(default_factory=time.time)


class TranscriptRow(Base):
    __tablename__ = "hindsight_transcript"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    kind: Mapped[str] = mapped_column(String(32))
    payload: Mapped[str] = mapped_column(Text)
    ts: Mapped[float] = mapped_column(Float, default=time.time)


class TranscriptBuffer:
    """In-memory + persisted transcript buffer (ring by default)."""

    def __init__(self, maxlen: int = 2000) -> None:
        self._buf: dict[str, Deque[TranscriptEvent]] = {}
        self._maxlen = maxlen

    async def append(
        self,
        session_id: str,
        kind: EventKind,
        payload: str,
    ) -> TranscriptEvent:
        ev = TranscriptEvent(
            id=f"tr_{uuid.uuid4().hex[:16]}",
            session_id=session_id, kind=kind, payload=payload,
        )
        # persist
        from app.database import SessionLocal
        async with SessionLocal() as s:
            s.add(TranscriptRow(
                id=ev.id, session_id=session_id,
                kind=kind, payload=payload, ts=ev.ts,
            ))
            await s.commit()
        dq = self._buf.setdefault(session_id, deque(maxlen=self._maxlen))
        dq.append(ev)
        return ev

    def recent(self, session_id: str, n: int = 50) -> list[TranscriptEvent]:
        dq = self._buf.get(session_id, deque())
        return list(dq)[-n:]

    async def load(self, session_id: str, limit: int = 500) -> list[TranscriptEvent]:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            stmt = (
                select(TranscriptRow)
                .where(TranscriptRow.session_id == session_id)
                .order_by(TranscriptRow.ts.desc())
                .limit(limit)
            )
            rows = (await s.execute(stmt)).scalars().all()
        return [
            TranscriptEvent(
                id=r.id, session_id=r.session_id, kind=r.kind,
                payload=r.payload, ts=r.ts,
            )
            for r in rows
        ]
