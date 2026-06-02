"""Commit router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from .models import CommitType
from .service import CommitService

router = APIRouter(prefix="/commits", tags=["commits"])


def get_service(session: AsyncSession = Depends(get_session)) -> CommitService:
    return CommitService(session)


class CreateCommitRequest(BaseModel):
    subject: str
    type: CommitType = CommitType.FEAT
    scope: str = ""
    body: str = ""
    footer: str = ""
    files: list[str] = Field(default_factory=list)
    breaking: bool = False
    session_id: str = ""
    branch: str = ""


class CommitOut(BaseModel):
    id: str
    session_id: str
    branch: str
    type: str
    scope: str
    subject: str
    body: str
    footer: str
    files: list[str]
    breaking: bool
    sha: str
    message: str
    created_at: float


@router.post("")
async def create_commit(
    body: CreateCommitRequest, svc: CommitService = Depends(get_service)
) -> CommitOut:
    c = await svc.create(
        body.subject, type=body.type, scope=body.scope,
        body=body.body, footer=body.footer,
        files=body.files, breaking=body.breaking,
        session_id=body.session_id, branch=body.branch,
    )
    return CommitOut(**c.to_dict())


@router.get("")
async def list_commits(
    session_id: str | None = None,
    branch: str | None = None,
    type: CommitType | None = None,
    limit: int = 100,
    svc: CommitService = Depends(get_service),
) -> list[CommitOut]:
    items = await svc.list(
        session_id=session_id, branch=branch, type=type, limit=limit
    )
    return [CommitOut(**c.to_dict()) for c in items]


@router.get("/{commit_id}")
async def get_commit(
    commit_id: str, svc: CommitService = Depends(get_service)
) -> CommitOut:
    c = await svc.get(commit_id)
    if not c:
        raise HTTPException(status_code=404, detail="not found")
    return CommitOut(**c.to_dict())
