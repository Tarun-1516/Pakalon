"""Penpot service — manages wireframe-container lifecycle and sync."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.penpot_session import DEFAULT_PENPOT_PORT, PenpotSession

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def start_penpot(
    session: AsyncSession,
    *,
    user_id: str,
    project_dir: str,
    session_id: str | None = None,
    port: int = DEFAULT_PENPOT_PORT,
) -> PenpotSession:
    """Spin up a Penpot container (stub).

    Real implementation lives in the CLI (Docker exec); backend stores
    the container handle and credentials.
    """
    existing = await session.execute(
        select(PenpotSession)
        .where(
            PenpotSession.user_id == user_id,
            PenpotSession.project_dir == project_dir,
            PenpotSession.status.in_(["starting", "running", "syncing"]),
        )
        .order_by(PenpotSession.created_at.desc())
        .limit(1)
    )
    last: PenpotSession | None = existing.scalar_one_or_none()
    if last is not None:
        last.status = "stopped"
        last.stopped_at = _now()
        await session.flush()

    container_id = f"stub-penpot-{uuid.uuid4().hex[:12]}"
    penpot_url = f"http://localhost:{port}"
    token = uuid.uuid4().hex + uuid.uuid4().hex
    penpot = PenpotSession(
        user_id=user_id,
        session_id=session_id,
        project_dir=project_dir,
        container_id=container_id,
        port=port,
        status="running",
        penpot_url=penpot_url,
        token=token,
        started_at=_now(),
    )
    session.add(penpot)
    await session.flush()
    logger.info(
        f"[penpot] started container={container_id} port={port} "
        f"project={project_dir} user_id={user_id}"
    )
    return penpot


async def get_penpot_session(
    session: AsyncSession, penpot_session_id: str
) -> PenpotSession:
    penpot = await session.get(PenpotSession, penpot_session_id)
    if penpot is None:
        raise LookupError(f"PenpotSession {penpot_session_id} not found")
    return penpot


async def get_penpot_session_for_project(
    session: AsyncSession, *, user_id: str, project_dir: str
) -> PenpotSession | None:
    result = await session.execute(
        select(PenpotSession)
        .where(
            PenpotSession.user_id == user_id,
            PenpotSession.project_dir == project_dir,
        )
        .order_by(PenpotSession.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def sync_changes(
    session: AsyncSession,
    penpot_session_id: str,
    *,
    events: list[dict],
    cooldown_seconds: int = 2,
) -> PenpotSession:
    penpot = await session.get(PenpotSession, penpot_session_id)
    if penpot is None:
        raise LookupError(f"PenpotSession {penpot_session_id} not found")
    if penpot.status not in {"running", "syncing"}:
        raise ValueError(f"Cannot sync in status {penpot.status!r}")

    now = _now()
    if penpot.cooldown_until and penpot.cooldown_until > now:
        raise ValueError(
            f"Penpot is in cooldown until {penpot.cooldown_until.isoformat()}"
        )

    penpot.status = "syncing"
    penpot.last_sync_at = now
    penpot.sync_changes = penpot.sync_changes + len(events)
    penpot.cooldown_until = now + timedelta(seconds=cooldown_seconds)
    penpot.status = "running"
    await session.flush()
    logger.info(
        f"[penpot] sync session={penpot_session_id} "
        f"events={len(events)} cooldown={cooldown_seconds}s"
    )
    return penpot


async def stop_penpot(
    session: AsyncSession, penpot_session_id: str, *, reason: str | None = None
) -> PenpotSession:
    penpot = await session.get(PenpotSession, penpot_session_id)
    if penpot is None:
        raise LookupError(f"PenpotSession {penpot_session_id} not found")
    if penpot.status == "stopped":
        return penpot
    penpot.status = "stopped"
    penpot.stopped_at = _now()
    if reason:
        penpot.error_message = reason
    await session.flush()
    return penpot


async def list_penpot_sessions(
    session: AsyncSession, *, user_id: str, status: str | None = None
) -> list[PenpotSession]:
    stmt = select(PenpotSession).where(PenpotSession.user_id == user_id)
    if status:
        stmt = stmt.where(PenpotSession.status == status)
    stmt = stmt.order_by(PenpotSession.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())
