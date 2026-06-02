"""DAP router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .manager import DAPManager, get_manager
from .protocol import DAPClient

router = APIRouter(prefix="/dap", tags=["dap"])


def manager() -> DAPManager:
    return get_manager()


class StartRequest(BaseModel):
    language: str
    custom_cmd: str | None = None
    key: str | None = None


class DapRequest(BaseModel):
    command: str
    arguments: dict[str, Any] = {}


@router.post("/start")
async def start_adapter(
    body: StartRequest, mgr: DAPManager = Depends(manager)
) -> dict[str, Any]:
    try:
        client = await mgr.start(body.language, custom_cmd=body.custom_cmd)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    key = body.key or f"client_{id(client)}"
    mgr.register(key, client)
    return {"key": key, "language": body.language}


@router.post("/{key}/request")
async def dap_request(
    key: str, body: DapRequest, mgr: DAPManager = Depends(manager)
) -> dict[str, Any]:
    c = mgr.get(key)
    if not c:
        raise HTTPException(status_code=404, detail="no such DAP client")
    return await c.request(body.command, body.arguments)


@router.post("/{key}/stop")
async def dap_stop(
    key: str, mgr: DAPManager = Depends(manager)
) -> dict[str, bool]:
    ok = await mgr.stop(key)
    if not ok:
        raise HTTPException(status_code=404, detail="no such DAP client")
    return {"stopped": True}


@router.get("/list")
async def dap_list(mgr: DAPManager = Depends(manager)) -> list[str]:
    return mgr.list()
