"""Session observer service."""
from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ToolInvocation:
    tool: str
    started_at: float
    ended_at: float = 0.0
    success: bool = True
    error: str = ""


@dataclass(slots=True)
class SessionMetrics:
    session_id: str
    started_at: float = field(default_factory=time.time)
    turn_count: int = 0
    tool_count: int = 0
    tool_success: int = 0
    tool_failure: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    user_messages: int = 0
    assistant_messages: int = 0
    active_tools: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    recent_tools: deque = field(default_factory=lambda: deque(maxlen=50))

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "started_at": self.started_at,
            "turn_count": self.turn_count,
            "tool_count": self.tool_count,
            "tool_success": self.tool_success,
            "tool_failure": self.tool_failure,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "user_messages": self.user_messages,
            "assistant_messages": self.assistant_messages,
            "active_tools": dict(self.active_tools),
            "recent_tools": list(self.recent_tools),
        }


class SessionObserver:
    def __init__(self) -> None:
        self._metrics: dict[str, SessionMetrics] = {}
        self._lock = asyncio.Lock()

    def get(self, session_id: str) -> SessionMetrics:
        m = self._metrics.get(session_id)
        if not m:
            m = SessionMetrics(session_id=session_id)
            self._metrics[session_id] = m
        return m

    def record_user_message(self, session_id: str) -> None:
        m = self.get(session_id)
        m.user_messages += 1
        m.turn_count += 1

    def record_assistant_message(self, session_id: str) -> None:
        m = self.get(session_id)
        m.assistant_messages += 1
        m.turn_count += 1

    def start_tool(self, session_id: str, tool: str) -> str:
        m = self.get(session_id)
        m.tool_count += 1
        m.active_tools[tool] += 1
        invocation_id = f"inv_{uuid.uuid4().hex[:12]}"
        # we don't store invocation objects globally; stats are enough
        return invocation_id

    def end_tool(self, session_id: str, tool: str, *, success: bool, error: str = "") -> None:
        m = self.get(session_id)
        if m.active_tools[tool] > 0:
            m.active_tools[tool] -= 1
        if success:
            m.tool_success += 1
        else:
            m.tool_failure += 1
        m.recent_tools.append({"tool": tool, "ok": success, "ts": time.time(), "error": error})

    def record_tokens(self, session_id: str, tokens_in: int, tokens_out: int) -> None:
        m = self.get(session_id)
        m.tokens_in += tokens_in
        m.tokens_out += tokens_out

    def metrics(self, session_id: str) -> dict[str, Any]:
        return self.get(session_id).to_dict()

    def all_metrics(self) -> list[dict[str, Any]]:
        return [m.to_dict() for m in self._metrics.values()]


_observer: SessionObserver | None = None


def get_observer() -> SessionObserver:
    global _observer
    if _observer is None:
        _observer = SessionObserver()
    return _observer
