"""Patches router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .service import PatchService

router = APIRouter(prefix="/patches", tags=["patches"])
_svc = PatchService()


class CreateFromTextRequest(BaseModel):
    file: str
    before: str = ""
    after: str = ""
    author: str = ""
    session_id: str = ""
    summary: str = ""


class CreateFromJsonRequest(BaseModel):
    file: str
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any] = Field(default_factory=dict)
    author: str = ""
    session_id: str = ""
    summary: str = ""


class ApplyRequest(BaseModel):
    before: str
    unified: str


@router.post("/text")
async def create_from_text(body: CreateFromTextRequest) -> dict[str, Any]:
    p = await _svc.create(
        body.file, before=body.before, after=body.after,
        author=body.author, session_id=body.session_id, summary=body.summary,
    )
    return p.to_dict()


@router.post("/json")
async def create_from_json(body: CreateFromJsonRequest) -> dict[str, Any]:
    p = await _svc.create(
        body.file, json_before=body.before, json_after=body.after,
        author=body.author, session_id=body.session_id, summary=body.summary,
    )
    return p.to_dict()


@router.get("")
async def list_patches(
    session_id: str | None = None, file: str | None = None, limit: int = 100,
) -> list[dict[str, Any]]:
    return [p.to_dict() for p in await _svc.list(session_id=session_id, file=file, limit=limit)]


@router.get("/{pid}")
async def get_patch(pid: str) -> dict[str, Any]:
    p = await _svc.get(pid)
    if not p:
        raise HTTPException(status_code=404, detail="not found")
    return p.to_dict()


@router.post("/apply")
async def apply_unified(body: ApplyRequest) -> dict[str, str]:
    return {"result": _svc.apply_unified(body.before, body.unified)}
