"""Goals router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from .models import GoalStatus
from .service import GoalsService

router = APIRouter(prefix="/goals", tags=["goals"])


def get_service(session: AsyncSession = Depends(get_session)) -> GoalsService:
    return GoalsService(session)


class CreateGoalRequest(BaseModel):
    title: str
    description: str = ""
    parent_id: str = ""
    session_id: str = ""
    priority: int = 0
    tags: list[str] = Field(default_factory=list)


class UpdateGoalRequest(BaseModel):
    status: GoalStatus | None = None
    progress: float | None = None
    priority: int | None = None
    add_blocker: str | None = None
    remove_blocker: str | None = None


class GoalOut(BaseModel):
    id: str
    parent_id: str
    session_id: str
    title: str
    description: str
    status: str
    priority: int
    progress: float
    tags: list[str]
    blocked_by: list[str]
    created_at: float
    updated_at: float
    completed_at: float


@router.post("")
async def create_goal(
    body: CreateGoalRequest, svc: GoalsService = Depends(get_service)
) -> GoalOut:
    g = await svc.create(
        body.title, body.description,
        parent_id=body.parent_id, session_id=body.session_id,
        priority=body.priority, tags=body.tags,
    )
    return GoalOut(**g.to_dict())


@router.get("/{goal_id}")
async def get_goal(
    goal_id: str, svc: GoalsService = Depends(get_service)
) -> GoalOut:
    g = await svc.get(goal_id)
    if not g:
        raise HTTPException(status_code=404, detail="not found")
    return GoalOut(**g.to_dict())


@router.get("")
async def list_goals(
    session_id: str | None = None,
    status: GoalStatus | None = None,
    parent_id: str | None = None,
    svc: GoalsService = Depends(get_service),
) -> list[GoalOut]:
    items = await svc.list(
        session_id=session_id, status=status, parent_id=parent_id
    )
    return [GoalOut(**g.to_dict()) for g in items]


@router.patch("/{goal_id}")
async def update_goal(
    goal_id: str, body: UpdateGoalRequest,
    svc: GoalsService = Depends(get_service),
) -> GoalOut:
    g = await svc.update(
        goal_id,
        status=body.status, progress=body.progress,
        priority=body.priority,
        add_blocker=body.add_blocker, remove_blocker=body.remove_blocker,
    )
    if not g:
        raise HTTPException(status_code=404, detail="not found")
    return GoalOut(**g.to_dict())


@router.get("/{goal_id}/children")
async def children(
    goal_id: str, svc: GoalsService = Depends(get_service)
) -> list[GoalOut]:
    items = await svc.children(goal_id)
    return [GoalOut(**g.to_dict()) for g in items]


@router.get("/ready/list")
async def ready(
    session_id: str | None = None,
    svc: GoalsService = Depends(get_service),
) -> list[GoalOut]:
    items = await svc.ready(session_id=session_id)
    return [GoalOut(**g.to_dict()) for g in items]
