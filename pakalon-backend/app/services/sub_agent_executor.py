"""Sub-agent executor service — tracks the lifecycle of sub-agent runs.

The actual sub-agent execution (LLM calls, file I/O) happens on the CLI;
this service records and queries the run state.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sub_agent_run import SubAgentRun

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


VALID_AGENTS = frozenset(
    {
        "frontend", "backend", "integration", "debug", "feedback",
        "sast", "dast", "code-review", "cicd-review", "best-practices",
    }
)


def _validate_agent(agent_name: str) -> str:
    if agent_name not in VALID_AGENTS:
        raise ValueError(
            f"Unknown sub-agent {agent_name!r}. "
            f"Valid: {sorted(VALID_AGENTS)}"
        )
    return agent_name


async def enqueue_sub_agent(
    session: AsyncSession,
    *,
    user_id: str,
    agent_name: str,
    input_prompt: str = "",
    phase_number: int = 3,
    phase_run_id: str | None = None,
    session_id: str | None = None,
) -> SubAgentRun:
    _validate_agent(agent_name)
    run = SubAgentRun(
        user_id=user_id,
        agent_name=agent_name,
        phase_number=phase_number,
        phase_run_id=phase_run_id,
        session_id=session_id,
        input_prompt=input_prompt,
        status="queued",
        tokens_used=0,
    )
    session.add(run)
    await session.flush()
    logger.info(
        f"[sub_agent_executor] enqueued agent={agent_name} phase={phase_number} "
        f"user_id={user_id} id={run.id}"
    )
    return run


async def start_sub_agent(session: AsyncSession, sub_agent_run_id: str) -> SubAgentRun:
    run = await session.get(SubAgentRun, sub_agent_run_id)
    if run is None:
        raise LookupError(f"SubAgentRun {sub_agent_run_id} not found")
    if run.status not in {"queued", "cancelled"}:
        raise ValueError(f"Cannot start sub-agent in status {run.status!r}")
    run.status = "running"
    run.started_at = _now()
    run.completed_at = None
    run.error_message = None
    await session.flush()
    return run


async def complete_sub_agent(
    session: AsyncSession,
    sub_agent_run_id: str,
    *,
    output_artifact_path: str | None = None,
    output_summary: str | None = None,
    tokens_used: int = 0,
) -> SubAgentRun:
    run = await session.get(SubAgentRun, sub_agent_run_id)
    if run is None:
        raise LookupError(f"SubAgentRun {sub_agent_run_id} not found")
    if run.status != "running":
        raise ValueError(f"Cannot complete sub-agent in status {run.status!r}")
    run.status = "completed"
    run.completed_at = _now()
    run.output_artifact_path = output_artifact_path
    run.output_summary = output_summary
    run.tokens_used = max(0, int(tokens_used))
    await session.flush()
    return run


async def fail_sub_agent(
    session: AsyncSession, sub_agent_run_id: str, *, error_message: str
) -> SubAgentRun:
    run = await session.get(SubAgentRun, sub_agent_run_id)
    if run is None:
        raise LookupError(f"SubAgentRun {sub_agent_run_id} not found")
    run.status = "failed"
    run.completed_at = _now()
    run.error_message = error_message
    await session.flush()
    return run


async def cancel_sub_agent(
    session: AsyncSession, sub_agent_run_id: str, *, reason: str | None = None
) -> SubAgentRun:
    run = await session.get(SubAgentRun, sub_agent_run_id)
    if run is None:
        raise LookupError(f"SubAgentRun {sub_agent_run_id} not found")
    if run.status in {"completed", "failed"}:
        raise ValueError(f"Cannot cancel sub-agent in status {run.status!r}")
    run.status = "cancelled"
    run.completed_at = _now()
    if reason:
        run.error_message = reason
    await session.flush()
    return run


async def get_sub_agent(session: AsyncSession, sub_agent_run_id: str) -> SubAgentRun:
    run = await session.get(SubAgentRun, sub_agent_run_id)
    if run is None:
        raise LookupError(f"SubAgentRun {sub_agent_run_id} not found")
    return run


async def list_sub_agents(
    session: AsyncSession,
    *,
    user_id: str,
    phase_run_id: str | None = None,
    session_id: str | None = None,
    status: str | None = None,
    agent_name: str | None = None,
) -> list[SubAgentRun]:
    stmt = select(SubAgentRun).where(SubAgentRun.user_id == user_id)
    if phase_run_id:
        stmt = stmt.where(SubAgentRun.phase_run_id == phase_run_id)
    if session_id:
        stmt = stmt.where(SubAgentRun.session_id == session_id)
    if status:
        stmt = stmt.where(SubAgentRun.status == status)
    if agent_name:
        stmt = stmt.where(SubAgentRun.agent_name == agent_name)
    stmt = stmt.order_by(SubAgentRun.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())
