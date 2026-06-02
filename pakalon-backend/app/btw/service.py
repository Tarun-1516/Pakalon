"""Btw service."""
from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class BtwSeverity(str, Enum):
    INFO = "info"
    SUCCESS = "success"
    WARN = "warn"
    ERROR = "error"


@dataclass(slots=True)
class BtwNote:
    id: str
    severity: BtwSeverity
    title: str
    body: str
    session_id: str
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "severity": self.severity.value,
            "title": self.title, "body": self.body,
            "session_id": self.session_id, "created_at": self.created_at,
        }


class BtwService:
    def __init__(self, *, maxlen: int = 200) -> None:
        self._notes: dict[str, deque[BtwNote]] = {}
        self._maxlen = maxlen
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()

    async def push(
        self,
        severity: BtwSeverity,
        title: str,
        body: str,
        *,
        session_id: str = "",
    ) -> BtwNote:
        n = BtwNote(
            id=f"btw_{uuid.uuid4().hex[:12]}",
            severity=severity, title=title, body=body, session_id=session_id,
        )
        async with self._lock:
            dq = self._notes.setdefault(session_id, deque(maxlen=self._maxlen))
            dq.append(n)
            for q in self._subscribers.get(session_id, ()):
                try:
                    q.put_nowait(n)
                except asyncio.QueueFull:
                    pass
        return n

    def recent(self, session_id: str = "", n: int = 50) -> list[BtwNote]:
        dq = self._notes.get(session_id, deque())
        return list(dq)[-n:]

    def subscribe(self, session_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subscribers.setdefault(session_id, set()).add(q)
        return q

    def unsubscribe(self, session_id: str, q: asyncio.Queue) -> None:
        s = self._subscribers.get(session_id)
        if s:
            s.discard(q)
            if not s:
                self._subscribers.pop(session_id, None)


_service: BtwService | None = None


def get_service() -> BtwService:
    global _service
    if _service is None:
        _service = BtwService()
    return _service
