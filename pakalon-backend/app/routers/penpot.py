"""Penpot router — wireframe container and sync API."""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.penpot import (
    PenpotSessionCreate,
    PenpotSessionListResponse,
    PenpotSessionRead,
    PenpotSyncRequest,
    PenpotSyncResponse,
)
from app.services import penpot as svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/penpot", tags=["penpot"])


async def _owned(penpot_session_id: str, current_user: User, session: AsyncSession):
    try:
        penpot = await svc.get_penpot_session(session, penpot_session_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if penpot.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PenpotSession not found")
    return penpot


@router.post(
    "/sessions",
    response_model=PenpotSessionRead,
    status_code=status.HTTP_201_CREATED,
    summary="Start a new Penpot container for a project",
)
async def start_penpot(
    body: PenpotSessionCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PenpotSessionRead:
    penpot = await svc.start_penpot(
        session,
        user_id=current_user.id,
        project_dir=body.project_dir,
        session_id=body.session_id,
        port=body.port,
    )
    await session.commit()
    return PenpotSessionRead.model_validate(penpot)


@router.get(
    "/sessions",
    response_model=PenpotSessionListResponse,
    summary="List Penpot sessions (filterable by status)",
)
async def list_penpot_sessions(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> PenpotSessionListResponse:
    sessions = await svc.list_penpot_sessions(
        session, user_id=current_user.id, status=status_filter
    )
    return PenpotSessionListResponse(
        sessions=[PenpotSessionRead.model_validate(s) for s in sessions],
        total=len(sessions),
    )


@router.get(
    "/sessions/{penpot_session_id}",
    response_model=PenpotSessionRead,
    summary="Get a single Penpot session",
)
async def get_penpot_session(
    penpot_session_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PenpotSessionRead:
    penpot = await _owned(penpot_session_id, current_user, session)
    return PenpotSessionRead.model_validate(penpot)


@router.post(
    "/sessions/{penpot_session_id}/sync",
    response_model=PenpotSyncResponse,
    summary="Push wireframe sync events (with cooldown enforcement)",
)
async def sync_changes(
    penpot_session_id: str,
    body: PenpotSyncRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PenpotSyncResponse:
    penpot = await _owned(penpot_session_id, current_user, session)
    events = [e.model_dump() for e in body.events]
    try:
        updated = await svc.sync_changes(
            session,
            penpot.id,
            events=events,
            cooldown_seconds=body.cooldown_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return PenpotSyncResponse(
        accepted=len(events),
        cooldown_until=updated.cooldown_until,
        sync_changes=updated.sync_changes,
    )


@router.post(
    "/sessions/{penpot_session_id}/stop",
    response_model=PenpotSessionRead,
    summary="Stop the Penpot container for a session",
)
async def stop_penpot(
    penpot_session_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PenpotSessionRead:
    penpot = await _owned(penpot_session_id, current_user, session)
    updated = await svc.stop_penpot(session, penpot.id)
    await session.commit()
    return PenpotSessionRead.model_validate(updated)
