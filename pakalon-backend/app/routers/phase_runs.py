"""Phase runs router — REST endpoints for the 6-phase pipeline runs."""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.phase_run import (
    PhaseAbortRequest,
    PhaseCheckpointDecisionRequest,
    PhaseCheckpointRequest,
    PhaseRunCreate,
    PhaseRunListResponse,
    PhaseRunRead,
    PhaseRunUpdate,
)
from app.services import phase_orchestrator as svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/phase-runs", tags=["phase-runs"])


async def _owned_run(
    phase_run_id: str, current_user: User, session: AsyncSession
):
    try:
        run = await svc.get_phase_status(session, phase_run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if run.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PhaseRun not found")
    return run


@router.post(
    "",
    response_model=PhaseRunRead,
    status_code=status.HTTP_201_CREATED,
    summary="Start a new phase run (1-6)",
)
async def create_phase_run(
    body: PhaseRunCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PhaseRunRead:
    run = await svc.start_phase(
        session,
        user_id=current_user.id,
        project_dir=body.project_dir,
        phase_number=body.phase_number,
        session_id=body.session_id,
        is_yolo=body.is_yolo,
    )
    await session.commit()
    return PhaseRunRead.model_validate(run)


@router.get(
    "",
    response_model=PhaseRunListResponse,
    summary="List phase runs (optionally filtered by session_id)",
)
async def list_phase_runs(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    session_id: Annotated[str | None, Query()] = None,
) -> PhaseRunListResponse:
    from sqlalchemy import select

    from app.models.phase_run import PhaseRun

    stmt = select(PhaseRun).where(PhaseRun.user_id == current_user.id)
    if session_id:
        stmt = stmt.where(PhaseRun.session_id == session_id)
    stmt = stmt.order_by(PhaseRun.created_at.desc())
    result = await session.execute(stmt)
    runs = list(result.scalars().all())
    return PhaseRunListResponse(
        runs=[PhaseRunRead.model_validate(r) for r in runs],
        total=len(runs),
    )


@router.get(
    "/{phase_run_id}",
    response_model=PhaseRunRead,
    summary="Get a single phase run",
)
async def get_phase_run(
    phase_run_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PhaseRunRead:
    run = await _owned_run(phase_run_id, current_user, session)
    return PhaseRunRead.model_validate(run)


@router.post(
    "/{phase_run_id}/pause",
    response_model=PhaseRunRead,
    summary="Pause a running phase (HIL checkpoint boundary)",
)
async def pause_phase_run(
    phase_run_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PhaseRunRead:
    await _owned_run(phase_run_id, current_user, session)
    try:
        run = await svc.pause_phase(session, phase_run_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return PhaseRunRead.model_validate(run)


@router.post(
    "/{phase_run_id}/resume",
    response_model=PhaseRunRead,
    summary="Resume a paused phase (carries checkpoint decision if any)",
)
async def resume_phase_run(
    phase_run_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    decision: Annotated[str | None, Query()] = None,
) -> PhaseRunRead:
    await _owned_run(phase_run_id, current_user, session)
    try:
        run = await svc.resume_phase(session, phase_run_id, checkpoint_decision=decision)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return PhaseRunRead.model_validate(run)


@router.post(
    "/{phase_run_id}/abort",
    response_model=PhaseRunRead,
    summary="Abort a phase run",
)
async def abort_phase_run(
    phase_run_id: str,
    body: PhaseAbortRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PhaseRunRead:
    await _owned_run(phase_run_id, current_user, session)
    try:
        run = await svc.abort_phase(session, phase_run_id, reason=body.reason)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return PhaseRunRead.model_validate(run)


@router.post(
    "/{phase_run_id}/checkpoint",
    response_model=PhaseRunRead,
    summary="Create a HIL checkpoint (awaiting approve/reject/modify)",
)
async def create_checkpoint(
    phase_run_id: str,
    body: PhaseCheckpointRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PhaseRunRead:
    await _owned_run(phase_run_id, current_user, session)
    try:
        run = await svc.create_checkpoint(
            session,
            phase_run_id,
            summary=body.summary,
            artifacts=body.artifacts,
            risks=body.risks,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return PhaseRunRead.model_validate(run)


@router.post(
    "/{phase_run_id}/checkpoint/decision",
    response_model=PhaseRunRead,
    summary="Resolve a HIL checkpoint (approve/reject/modify)",
)
async def decide_checkpoint(
    phase_run_id: str,
    body: PhaseCheckpointDecisionRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PhaseRunRead:
    await _owned_run(phase_run_id, current_user, session)
    try:
        run = await svc.complete_checkpoint(
            session, phase_run_id, decision=body.decision
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return PhaseRunRead.model_validate(run)
