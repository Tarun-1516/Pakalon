"""Tiny router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .service import TinyService, TinyKind

router = APIRouter(prefix="/tiny", tags=["tiny"])
_svc = TinyService()


class CreateRequest(BaseModel):
    kind: TinyKind
    title: str
    body: str = ""
    url: str = ""
    tags: list[str] = Field(default_factory=list)
    user_id: str = ""


@router.post("")
async def create(body: CreateRequest) -> dict[str, Any]:
    item = await _svc.create(
        body.kind, body.title,
        body=body.body, url=body.url,
        tags=body.tags, user_id=body.user_id,
    )
    return item.to_dict()


@router.get("")
async def list_items(
    user_id: str | None = None,
    kind: TinyKind | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    return [i.to_dict() for i in await _svc.list(user_id=user_id, kind=kind, limit=limit)]


@router.get("/{iid}")
async def get_item(iid: str) -> dict[str, Any]:
    i = await _svc.get(iid)
    if not i:
        raise HTTPException(status_code=404, detail="not found")
    return i.to_dict()


@router.delete("/{iid}")
async def delete_item(iid: str) -> dict[str, bool]:
    ok = await _svc.delete(iid)
    return {"deleted": ok}
