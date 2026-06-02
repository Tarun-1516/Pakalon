"""Auditor service — computes compliance and triggers remediation."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auditor_run import AuditorRun

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _compute_counts_and_compliance(
    findings: list[dict[str, Any]],
) -> tuple[int, int, int, int, float]:
    """Returns (missing, partial, implemented, total, compliance_pct)."""
    missing = sum(1 for f in findings if f.get("status") == "missing")
    partial = sum(1 for f in findings if f.get("status") == "partial")
    impl = sum(1 for f in findings if f.get("status") == "implemented")
    total = missing + partial + impl
    if total == 0:
        return 0, 0, 0, 0, 0.0
    # Implemented = 1.0, partial = 0.5, missing = 0
    score = impl + 0.5 * partial
    pct = round((score / total) * 100, 2)
    return missing, partial, impl, total, pct


async def enqueue_auditor(
    session: AsyncSession,
    *,
    user_id: str,
    project_dir: str,
    phase_number: int = 3,
    max_iterations: int = 10,
    is_yolo: bool = False,
    session_id: str | None = None,
) -> AuditorRun:
    """Create the first iteration of an auditor run."""
    if max_iterations < 1:
        raise ValueError("max_iterations must be >= 1")
    if is_yolo and max_iterations < 10:
        max_iterations = 10
        logger.info("[auditor] yolo mode raised max_iterations to 10")

    existing = await session.execute(
        select(AuditorRun)
        .where(
            AuditorRun.user_id == user_id,
            AuditorRun.project_dir == project_dir,
            AuditorRun.status.in_(["queued", "running", "analyzing"]),
        )
        .order_by(AuditorRun.created_at.desc())
        .limit(1)
    )
    last: AuditorRun | None = existing.scalar_one_or_none()
    iteration = (last.iteration + 1) if last else 1

    run = AuditorRun(
        user_id=user_id,
        session_id=session_id,
        project_dir=project_dir,
        phase_number=phase_number,
        iteration=iteration,
        max_iterations=max_iterations,
        is_yolo=is_yolo,
        status="queued",
    )
    session.add(run)
    await session.flush()
    logger.info(
        f"[auditor] enqueued iter={iteration}/{max_iterations} project={project_dir} "
        f"user_id={user_id} id={run.id}"
    )
    return run


async def start_auditor(session: AsyncSession, auditor_run_id: str) -> AuditorRun:
    run = await session.get(AuditorRun, auditor_run_id)
    if run is None:
        raise LookupError(f"AuditorRun {auditor_run_id} not found")
    if run.status not in {"queued", "cancelled"}:
        raise ValueError(f"Cannot start auditor in status {run.status!r}")
    run.status = "running"
    run.started_at = _now()
    run.completed_at = None
    run.error_message = None
    await session.flush()
    return run


async def record_findings(
    session: AsyncSession,
    auditor_run_id: str,
    *,
    findings: list[dict[str, Any]],
    report_path: str | None = None,
    report_summary: str | None = None,
) -> AuditorRun:
    """Record findings, compute counts/compliance, and decide next action."""
    run = await session.get(AuditorRun, auditor_run_id)
    if run is None:
        raise LookupError(f"AuditorRun {auditor_run_id} not found")
    if run.status != "running":
        raise ValueError(f"Cannot record findings in status {run.status!r}")
    if not findings:
        raise ValueError("findings list must not be empty")

    missing, partial, impl, total, pct = _compute_counts_and_compliance(findings)
    run.findings = findings
    run.missing_count = missing
    run.partial_count = partial
    run.implemented_count = impl
    run.total_count = total
    run.compliance_pct = pct
    run.report_path = report_path
    run.report_summary = report_summary

    if pct >= 100.0 or run.iteration >= run.max_iterations:
        run.status = "completed"
        run.completed_at = _now()
        run.trigger_remediation = False
    else:
        run.status = "completed"
        run.completed_at = _now()
        run.trigger_remediation = True

    await session.flush()
    logger.info(
        f"[auditor] record_findings id={auditor_run_id} "
        f"missing={missing} partial={partial} implemented={impl} pct={pct}%"
    )
    return run


async def cancel_auditor(
    session: AsyncSession, auditor_run_id: str, *, reason: str | None = None
) -> AuditorRun:
    run = await session.get(AuditorRun, auditor_run_id)
    if run is None:
        raise LookupError(f"AuditorRun {auditor_run_id} not found")
    if run.status in {"completed", "failed"}:
        raise ValueError(f"Cannot cancel auditor in status {run.status!r}")
    run.status = "cancelled"
    run.completed_at = _now()
    if reason:
        run.error_message = reason
    await session.flush()
    return run


async def fail_auditor(
    session: AsyncSession, auditor_run_id: str, *, error_message: str
) -> AuditorRun:
    run = await session.get(AuditorRun, auditor_run_id)
    if run is None:
        raise LookupError(f"AuditorRun {auditor_run_id} not found")
    run.status = "failed"
    run.completed_at = _now()
    run.error_message = error_message
    await session.flush()
    return run


async def get_auditor_run(session: AsyncSession, auditor_run_id: str) -> AuditorRun:
    run = await session.get(AuditorRun, auditor_run_id)
    if run is None:
        raise LookupError(f"AuditorRun {auditor_run_id} not found")
    return run


async def list_auditor_runs(
    session: AsyncSession,
    *,
    user_id: str,
    project_dir: str | None = None,
    status: str | None = None,
) -> list[AuditorRun]:
    stmt = select(AuditorRun).where(AuditorRun.user_id == user_id)
    if project_dir:
        stmt = stmt.where(AuditorRun.project_dir == project_dir)
    if status:
        stmt = stmt.where(AuditorRun.status == status)
    stmt = stmt.order_by(AuditorRun.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())
