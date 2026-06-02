"""Auditor router — runs the code-quality auditor on a project."""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.auditor_run import (
    AuditorFindingsRequest,
    AuditorRunCancelRequest,
    AuditorRunCreate,
    AuditorRunListResponse,
    AuditorRunRead,
)
from app.services import auditor as svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auditor", tags=["auditor"])


async def _owned(auditor_run_id: str, current_user: User, session: AsyncSession):
    try:
        run = await svc.get_auditor_run(session, auditor_run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if run.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AuditorRun not found")
    return run


@router.post(
    "/runs",
    response_model=AuditorRunRead,
    status_code=status.HTTP_201_CREATED,
    summary="Enqueue a new auditor run (next iteration of project analysis)",
)
async def enqueue_auditor(
    body: AuditorRunCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuditorRunRead:
    try:
        run = await svc.enqueue_auditor(
            session,
            user_id=current_user.id,
            project_dir=body.project_dir,
            phase_number=body.phase_number,
            max_iterations=body.max_iterations,
            is_yolo=body.is_yolo,
            session_id=body.session_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    await session.commit()
    return AuditorRunRead.model_validate(run)


@router.get(
    "/runs",
    response_model=AuditorRunListResponse,
    summary="List auditor runs (filtered by project_dir, status)",
)
async def list_auditor_runs(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    project_dir: Annotated[str | None, Query()] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> AuditorRunListResponse:
    runs = await svc.list_auditor_runs(
        session,
        user_id=current_user.id,
        project_dir=project_dir,
        status=status_filter,
    )
    return AuditorRunListResponse(
        runs=[AuditorRunRead.model_validate(r) for r in runs],
        total=len(runs),
    )


@router.get(
    "/runs/{auditor_run_id}",
    response_model=AuditorRunRead,
    summary="Get a single auditor run",
)
async def get_auditor_run(
    auditor_run_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuditorRunRead:
    run = await _owned(auditor_run_id, current_user, session)
    return AuditorRunRead.model_validate(run)


@router.post(
    "/runs/{auditor_run_id}/start",
    response_model=AuditorRunRead,
    summary="Mark a queued auditor run as running",
)
async def start_auditor(
    auditor_run_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuditorRunRead:
    await _owned(auditor_run_id, current_user, session)
    try:
        run = await svc.start_auditor(session, auditor_run_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return AuditorRunRead.model_validate(run)


@router.post(
    "/runs/{auditor_run_id}/findings",
    response_model=AuditorRunRead,
    summary="Record findings; computes compliance and decides next action",
)
async def record_findings(
    auditor_run_id: str,
    body: AuditorFindingsRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuditorRunRead:
    await _owned(auditor_run_id, current_user, session)
    findings_dicts = [f.model_dump() for f in body.findings]
    try:
        run = await svc.record_findings(
            session,
            auditor_run_id,
            findings=findings_dicts,
            report_path=body.report_path,
            report_summary=body.report_summary,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    await session.commit()
    return AuditorRunRead.model_validate(run)


@router.post(
    "/runs/{auditor_run_id}/cancel",
    response_model=AuditorRunRead,
    summary="Cancel a queued or running auditor run",
)
async def cancel_auditor(
    auditor_run_id: str,
    body: AuditorRunCancelRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AuditorRunRead:
    await _owned(auditor_run_id, current_user, session)
    try:
        run = await svc.cancel_auditor(session, auditor_run_id, reason=body.reason)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return AuditorRunRead.model_validate(run)
