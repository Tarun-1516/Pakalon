"""Goals service."""
from __future__ import annotations

import time
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Goal, GoalRow, GoalStatus


class GoalsService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    @staticmethod
    def _new_id() -> str:
        return f"goal_{uuid.uuid4().hex[:16]}"

    async def create(
        self,
        title: str,
        description: str = "",
        *,
        parent_id: str = "",
        session_id: str = "",
        priority: int = 0,
        tags: list[str] | None = None,
    ) -> Goal:
        now = time.time()
        row = GoalRow(
            id=self._new_id(),
            parent_id=parent_id,
            session_id=session_id,
            title=title,
            description=description,
            status=GoalStatus.PENDING.value,
            priority=priority,
            tags=_json(tags or []),
            created_at=now,
            updated_at=now,
        )
        self.session.add(row)
        await self.session.commit()
        return Goal.from_row(row)

    async def get(self, goal_id: str) -> Goal | None:
        row = await self.session.get(GoalRow, goal_id)
        return Goal.from_row(row) if row else None

    async def list(
        self,
        session_id: str | None = None,
        status: GoalStatus | None = None,
        parent_id: str | None = None,
    ) -> list[Goal]:
        stmt = select(GoalRow).order_by(GoalRow.priority.desc(), GoalRow.created_at.desc())
        if session_id:
            stmt = stmt.where(GoalRow.session_id == session_id)
        if status:
            stmt = stmt.where(GoalRow.status == status.value)
        if parent_id is not None:
            stmt = stmt.where(GoalRow.parent_id == parent_id)
        rows = (await self.session.execute(stmt)).scalars().all()
        return [Goal.from_row(r) for r in rows]

    async def update(
        self,
        goal_id: str,
        *,
        status: GoalStatus | None = None,
        progress: float | None = None,
        priority: int | None = None,
        add_blocker: str | None = None,
        remove_blocker: str | None = None,
    ) -> Goal | None:
        row = await self.session.get(GoalRow, goal_id)
        if not row:
            return None
        now = time.time()
        if status is not None:
            row.status = status.value
            if status == GoalStatus.DONE:
                row.progress = 1.0
                row.completed_at = now
        if progress is not None:
            row.progress = max(0.0, min(1.0, progress))
            if row.progress >= 1.0 and row.status != GoalStatus.DONE.value:
                row.status = GoalStatus.DONE.value
                row.completed_at = now
        if priority is not None:
            row.priority = priority
        if add_blocker:
            bl = _loads(row.blocked_by)
            if add_blocker not in bl:
                bl.append(add_blocker)
            row.blocked_by = _json(bl)
        if remove_blocker:
            bl = _loads(row.blocked_by)
            bl = [b for b in bl if b != remove_blocker]
            row.blocked_by = _json(bl)
        row.updated_at = now
        await self.session.commit()
        return Goal.from_row(row)

    async def children(self, parent_id: str) -> list[Goal]:
        return await self.list(parent_id=parent_id)

    async def ready(self, session_id: str | None = None) -> list[Goal]:
        """Goals whose blockers are all done (or none)."""
        all_active = await self.list(session_id=session_id)
        done_ids = {g.id for g in all_active if g.status == GoalStatus.DONE}
        out: list[Goal] = []
        for g in all_active:
            if g.status not in (GoalStatus.PENDING, GoalStatus.ACTIVE):
                continue
            if all(b in done_ids for b in g.blocked_by):
                out.append(g)
        return out


def _json(x: Any) -> str:
    import json
    return json.dumps(x)


def _loads(x: str) -> Any:
    import json
    return json.loads(x or "[]")
