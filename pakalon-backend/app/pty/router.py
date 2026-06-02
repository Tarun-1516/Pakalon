"""PTY router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .manager import PtyManager, get_manager

router = APIRouter(prefix="/pty", tags=["pty"])


def manager() -> PtyManager:
    return get_manager()


class StartRequest(BaseModel):
    command: str
    cwd: str = ""
    env: dict[str, str] | None = None


class WriteRequest(BaseModel):
    data: str


class ReadRequest(BaseModel):
    timeout: float | None = None
    max_bytes: int = 4096


@router.post("/start")
async def start_session(
    body: StartRequest, mgr: PtyManager = Depends(manager)
) -> dict[str, Any]:
    handle = await mgr.start(body.command, cwd=body.cwd, env=body.env)
    return handle.to_dict()


@router.post("/{session_id}/write")
async def write_session(
    session_id: str, body: WriteRequest, mgr: PtyManager = Depends(manager)
) -> dict[str, int]:
    try:
        n = await mgr.write(session_id, body.data)
    except KeyError:
        raise HTTPException(status_code=404, detail="no such pty session")
    return {"written": n}


@router.post("/{session_id}/read")
async def read_session(
    session_id: str, body: ReadRequest, mgr: PtyManager = Depends(manager)
) -> dict[str, Any]:
    try:
        data = await mgr.read(session_id, timeout=body.timeout)
    except KeyError:
        raise HTTPException(status_code=404, detail="no such pty session")
    return {"data": data.decode("utf-8", errors="replace")[: body.max_bytes]}


@router.post("/{session_id}/kill")
async def kill_session(
    session_id: str, mgr: PtyManager = Depends(manager)
) -> dict[str, bool]:
    ok = await mgr.kill(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="no such pty session")
    return {"killed": True}


@router.get("/list")
async def list_sessions(mgr: PtyManager = Depends(manager)) -> list[dict[str, Any]]:
    return await mgr.list()
