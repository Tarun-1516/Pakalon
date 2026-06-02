"""ACP HTTP router (JSON-RPC 2.0 over POST + SSE event stream)."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .protocol import ACPServer

router = APIRouter(prefix="/acp", tags=["acp"])


_server: ACPServer | None = None


def get_server() -> ACPServer:
    global _server
    if _server is None:
        _server = ACPServer()
    return _server


class CreateRequest(BaseModel):
    metadata: dict[str, Any] | None = None


class CancelRequest(BaseModel):
    session_id: str


@router.post("/session")
async def create_session(body: CreateRequest) -> dict[str, Any]:
    s = await get_server().create_session(body.metadata or {})
    return {"session_id": s.id, "created_at": s.created_at}


@router.post("/cancel")
async def cancel(body: CancelRequest) -> dict[str, bool]:
    s = get_server().get(body.session_id)
    if not s:
        raise HTTPException(status_code=404, detail="no such session")
    s.cancelled = True
    return {"cancelled": True}


@router.post("/rpc")
async def rpc(session: str, request: Request) -> dict[str, Any]:
    """JSON-RPC 2.0 endpoint. Session id is supplied as ?session=..."""
    try:
        msg = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON")
    return await get_server().handle(session, msg)


@router.get("/events/{session_id}")
async def events_stream(session_id: str, request: Request):
    """Server-Sent Events stream of session events."""
    s = get_server().get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="no such session")

    async def gen():
        yield ": ping\n\n"
        async for ev in get_server().events(session_id):
            if await request.is_disconnected():
                return
            yield f"data: {json.dumps(ev.to_dict())}\n\n"
            if ev.type in {"done", "error"}:
                return

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
