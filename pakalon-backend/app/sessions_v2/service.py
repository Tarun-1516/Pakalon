"""v2 session service: branches, turns, events."""
from __future__ import annotations

import json
import time
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    V2Session, V2Turn, V2Branch, V2Event,
    V2SessionRow, V2TurnRow, V2BranchRow, V2EventRow,
    V2SessionStatus,
)


class V2SessionService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    @staticmethod
    def _new_id(prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex[:16]}"

    # ---- sessions ----
    async def create(
        self,
        title: str = "",
        *,
        owner: str = "",
        project_id: str = "",
        parent_id: str = "",
    ) -> V2Session:
        sid = self._new_id("sv2")
        now = time.time()
        row = V2SessionRow(
            id=sid, parent_id=parent_id, root_id=sid,
            title=title, status=V2SessionStatus.ACTIVE.value,
            owner=owner, project_id=project_id, created_at=now, updated_at=now,
        )
        self.session.add(row)
        await self.session.commit()
        return V2Session.from_row(row)

    async def get(self, sid: str) -> V2Session | None:
        row = await self.session.get(V2SessionRow, sid)
        return V2Session.from_row(row) if row else None

    async def list(self, owner: str | None = None) -> list[V2Session]:
        stmt = select(V2SessionRow).order_by(V2SessionRow.updated_at.desc())
        if owner:
            stmt = stmt.where(V2SessionRow.owner == owner)
        rows = (await self.session.execute(stmt)).scalars().all()
        return [V2Session.from_row(r) for r in rows]

    async def close(self, sid: str) -> bool:
        row = await self.session.get(V2SessionRow, sid)
        if not row:
            return False
        row.status = V2SessionStatus.CLOSED.value
        row.updated_at = time.time()
        await self.session.commit()
        return True

    # ---- turns ----
    async def add_turn(
        self,
        sid: str,
        role: str,
        content: str,
        *,
        parent_turn_id: str = "",
        model: str = "",
        tool_calls: list[dict] | None = None,
        tool_results: list[dict] | None = None,
        tokens_in: int = 0,
        tokens_out: int = 0,
    ) -> V2Turn:
        tid = self._new_id("trn")
        row = V2TurnRow(
            id=tid, session_id=sid, parent_turn_id=parent_turn_id,
            role=role, content=content,
            tool_calls=json.dumps(tool_calls or []),
            tool_results=json.dumps(tool_results or []),
            model=model, tokens_in=tokens_in, tokens_out=tokens_out,
            created_at=time.time(),
        )
        self.session.add(row)
        # update session head + ts
        s = await self.session.get(V2SessionRow, sid)
        if s:
            s.head_turn_id = tid
            s.updated_at = time.time()
        await self.session.commit()
        return V2Turn.from_row(row)

    async def turns(self, sid: str) -> list[V2Turn]:
        stmt = select(V2TurnRow).where(V2TurnRow.session_id == sid).order_by(V2TurnRow.created_at.asc())
        rows = (await self.session.execute(stmt)).scalars().all()
        return [V2Turn.from_row(r) for r in rows]

    # ---- branches ----
    async def fork(
        self,
        sid: str,
        *,
        fork_turn_id: str,
        name: str = "",
        parent_branch_id: str = "",
    ) -> V2Branch:
        bid = self._new_id("br")
        row = V2BranchRow(
            id=bid, session_id=sid, parent_branch_id=parent_branch_id,
            fork_turn_id=fork_turn_id, name=name or bid,
            head_turn_id=fork_turn_id, created_at=time.time(),
        )
        self.session.add(row)
        await self.session.commit()
        return V2Branch.from_row(row)

    async def branches(self, sid: str) -> list[V2Branch]:
        stmt = select(V2BranchRow).where(V2BranchRow.session_id == sid).order_by(V2BranchRow.created_at.asc())
        rows = (await self.session.execute(stmt)).scalars().all()
        return [V2Branch.from_row(r) for r in rows]

    # ---- events ----
    async def log_event(self, sid: str, kind: str, payload: dict, *, turn_id: str = "") -> V2Event:
        eid = self._new_id("ev")
        row = V2EventRow(
            id=eid, session_id=sid, turn_id=turn_id, kind=kind,
            payload=json.dumps(payload), ts=time.time(),
        )
        self.session.add(row)
        await self.session.commit()
        return V2Event(id=eid, session_id=sid, turn_id=turn_id, kind=kind, payload=payload, ts=row.ts)

    async def events(self, sid: str, *, kind: str | None = None, limit: int = 500) -> list[V2Event]:
        stmt = select(V2EventRow).where(V2EventRow.session_id == sid).order_by(V2EventRow.ts.asc()).limit(limit)
        if kind:
            stmt = stmt.where(V2EventRow.kind == kind)
        rows = (await self.session.execute(stmt)).scalars().all()
        return [
            V2Event(id=r.id, session_id=r.session_id, turn_id=r.turn_id,
                    kind=r.kind, payload=json.loads(r.payload or "{}"), ts=r.ts)
            for r in rows
        ]
