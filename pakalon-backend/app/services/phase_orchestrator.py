"""Phase orchestrator service — manages the lifecycle of 6-phase pipeline runs.

Pure state management. The actual phase execution (LLM calls, file I/O)
happens on the CLI; this service just records and queries the run state.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.phase_run import PhaseRun

logger = logging.getLogger(__name__)


_PHASE_NAMES: dict[int, str] = {
    1: "Planning & Research",
    2: "Wireframes & Design",
    3: "Development",
    4: "Security & QA",
    5: "CI/CD & Deployment",
    6: "Documentation",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _phase_name(number: int) -> str:
    return _PHASE_NAMES.get(number, f"Phase {number}")


async def start_phase(
    session: AsyncSession,
    *,
    user_id: str,
    project_dir: str,
    phase_number: int,
    session_id: str | None = None,
    is_yolo: bool = False,
) -> PhaseRun:
    run = PhaseRun(
        user_id=user_id,
        project_dir=project_dir,
        phase_number=phase_number,
        phase_name=_phase_name(phase_number),
        session_id=session_id,
        is_yolo=is_yolo,
        status="running",
        started_at=_now(),
        artifacts=[],
    )
    session.add(run)
    await session.flush()
    logger.info(
        f"[phase_orchestrator] started phase {phase_number} for user {user_id} "
        f"(run id={run.id}, yolo={is_yolo})"
    )
    return run


async def pause_phase(session: AsyncSession, phase_run_id: str) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    if run.status not in {"running", "checkpoint"}:
        raise ValueError(f"Cannot pause a phase in status {run.status!r}")
    run.status = "paused"
    run.paused_at = _now()
    await session.flush()
    return run


async def resume_phase(
    session: AsyncSession,
    phase_run_id: str,
    *,
    checkpoint_decision: str | None = None,
) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    if run.status not in {"paused", "checkpoint"}:
        raise ValueError(f"Cannot resume a phase in status {run.status!r}")
    if run.status == "checkpoint" and checkpoint_decision is None:
        raise ValueError("resume from checkpoint requires a checkpoint_decision")
    run.status = "running"
    run.paused_at = None
    await session.flush()
    return run


async def abort_phase(
    session: AsyncSession, phase_run_id: str, *, reason: str | None = None
) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    if run.status in {"completed", "aborted", "destroyed"}:
        raise ValueError(f"Cannot abort a phase in status {run.status!r}")
    run.status = "aborted"
    run.completed_at = _now()
    run.error_message = reason
    await session.flush()
    return run


async def get_phase_status(session: AsyncSession, phase_run_id: str) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    return run


async def list_phases_for_session(
    session: AsyncSession, session_id: str
) -> list[PhaseRun]:
    stmt = (
        select(PhaseRun)
        .where(PhaseRun.session_id == session_id)
        .order_by(PhaseRun.phase_number.asc(), PhaseRun.created_at.asc())
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def create_checkpoint(
    session: AsyncSession,
    phase_run_id: str,
    *,
    summary: str,
    artifacts: list[str],
    risks: list[str],
) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    if run.status not in {"running", "paused"}:
        raise ValueError(f"Cannot checkpoint a phase in status {run.status!r}")
    run.status = "checkpoint"
    run.checkpoint_data = {
        "summary": summary,
        "artifacts": list(artifacts),
        "risks": list(risks),
        "created_at": _now().isoformat(),
    }
    if artifacts:
        run.artifacts = sorted(set([*run.artifacts, *artifacts]))
    await session.flush()
    return run


async def complete_checkpoint(
    session: AsyncSession, phase_run_id: str, *, decision: str
) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    if run.status != "checkpoint":
        raise ValueError(f"Phase {phase_run_id} is not awaiting a checkpoint (status={run.status!r})")
    if run.checkpoint_data is None:
        run.checkpoint_data = {}
    run.checkpoint_data = {**run.checkpoint_data, "decision": decision, "decided_at": _now().isoformat()}

    if decision == "approve":
        run.status = "running"
    elif decision == "reject":
        run.status = "aborted"
        run.completed_at = _now()
        run.error_message = "rejected at checkpoint"
    elif decision == "modify":
        run.status = "running"
    else:
        raise ValueError(f"Unknown checkpoint decision {decision!r}")
    await session.flush()
    return run


async def complete_phase(
    session: AsyncSession, phase_run_id: str, *, artifacts: list[str] | None = None
) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    run.status = "completed"
    run.completed_at = _now()
    if artifacts:
        run.artifacts = sorted(set([*run.artifacts, *artifacts]))
    await session.flush()
    return run


async def fail_phase(
    session: AsyncSession, phase_run_id: str, *, error: str
) -> PhaseRun:
    run = await session.get(PhaseRun, phase_run_id)
    if run is None:
        raise LookupError(f"PhaseRun {phase_run_id} not found")
    run.status = "failed"
    run.completed_at = _now()
    run.error_message = error
    await session.flush()
    return run
