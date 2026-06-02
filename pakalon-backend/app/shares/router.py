"""Shares router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .service import ShareService, ShareScope

router = APIRouter(prefix="/shares", tags=["shares"])
_svc = ShareService()


class CreateRequest(BaseModel):
    scope: ShareScope
    target_id: str
    author: str = ""
    password: str = ""
    ttl_seconds: int = 0


@router.post("")
async def create_share(body: CreateRequest) -> dict[str, Any]:
    s = await _svc.create(
        body.scope, body.target_id,
        author=body.author, password=body.password,
        ttl_seconds=body.ttl_seconds,
    )
    return s.to_dict()


@router.get("/{token}")
async def get_share(token: str, password: str = "") -> dict[str, Any]:
    s = await _svc.get(token, password=password)
    if not s:
        raise HTTPException(status_code=404, detail="not found or invalid")
    return s.to_dict()


@router.delete("/{token}")
async def revoke_share(token: str) -> dict[str, bool]:
    ok = await _svc.revoke(token)
    return {"revoked": ok}


@router.get("")
async def list_shares(author: str | None = None) -> list[dict[str, Any]]:
    return [s.to_dict() for s in await _svc.list(author=author)]
