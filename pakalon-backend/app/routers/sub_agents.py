"""Sub-agent runs router."""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.sub_agent_run import (
    SubAgentRunCancelRequest,
    SubAgentRunCompleteRequest,
    SubAgentRunCreate,
    SubAgentRunFailRequest,
    SubAgentRunListResponse,
    SubAgentRunRead,
)
from app.services import sub_agent_executor as svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sub-agents", tags=["sub-agents"])


async def _owned(
    sub_agent_run_id: str, current_user: User, session: AsyncSession
):
    try:
        run = await svc.get_sub_agent(session, sub_agent_run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if run.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="SubAgentRun not found")
    return run


@router.post(
    "",
    response_model=SubAgentRunRead,
    status_code=status.HTTP_201_CREATED,
    summary="Enqueue a sub-agent run",
)
async def enqueue_sub_agent(
    body: SubAgentRunCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SubAgentRunRead:
    try:
        run = await svc.enqueue_sub_agent(
            session,
            user_id=current_user.id,
            agent_name=body.agent_name,
            input_prompt=body.input_prompt,
            phase_number=body.phase_number,
            phase_run_id=body.phase_run_id,
            session_id=body.session_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    await session.commit()
    return SubAgentRunRead.model_validate(run)


@router.get(
    "",
    response_model=SubAgentRunListResponse,
    summary="List sub-agent runs (filtered by phase_run_id, session_id, status, agent_name)",
)
async def list_sub_agents(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    phase_run_id: Annotated[str | None, Query()] = None,
    session_id: Annotated[str | None, Query()] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    agent_name: Annotated[str | None, Query()] = None,
) -> SubAgentRunListResponse:
    runs = await svc.list_sub_agents(
        session,
        user_id=current_user.id,
        phase_run_id=phase_run_id,
        session_id=session_id,
        status=status_filter,
        agent_name=agent_name,
    )
    return SubAgentRunListResponse(
        runs=[SubAgentRunRead.model_validate(r) for r in runs],
        total=len(runs),
    )


@router.get(
    "/{sub_agent_run_id}",
    response_model=SubAgentRunRead,
    summary="Get a single sub-agent run",
)
async def get_sub_agent(
    sub_agent_run_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SubAgentRunRead:
    run = await _owned(sub_agent_run_id, current_user, session)
    return SubAgentRunRead.model_validate(run)


@router.post(
    "/{sub_agent_run_id}/start",
    response_model=SubAgentRunRead,
    summary="Mark a queued sub-agent as running",
)
async def start_sub_agent(
    sub_agent_run_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SubAgentRunRead:
    await _owned(sub_agent_run_id, current_user, session)
    try:
        run = await svc.start_sub_agent(session, sub_agent_run_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return SubAgentRunRead.model_validate(run)


@router.post(
    "/{sub_agent_run_id}/complete",
    response_model=SubAgentRunRead,
    summary="Mark a running sub-agent as completed",
)
async def complete_sub_agent(
    sub_agent_run_id: str,
    body: SubAgentRunCompleteRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SubAgentRunRead:
    await _owned(sub_agent_run_id, current_user, session)
    try:
        run = await svc.complete_sub_agent(
            session,
            sub_agent_run_id,
            output_artifact_path=body.output_artifact_path,
            output_summary=body.output_summary,
            tokens_used=body.tokens_used,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return SubAgentRunRead.model_validate(run)


@router.post(
    "/{sub_agent_run_id}/fail",
    response_model=SubAgentRunRead,
    summary="Mark a sub-agent as failed",
)
async def fail_sub_agent(
    sub_agent_run_id: str,
    body: SubAgentRunFailRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SubAgentRunRead:
    await _owned(sub_agent_run_id, current_user, session)
    run = await svc.fail_sub_agent(session, sub_agent_run_id, error_message=body.error_message)
    await session.commit()
    return SubAgentRunRead.model_validate(run)


@router.post(
    "/{sub_agent_run_id}/cancel",
    response_model=SubAgentRunRead,
    summary="Cancel a sub-agent (queued or running)",
)
async def cancel_sub_agent(
    sub_agent_run_id: str,
    body: SubAgentRunCancelRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SubAgentRunRead:
    await _owned(sub_agent_run_id, current_user, session)
    try:
        run = await svc.cancel_sub_agent(session, sub_agent_run_id, reason=body.reason)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return SubAgentRunRead.model_validate(run)
