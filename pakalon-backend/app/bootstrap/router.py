"""Bootstrap router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .service import BootstrapService, StepStatus

router = APIRouter(prefix="/bootstrap", tags=["bootstrap"])
_svc = BootstrapService()


class StepUpdate(BaseModel):
    step_id: str
    status: StepStatus
    error: str = ""


@router.post("/start")
async def start() -> dict[str, Any]:
    return _svc.start().to_dict()


@router.get("/{bid}")
async def get_state(bid: str) -> dict[str, Any]:
    s = _svc.get(bid)
    if not s:
        raise HTTPException(status_code=404, detail="not found")
    return s.to_dict()


@router.post("/{bid}/step")
async def update_step(bid: str, body: StepUpdate) -> dict[str, bool]:
    ok = _svc.set_step(bid, body.step_id, body.status, body.error)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"updated": True}


@router.post("/{bid}/finish")
async def finish(bid: str) -> dict[str, bool]:
    _svc.finish(bid)
    return {"finished": True}


@router.get("")
async def list_all() -> list[dict[str, Any]]:
    return [s.to_dict() for s in _svc.list()]
