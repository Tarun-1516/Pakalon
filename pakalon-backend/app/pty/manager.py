"""PtyManager: registry + lifecycle of PtySessions."""
from __future__ import annotations

import asyncio
from typing import Any

from .session import PtySession, PtyHandle


class PtyManager:
    def __init__(self) -> None:
        self._sessions: dict[str, PtySession] = {}
        self._lock = asyncio.Lock()

    async def start(self, command: str, *, cwd: str = "", env: dict | None = None) -> PtyHandle:
        s = PtySession(command, cwd=cwd, env=env)
        handle = await s.start()
        async with self._lock:
            self._sessions[handle.session_id] = s
        return handle

    async def get(self, session_id: str) -> PtySession | None:
        return self._sessions.get(session_id)

    async def write(self, session_id: str, data: str | bytes) -> int:
        s = self._sessions.get(session_id)
        if not s:
            raise KeyError(session_id)
        return await s.write(data)

    async def read(self, session_id: str, timeout: float | None = None) -> bytes:
        s = self._sessions.get(session_id)
        if not s:
            raise KeyError(session_id)
        return await s.read(timeout=timeout)

    async def kill(self, session_id: str) -> bool:
        s = self._sessions.get(session_id)
        if not s:
            return False
        await s.kill()
        self._sessions.pop(session_id, None)
        return True

    async def list(self) -> list[dict[str, Any]]:
        return [
            {
                "session_id": sid,
                "pid": s._proc.pid if s._proc else 0,
                "command": s.command,
                "exit_code": s.exit_code,
                "closed": s.closed,
            }
            for sid, s in self._sessions.items()
        ]


_manager: PtyManager | None = None


def get_manager() -> PtyManager:
    global _manager
    if _manager is None:
        _manager = PtyManager()
    return _manager
