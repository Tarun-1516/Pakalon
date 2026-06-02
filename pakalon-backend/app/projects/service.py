"""Project service."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import String, Text, Float
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ProjectRow(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    root: Mapped[str] = mapped_column(String(1024), default="")
    owner: Mapped[str] = mapped_column(String(64), default="")
    tags: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    updated_at: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class Project:
    id: str
    name: str
    description: str
    root: str
    owner: str
    tags: list[str] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "description": self.description,
            "root": self.root, "owner": self.owner, "tags": self.tags,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, r: ProjectRow) -> "Project":
        import json
        return cls(
            id=r.id, name=r.name, description=r.description,
            root=r.root, owner=r.owner, tags=json.loads(r.tags or "[]"),
            created_at=r.created_at, updated_at=r.updated_at,
        )


class ProjectService:
    def _new_id(self) -> str:
        return f"prj_{uuid.uuid4().hex[:16]}"

    async def create(
        self,
        name: str,
        *,
        description: str = "",
        root: str = "",
        owner: str = "",
        tags: list[str] | None = None,
    ) -> Project:
        from app.database import SessionLocal
        import json
        pid = self._new_id()
        now = time.time()
        row = ProjectRow(
            id=pid, name=name, description=description, root=root,
            owner=owner, tags=json.dumps(tags or []),
            created_at=now, updated_at=now,
        )
        async with SessionLocal() as s:
            s.add(row)
            await s.commit()
        return Project.from_row(row)

    async def get(self, pid: str) -> Project | None:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            r = await s.get(ProjectRow, pid)
        return Project.from_row(r) if r else None

    async def get_by_name(self, name: str) -> Project | None:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            r = (await s.execute(select(ProjectRow).where(ProjectRow.name == name))).scalars().first()
        return Project.from_row(r) if r else None

    async def list(self, owner: str | None = None) -> list[Project]:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            stmt = select(ProjectRow).order_by(ProjectRow.updated_at.desc())
            if owner:
                stmt = stmt.where(ProjectRow.owner == owner)
            rows = (await s.execute(stmt)).scalars().all()
        return [Project.from_row(r) for r in rows]

    async def update(self, pid: str, **fields) -> Project | None:
        from app.database import SessionLocal
        import json
        async with SessionLocal() as s:
            r = await s.get(ProjectRow, pid)
            if not r:
                return None
            for k, v in fields.items():
                if k == "tags" and isinstance(v, list):
                    v = json.dumps(v)
                if hasattr(r, k):
                    setattr(r, k, v)
            r.updated_at = time.time()
            await s.commit()
        return Project.from_row(r)

    async def delete(self, pid: str) -> bool:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            r = await s.get(ProjectRow, pid)
            if not r:
                return False
            await s.delete(r)
            await s.commit()
        return True
