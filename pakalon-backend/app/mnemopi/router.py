"""FastAPI router for mnemopi memory operations."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from .service import MnemopiService

router = APIRouter(prefix="/mnemopi", tags=["mnemopi"])


def get_service(session: AsyncSession = Depends(get_session)) -> MnemopiService:
    return MnemopiService(session)


class RememberRequest(BaseModel):
    content: str
    tags: list[str] = Field(default_factory=list)
    scope: str = "global"
    scope_id: str = ""
    strength: float = 1.0
    pinned: bool = False


class RecallRequest(BaseModel):
    query: str
    k: int = 5
    scope: str | None = None
    scope_id: str | None = None


class MemoryOut(BaseModel):
    id: str
    content: str
    tags: list[str]
    scope: str
    scope_id: str
    strength: float
    pinned: bool


class RecallHit(MemoryOut):
    score: float


@router.post("/remember")
async def remember(
    body: RememberRequest,
    svc: MnemopiService = Depends(get_service),
) -> dict[str, Any]:
    item = await svc.remember(
        body.content,
        tags=body.tags,
        scope=body.scope,
        scope_id=body.scope_id,
        strength=body.strength,
        pinned=body.pinned,
    )
    return {"id": item.id, "stored": True}


@router.post("/recall")
async def recall(
    body: RecallRequest,
    svc: MnemopiService = Depends(get_service),
) -> list[RecallHit]:
    hits = await svc.recall(
        body.query, k=body.k, scope=body.scope, scope_id=body.scope_id
    )
    return [
        RecallHit(
            id=it.id,
            content=it.content,
            tags=it.tags,
            scope=it.scope,
            scope_id=it.scope_id,
            strength=it.strength,
            pinned=it.pinned,
            score=score,
        )
        for it, score in hits
    ]


@router.get("/list")
async def list_recent(
    scope: str | None = None,
    scope_id: str | None = None,
    limit: int = 50,
    svc: MnemopiService = Depends(get_service),
) -> list[MemoryOut]:
    items = await svc.list_recent(scope=scope, scope_id=scope_id, limit=limit)
    return [
        MemoryOut(
            id=it.id,
            content=it.content,
            tags=it.tags,
            scope=it.scope,
            scope_id=it.scope_id,
            strength=it.strength,
            pinned=it.pinned,
        )
        for it in items
    ]


@router.delete("/{item_id}")
async def forget(
    item_id: str,
    svc: MnemopiService = Depends(get_service),
) -> dict[str, bool]:
    ok = await svc.forget(item_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"forgotten": True}


@router.post("/decay")
async def decay(
    factor: float = 0.95,
    svc: MnemopiService = Depends(get_service),
) -> dict[str, int]:
    n = await svc.decay(factor=factor)
    return {"decayed": n}
