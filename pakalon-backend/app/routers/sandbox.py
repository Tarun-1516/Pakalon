"""Sandbox router — container lifecycle and exec endpoints."""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.sandbox import (
    SandboxCreate,
    SandboxExecRequest,
    SandboxExecResponse,
    SandboxListResponse,
    SandboxRead,
    SandboxSnapshotRequest,
    SandboxSnapshotResponse,
)
from app.services import sandbox as svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sandbox", tags=["sandbox"])


async def _owned(sandbox_id: str, current_user: User, session: AsyncSession):
    try:
        sb = await svc.get_sandbox(session, sandbox_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if sb.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sandbox not found")
    return sb


@router.post(
    "/sandboxes",
    response_model=SandboxRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new sandbox (stopped) for a project",
)
async def create_sandbox(
    body: SandboxCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxRead:
    sb = await svc.create_sandbox(
        session,
        user_id=current_user.id,
        project_dir=body.project_dir,
        image=body.image,
        network=body.network,
        sandbox_port=body.sandbox_port,
        app_port=body.app_port,
        cpu_limit=body.cpu_limit,
        memory_limit=body.memory_limit,
        policy_id=body.policy_id,
        session_id=body.session_id,
    )
    await session.commit()
    return SandboxRead.model_validate(sb)


@router.get(
    "/sandboxes",
    response_model=SandboxListResponse,
    summary="List sandboxes (filterable by status, project_dir)",
)
async def list_sandboxes(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    project_dir: Annotated[str | None, Query()] = None,
) -> SandboxListResponse:
    sandboxes = await svc.list_sandboxes(
        session,
        user_id=current_user.id,
        status=status_filter,
        project_dir=project_dir,
    )
    return SandboxListResponse(
        sandboxes=[SandboxRead.model_validate(s) for s in sandboxes],
        total=len(sandboxes),
    )


@router.get(
    "/sandboxes/{sandbox_id}",
    response_model=SandboxRead,
    summary="Get a single sandbox",
)
async def get_sandbox(
    sandbox_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxRead:
    sb = await _owned(sandbox_id, current_user, session)
    return SandboxRead.model_validate(sb)


@router.post(
    "/sandboxes/{sandbox_id}/start",
    response_model=SandboxRead,
    summary="Start the sandbox container",
)
async def start_sandbox(
    sandbox_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxRead:
    await _owned(sandbox_id, current_user, session)
    try:
        sb = await svc.start_sandbox(session, sandbox_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return SandboxRead.model_validate(sb)


@router.post(
    "/sandboxes/{sandbox_id}/stop",
    response_model=SandboxRead,
    summary="Stop the sandbox container",
)
async def stop_sandbox(
    sandbox_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxRead:
    sb = await _owned(sandbox_id, current_user, session)
    updated = await svc.stop_sandbox(session, sb.id)
    await session.commit()
    return SandboxRead.model_validate(updated)


@router.post(
    "/sandboxes/{sandbox_id}/destroy",
    response_model=SandboxRead,
    summary="Tear down the sandbox container",
)
async def destroy_sandbox(
    sandbox_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxRead:
    sb = await _owned(sandbox_id, current_user, session)
    updated = await svc.destroy_sandbox(session, sb.id)
    await session.commit()
    return SandboxRead.model_validate(updated)


@router.post(
    "/sandboxes/{sandbox_id}/exec",
    response_model=SandboxExecResponse,
    summary="Run a command inside the sandbox (stub)",
)
async def exec_in_sandbox(
    sandbox_id: str,
    body: SandboxExecRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxExecResponse:
    await _owned(sandbox_id, current_user, session)
    try:
        result = await svc.exec_in_sandbox(
            session,
            sandbox_id,
            command=body.command,
            working_dir=body.working_dir,
            env=body.env,
            timeout_seconds=body.timeout_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return SandboxExecResponse(**result)


@router.post(
    "/sandboxes/{sandbox_id}/snapshot",
    response_model=SandboxSnapshotResponse,
    summary="Snapshot a running sandbox",
)
async def snapshot_sandbox(
    sandbox_id: str,
    body: SandboxSnapshotRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxSnapshotResponse:
    await _owned(sandbox_id, current_user, session)
    snap = await svc.snapshot_sandbox(session, sandbox_id, label=body.label)
    await session.commit()
    return SandboxSnapshotResponse(**snap)


@router.post(
    "/sandboxes/{sandbox_id}/health-check",
    response_model=SandboxRead,
    summary="Touch the last_health_check_at timestamp",
)
async def health_check(
    sandbox_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> SandboxRead:
    sb = await _owned(sandbox_id, current_user, session)
    updated = await svc.health_check(session, sb.id)
    await session.commit()
    return SandboxRead.model_validate(updated)
