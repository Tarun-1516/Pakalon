"""Commit service."""
from __future__ import annotations

import hashlib
import time
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Commit, CommitRow, CommitType


class CommitService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(
        self,
        subject: str,
        *,
        type: CommitType = CommitType.FEAT,
        scope: str = "",
        body: str = "",
        footer: str = "",
        files: list[str] | None = None,
        breaking: bool = False,
        session_id: str = "",
        branch: str = "",
    ) -> Commit:
        cid = f"cmt_{uuid.uuid4().hex[:16]}"
        sha = _fake_sha(subject, body, cid)
        row = CommitRow(
            id=cid,
            session_id=session_id,
            branch=branch,
            type=type.value,
            scope=scope,
            subject=subject,
            body=body,
            footer=footer,
            files=_json(files or []),
            breaking="true" if breaking else "false",
            sha=sha,
            created_at=time.time(),
        )
        self.session.add(row)
        await self.session.commit()
        return Commit.from_row(row)

    async def list(
        self,
        session_id: str | None = None,
        branch: str | None = None,
        type: CommitType | None = None,
        limit: int = 100,
    ) -> list[Commit]:
        stmt = select(CommitRow).order_by(CommitRow.created_at.desc()).limit(limit)
        if session_id:
            stmt = stmt.where(CommitRow.session_id == session_id)
        if branch:
            stmt = stmt.where(CommitRow.branch == branch)
        if type:
            stmt = stmt.where(CommitRow.type == type.value)
        rows = (await self.session.execute(stmt)).scalars().all()
        return [Commit.from_row(r) for r in rows]

    async def get(self, commit_id: str) -> Commit | None:
        row = await self.session.get(CommitRow, commit_id)
        return Commit.from_row(row) if row else None


def _json(x: Any) -> str:
    import json
    return json.dumps(x)


def _fake_sha(*parts: str) -> str:
    h = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()
    return h[:40]
