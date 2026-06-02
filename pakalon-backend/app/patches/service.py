"""Patch service: unified diff + JSON Patch (RFC 6902)."""
from __future__ import annotations

import difflib
import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from sqlalchemy import String, Text, Float
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PatchOp(str, Enum):
    ADD = "add"
    REMOVE = "remove"
    REPLACE = "replace"
    MOVE = "move"
    COPY = "copy"
    TEST = "test"


class PatchRow(Base):
    __tablename__ = "patches"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    file: Mapped[str] = mapped_column(String(1024), default="")
    unified_diff: Mapped[str] = mapped_column(Text, default="")
    json_patch: Mapped[str] = mapped_column(Text, default="[]")
    author: Mapped[str] = mapped_column(String(64), default="")
    summary: Mapped[str] = mapped_column(String(512), default="")
    sha256: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class Patch:
    id: str
    session_id: str
    file: str
    unified_diff: str
    json_patch: list[dict]
    author: str
    summary: str
    sha256: str
    created_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "session_id": self.session_id, "file": self.file,
            "unified_diff": self.unified_diff, "json_patch": self.json_patch,
            "author": self.author, "summary": self.summary,
            "sha256": self.sha256, "created_at": self.created_at,
        }


class PatchService:
    def _new_id(self) -> str:
        return f"pat_{uuid.uuid4().hex[:16]}"

    def make_unified_diff(self, before: str, after: str, *, path: str) -> str:
        from_lines = before.splitlines(keepends=True) or [""]
        to_lines = after.splitlines(keepends=True) or [""]
        diff = difflib.unified_diff(
            from_lines, to_lines,
            fromfile=f"a/{path}", tofile=f"b/{path}",
        )
        return "".join(diff)

    def make_json_patch(self, before: dict, after: dict) -> list[dict]:
        """Compute a minimal JSON Patch (add/remove/replace) for object diffs."""
        ops: list[dict] = []
        self._diff_obj(before, after, path="", ops=ops)
        return ops

    def _diff_obj(self, a, b, path: str, ops: list[dict]) -> None:
        if isinstance(a, dict) and isinstance(b, dict):
            keys = set(a) | set(b)
            for k in keys:
                sub = f"{path}/{k}" if path else f"/{k}"
                if k not in a:
                    ops.append({"op": "add", "path": sub, "value": b[k]})
                elif k not in b:
                    ops.append({"op": "remove", "path": sub})
                else:
                    self._diff_obj(a[k], b[k], sub, ops)
        elif a != b:
            if a is None and path:
                ops.append({"op": "add", "path": path, "value": b})
            elif b is None and path:
                ops.append({"op": "remove", "path": path})
            else:
                ops.append({"op": "replace", "path": path, "value": b})

    async def create(
        self,
        file: str,
        *,
        before: str | None = None,
        after: str | None = None,
        json_before: dict | None = None,
        json_after: dict | None = None,
        author: str = "",
        session_id: str = "",
        summary: str = "",
    ) -> Patch:
        from app.database import SessionLocal
        unified = self.make_unified_diff(before or "", after or "", path=file) if before is not None or after is not None else ""
        jpatch = self.make_json_patch(json_before or {}, json_after or {}) if json_before is not None or json_after is not None else []
        pid = self._new_id()
        body = json.dumps({"unified": unified, "json": jpatch, "file": file}, sort_keys=True).encode("utf-8")
        digest = hashlib.sha256(body).hexdigest()
        row = PatchRow(
            id=pid, session_id=session_id, file=file,
            unified_diff=unified, json_patch=json.dumps(jpatch),
            author=author, summary=summary, sha256=digest,
            created_at=time.time(),
        )
        async with SessionLocal() as s:
            s.add(row)
            await s.commit()
        return Patch(
            id=pid, session_id=session_id, file=file, unified_diff=unified,
            json_patch=jpatch, author=author, summary=summary,
            sha256=digest, created_at=row.created_at,
        )

    async def list(self, session_id: str | None = None, file: str | None = None, limit: int = 100) -> list[Patch]:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            stmt = select(PatchRow).order_by(PatchRow.created_at.desc()).limit(limit)
            if session_id:
                stmt = stmt.where(PatchRow.session_id == session_id)
            if file:
                stmt = stmt.where(PatchRow.file == file)
            rows = (await s.execute(stmt)).scalars().all()
        return [
            Patch(
                id=r.id, session_id=r.session_id, file=r.file,
                unified_diff=r.unified_diff, json_patch=json.loads(r.json_patch or "[]"),
                author=r.author, summary=r.summary, sha256=r.sha256, created_at=r.created_at,
            )
            for r in rows
        ]

    async def get(self, patch_id: str) -> Patch | None:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            r = await s.get(PatchRow, patch_id)
        if not r:
            return None
        return Patch(
            id=r.id, session_id=r.session_id, file=r.file,
            unified_diff=r.unified_diff, json_patch=json.loads(r.json_patch or "[]"),
            author=r.author, summary=r.summary, sha256=r.sha256, created_at=r.created_at,
        )

    def apply_unified(self, before: str, unified: str) -> str:
        # Naive apply: if the diff is a pure addition of `+` lines we accept.
        out: list[str] = []
        for line in unified.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                continue
            if line.startswith("@@"):
                continue
            if line.startswith("+"):
                out.append(line[1:])
            elif line.startswith("-"):
                continue
            else:
                out.append(line[1:] if line.startswith(" ") else line)
        return "\n".join(out)
