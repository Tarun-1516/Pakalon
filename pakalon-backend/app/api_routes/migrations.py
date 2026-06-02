"""Database table auto-creation for new feature packages.

Imports every new ORM model and runs Base.metadata.create_all() against
the configured engine. Safe to call repeatedly: SQLAlchemy skips tables
that already exist.
"""
from __future__ import annotations

import logging

from app.database import Base, engine

logger = logging.getLogger(__name__)


# Importing these modules registers their ORM models on Base.metadata
_MODELS_TO_IMPORT = [
    "app.mnemopi.bank",
    "app.hindsight.bank",
    "app.hindsight.mental_models",
    "app.hindsight.transcript",
    "app.hindsight.state",
    "app.goals.models",
    "app.commit.models",
    "app.sessions_v2.models",
    "app.snapshots.service",
    "app.patches.service",
    "app.shares.service",
    "app.projects.service",
    "app.tiny.service",
    # 6-phase orchestration (comparison.md Module 1)
    "app.models.phase_run",
    # Sub-agent execution (comparison.md Module 2)
    "app.models.sub_agent_run",
    # Auditor agent (comparison.md Module 3)
    "app.models.auditor_run",
    # Penpot wireframe sync (comparison.md Module 4)
    "app.models.penpot_session",
    # Telegram + Supabase bridge (comparison.md Module 5)
    "app.models.bridge_connection",
    # Sandbox lifecycle (comparison.md Module 6)
    "app.models.sandbox",
]


def ensure_all_tables() -> None:
    """Create all tables for the new feature packages (idempotent)."""
    for mod in _MODELS_TO_IMPORT:
        try:
            __import__(mod)
        except Exception as e:
            logger.warning("Skipped %s: %s", mod, e)

    try:
        import asyncio
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_create_all())
        finally:
            loop.close()
    except Exception as e:
        logger.warning("ensure_all_tables failed: %s", e)


async def _create_all() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
