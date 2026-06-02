"""Dashboard router."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .service import get_service, DashboardService, DashboardTile

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def service() -> DashboardService:
    return get_service()


class UpsertRequest(BaseModel):
    id: str
    title: str
    value: Any = None
    detail: str = ""
    status: str = "ok"


@router.get("")
async def summary() -> dict[str, Any]:
    return service().summary()


@router.get("/{tile_id}")
async def get_tile(tile_id: str) -> dict[str, Any] | None:
    t = service().get(tile_id)
    return t.to_dict() if t else None


@router.post("/tiles")
async def upsert(body: UpsertRequest) -> dict[str, Any]:
    service().upsert(DashboardTile(
        id=body.id, title=body.title, value=body.value,
        detail=body.detail, status=body.status,
    ))
    return {"ok": True}
