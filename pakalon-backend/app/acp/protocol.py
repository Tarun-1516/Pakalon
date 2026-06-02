"""ACP server / client / session / event."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Awaitable, Callable


class ACPRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


@dataclass(slots=True)
class ACPEvent:
    type: str  # message | tool_call | tool_result | error | done | status
    session_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "session_id": self.session_id, "payload": self.payload, "ts": self.ts}


@dataclass(slots=True)
class ACPSession:
    id: str
    created_at: float = field(default_factory=time.time)
    cancelled: bool = False
    history: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def append(self, role: ACPRole, content: str, **meta) -> None:
        self.history.append({"role": role.value, "content": content, "ts": time.time(), **meta})


Handler = Callable[[str, dict], Awaitable[dict]]


class ACPServer:
    """Routes JSON-RPC 2.0 requests to handlers and yields events."""

    def __init__(self) -> None:
        self._sessions: dict[str, ACPSession] = {}
        self._handlers: dict[str, Handler] = {}
        self._events: dict[str, asyncio.Queue[ACPEvent]] = {}

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    async def create_session(self, metadata: dict | None = None) -> ACPSession:
        sid = f"acp_{uuid.uuid4().hex[:16]}"
        s = ACPSession(id=sid, metadata=metadata or {})
        self._sessions[sid] = s
        self._events[sid] = asyncio.Queue(maxsize=5000)
        return s

    def get(self, sid: str) -> ACPSession | None:
        return self._sessions.get(sid)

    async def emit(self, ev: ACPEvent) -> None:
        q = self._events.get(ev.session_id)
        if not q:
            return
        try:
            q.put_nowait(ev)
        except asyncio.QueueFull:
            pass

    async def events(self, sid: str) -> AsyncIterator[ACPEvent]:
        q = self._events.get(sid)
        if not q:
            return
        while True:
            ev = await q.get()
            yield ev

    async def handle(self, sid: str, msg: dict) -> dict:
        """Handle one JSON-RPC 2.0 request. Returns response object."""
        method = msg.get("method", "")
        params = msg.get("params") or {}
        req_id = msg.get("id")
        handler = self._handlers.get(method)
        if not handler:
            return _rpc_err(req_id, -32601, f"method not found: {method}")
        try:
            result = await handler(sid, params)
            return _rpc_result(req_id, result)
        except Exception as e:
            return _rpc_err(req_id, -32000, str(e))


class ACPClient:
    """JSON-RPC 2.0 client speaking the ACP wire format over WebSocket/HTTP."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._id = 1

    def _next_id(self) -> int:
        i = self._id
        self._id += 1
        return i

    async def call(self, method: str, params: dict, *, sid: str | None = None) -> dict:
        import httpx
        url = f"{self.base_url}/acp"
        if sid:
            url += f"?session={sid}"
        async with httpx.AsyncClient() as c:
            r = await c.post(
                url,
                json={"jsonrpc": "2.0", "id": self._next_id(), "method": method, "params": params},
                timeout=60.0,
            )
            r.raise_for_status()
            return r.json()


def _rpc_result(req_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_err(req_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
