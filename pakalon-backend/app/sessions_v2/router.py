"""v2 session router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from .service import V2SessionService

router = APIRouter(prefix="/v2/sessions", tags=["sessions-v2"])


def get_service(session: AsyncSession = Depends(get_session)) -> V2SessionService:
    return V2SessionService(session)


class CreateSession(BaseModel):
    title: str = ""
    owner: str = ""
    project_id: str = ""
    parent_id: str = ""


class AddTurn(BaseModel):
    role: str
    content: str
    parent_turn_id: str = ""
    model: str = ""
    tool_calls: list[dict] = Field(default_factory=list)
    tool_results: list[dict] = Field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0


class ForkRequest(BaseModel):
    fork_turn_id: str
    name: str = ""
    parent_branch_id: str = ""


class LogEvent(BaseModel):
    kind: str
    payload: dict[str, Any] = Field(default_factory=dict)
    turn_id: str = ""


@router.post("")
async def create(
    body: CreateSession, svc: V2SessionService = Depends(get_service)
) -> dict[str, Any]:
    s = await svc.create(
        title=body.title, owner=body.owner,
        project_id=body.project_id, parent_id=body.parent_id,
    )
    return s.to_dict()


@router.get("")
async def list_sessions(
    owner: str | None = None, svc: V2SessionService = Depends(get_service)
) -> list[dict[str, Any]]:
    return [s.to_dict() for s in await svc.list(owner=owner)]


@router.get("/{sid}")
async def get_session(
    sid: str, svc: V2SessionService = Depends(get_service)
) -> dict[str, Any]:
    s = await svc.get(sid)
    if not s:
        raise HTTPException(status_code=404, detail="not found")
    return s.to_dict()


@router.post("/{sid}/close")
async def close_session(
    sid: str, svc: V2SessionService = Depends(get_service)
) -> dict[str, bool]:
    ok = await svc.close(sid)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return {"closed": True}


@router.post("/{sid}/turns")
async def add_turn(
    sid: str, body: AddTurn, svc: V2SessionService = Depends(get_service)
) -> dict[str, Any]:
    t = await svc.add_turn(
        sid, body.role, body.content,
        parent_turn_id=body.parent_turn_id, model=body.model,
        tool_calls=body.tool_calls, tool_results=body.tool_results,
        tokens_in=body.tokens_in, tokens_out=body.tokens_out,
    )
    return t.to_dict()


@router.get("/{sid}/turns")
async def list_turns(
    sid: str, svc: V2SessionService = Depends(get_service)
) -> list[dict[str, Any]]:
    return [t.to_dict() for t in await svc.turns(sid)]


@router.post("/{sid}/fork")
async def fork(
    sid: str, body: ForkRequest, svc: V2SessionService = Depends(get_service)
) -> dict[str, Any]:
    b = await svc.fork(
        sid, fork_turn_id=body.fork_turn_id,
        name=body.name, parent_branch_id=body.parent_branch_id,
    )
    return b.to_dict()


@router.get("/{sid}/branches")
async def list_branches(
    sid: str, svc: V2SessionService = Depends(get_service)
) -> list[dict[str, Any]]:
    return [b.to_dict() for b in await svc.branches(sid)]


@router.post("/{sid}/events")
async def log_event(
    sid: str, body: LogEvent, svc: V2SessionService = Depends(get_service)
) -> dict[str, Any]:
    e = await svc.log_event(sid, body.kind, body.payload, turn_id=body.turn_id)
    return e.to_dict()


@router.get("/{sid}/events")
async def list_events(
    sid: str, kind: str | None = None, limit: int = 500,
    svc: V2SessionService = Depends(get_service),
) -> list[dict[str, Any]]:
    return [e.to_dict() for e in await svc.events(sid, kind=kind, limit=limit)]
