"""Snapshots router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .service import SnapshotService

router = APIRouter(prefix="/snapshots", tags=["snapshots"])
_svc = SnapshotService()


class CaptureRequest(BaseModel):
    paths: list[str]
    session_id: str = ""
    label: str = ""
    base_dir: str = "."


class RestoreRequest(BaseModel):
    snapshot_id: str
    target_dir: str = "."


class DiffRequest(BaseModel):
    a: str
    b: str


@router.post("/capture")
async def capture(body: CaptureRequest) -> dict[str, Any]:
    s = await _svc.capture(
        body.paths, session_id=body.session_id,
        label=body.label, base_dir=body.base_dir,
    )
    return s.to_dict()


@router.get("")
async def list_snapshots(
    session_id: str | None = None, limit: int = 100,
) -> list[dict[str, Any]]:
    return [s.to_dict() for s in await _svc.list(session_id=session_id, limit=limit)]


@router.get("/{snap_id}")
async def get_snapshot(snap_id: str) -> dict[str, Any]:
    s = await _svc.get(snap_id)
    if not s:
        raise HTTPException(status_code=404, detail="not found")
    return s.to_dict()


@router.post("/restore")
async def restore(body: RestoreRequest) -> dict[str, int]:
    s = await _svc.get(body.snapshot_id)
    if not s:
        raise HTTPException(status_code=404, detail="not found")
    n = _svc.restore(s, target_dir=body.target_dir)
    return {"restored_files": n}


@router.post("/diff")
async def diff(body: DiffRequest) -> dict[str, list[str]]:
    a = await _svc.get(body.a)
    b = await _svc.get(body.b)
    if not a or not b:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return _svc.diff(a, b)
