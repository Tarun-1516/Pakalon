"""Sandbox service — manages per-project sandbox container lifecycle."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from time import perf_counter

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sandbox import (
    DEFAULT_APP_PORT,
    DEFAULT_CPU_LIMIT,
    DEFAULT_MEMORY_LIMIT,
    DEFAULT_SANDBOX_IMAGE,
    DEFAULT_SANDBOX_NETWORK,
    DEFAULT_SANDBOX_PORT,
    Sandbox,
)

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def create_sandbox(
    session: AsyncSession,
    *,
    user_id: str,
    project_dir: str,
    image: str = DEFAULT_SANDBOX_IMAGE,
    network: str = DEFAULT_SANDBOX_NETWORK,
    sandbox_port: int = DEFAULT_SANDBOX_PORT,
    app_port: int = DEFAULT_APP_PORT,
    cpu_limit: str = DEFAULT_CPU_LIMIT,
    memory_limit: str = DEFAULT_MEMORY_LIMIT,
    policy_id: str | None = None,
    session_id: str | None = None,
) -> Sandbox:
    sb = Sandbox(
        user_id=user_id,
        session_id=session_id,
        project_dir=project_dir,
        image=image,
        network=network,
        sandbox_port=sandbox_port,
        app_port=app_port,
        cpu_limit=cpu_limit,
        memory_limit=memory_limit,
        policy_id=policy_id,
        status="stopped",
    )
    session.add(sb)
    await session.flush()
    logger.info(
        f"[sandbox] created id={sb.id} project={project_dir} user_id={user_id}"
    )
    return sb


async def start_sandbox(session: AsyncSession, sandbox_id: str) -> Sandbox:
    sb = await session.get(Sandbox, sandbox_id)
    if sb is None:
        raise LookupError(f"Sandbox {sandbox_id} not found")
    if sb.status in {"running", "starting", "executing"}:
        raise ValueError(f"Cannot start sandbox in status {sb.status!r}")
    sb.container_id = f"sbx-{uuid.uuid4().hex[:12]}"
    sb.status = "running"
    sb.started_at = _now()
    sb.stopped_at = None
    sb.error_message = None
    sb.last_health_check_at = _now()
    await session.flush()
    return sb


async def stop_sandbox(
    session: AsyncSession, sandbox_id: str, *, reason: str | None = None
) -> Sandbox:
    sb = await session.get(Sandbox, sandbox_id)
    if sb is None:
        raise LookupError(f"Sandbox {sandbox_id} not found")
    if sb.status == "stopped":
        return sb
    sb.status = "stopped"
    sb.stopped_at = _now()
    if reason:
        sb.error_message = reason
    await session.flush()
    return sb


async def destroy_sandbox(session: AsyncSession, sandbox_id: str) -> Sandbox:
    sb = await session.get(Sandbox, sandbox_id)
    if sb is None:
        raise LookupError(f"Sandbox {sandbox_id} not found")
    sb.status = "stopped"
    sb.stopped_at = _now()
    sb.container_id = None
    await session.flush()
    logger.info(f"[sandbox] destroyed id={sandbox_id}")
    return sb


async def health_check(session: AsyncSession, sandbox_id: str) -> Sandbox:
    sb = await session.get(Sandbox, sandbox_id)
    if sb is None:
        raise LookupError(f"Sandbox {sandbox_id} not found")
    sb.last_health_check_at = _now()
    await session.flush()
    return sb


async def exec_in_sandbox(
    session: AsyncSession,
    sandbox_id: str,
    *,
    command: str,
    working_dir: str | None = None,
    env: dict[str, str] | None = None,
    timeout_seconds: int = 60,
) -> dict:
    """Stub exec — real Docker exec happens on the CLI.

    Returns a dict with exit_code, stdout, stderr, duration_ms. The stub
    always reports success (exit_code=0) and a placeholder message.
    """
    sb = await session.get(Sandbox, sandbox_id)
    if sb is None:
        raise LookupError(f"Sandbox {sandbox_id} not found")
    if sb.status not in {"running", "executing"}:
        raise ValueError(f"Cannot exec in sandbox with status {sb.status!r}")

    started = perf_counter()
    sb.status = "executing"
    await session.flush()

    duration_ms = int((perf_counter() - started) * 1000) + 5  # at least 5ms

    sb.status = "running"
    sb.last_health_check_at = _now()
    await session.flush()

    return {
        "exit_code": 0,
        "stdout": f"[stub] exec in {sb.container_id} succeeded",
        "stderr": "",
        "duration_ms": duration_ms,
    }


async def snapshot_sandbox(
    session: AsyncSession, sandbox_id: str, *, label: str = ""
) -> dict:
    sb = await session.get(Sandbox, sandbox_id)
    if sb is None:
        raise LookupError(f"Sandbox {sandbox_id} not found")
    snapshot_id = f"snap-{uuid.uuid4().hex[:12]}"
    logger.info(
        f"[sandbox] snapshot id={snapshot_id} sandbox={sandbox_id} label={label!r}"
    )
    return {
        "snapshot_id": snapshot_id,
        "sandbox_id": sb.id,
        "label": label,
        "created_at": _now(),
    }


async def get_sandbox(session: AsyncSession, sandbox_id: str) -> Sandbox:
    sb = await session.get(Sandbox, sandbox_id)
    if sb is None:
        raise LookupError(f"Sandbox {sandbox_id} not found")
    return sb


async def list_sandboxes(
    session: AsyncSession,
    *,
    user_id: str,
    status: str | None = None,
    project_dir: str | None = None,
) -> list[Sandbox]:
    stmt = select(Sandbox).where(Sandbox.user_id == user_id)
    if status:
        stmt = stmt.where(Sandbox.status == status)
    if project_dir:
        stmt = stmt.where(Sandbox.project_dir == project_dir)
    stmt = stmt.order_by(Sandbox.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())
