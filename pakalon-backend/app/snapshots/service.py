"""Snapshot service: capture / restore / diff."""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import String, Text, Float, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class SnapshotRow(Base):
    __tablename__ = "snapshots"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    label: Mapped[str] = mapped_column(String(256), default="")
    files: Mapped[str] = mapped_column(Text, default="{}")
    archive_path: Mapped[str] = mapped_column(String(1024), default="")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class Snapshot:
    id: str
    session_id: str
    label: str
    files: dict[str, str]  # path -> sha256
    archive_path: str
    size_bytes: int
    sha256: str
    created_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "session_id": self.session_id,
            "label": self.label, "files": self.files,
            "archive_path": self.archive_path, "size_bytes": self.size_bytes,
            "sha256": self.sha256, "created_at": self.created_at,
        }


class SnapshotService:
    def __init__(self, archive_dir: str = ".snapshots") -> None:
        self.archive_dir = archive_dir
        os.makedirs(archive_dir, exist_ok=True)

    def _sha(self, data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def _new_id(self) -> str:
        return f"snap_{uuid.uuid4().hex[:16]}"

    async def capture(
        self,
        paths: list[str],
        *,
        session_id: str = "",
        label: str = "",
        base_dir: str = ".",
    ) -> Snapshot:
        from app.database import SessionLocal
        archive_path = os.path.join(self.archive_dir, f"{self._new_id()}.zip")
        files: dict[str, str] = {}
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in paths:
                abs_path = os.path.join(base_dir, rel)
                if os.path.isdir(abs_path):
                    for root, _, fnames in os.walk(abs_path):
                        for f in fnames:
                            full = os.path.join(root, f)
                            arc = os.path.relpath(full, base_dir)
                            try:
                                with open(full, "rb") as fh:
                                    data = fh.read()
                                zf.writestr(arc, data)
                                files[arc] = self._sha(data)
                            except Exception:
                                continue
                elif os.path.isfile(abs_path):
                    try:
                        with open(abs_path, "rb") as fh:
                            data = fh.read()
                        zf.writestr(rel, data)
                        files[rel] = self._sha(data)
                    except Exception:
                        continue
        size = os.path.getsize(archive_path)
        digest = self._sha(open(archive_path, "rb").read())
        row = SnapshotRow(
            id=self._new_id(),
            session_id=session_id, label=label,
            files=json.dumps(files),
            archive_path=archive_path,
            size_bytes=size, sha256=digest, created_at=time.time(),
        )
        async with SessionLocal() as s:
            s.add(row)
            await s.commit()
        return Snapshot(
            id=row.id, session_id=session_id, label=label, files=files,
            archive_path=archive_path, size_bytes=size, sha256=digest,
            created_at=row.created_at,
        )

    async def list(self, session_id: str | None = None, limit: int = 100) -> list[Snapshot]:
        from app.database import SessionLocal
        from sqlalchemy import select
        async with SessionLocal() as s:
            stmt = select(SnapshotRow).order_by(SnapshotRow.created_at.desc()).limit(limit)
            if session_id:
                stmt = stmt.where(SnapshotRow.session_id == session_id)
            rows = (await s.execute(stmt)).scalars().all()
        return [
            Snapshot(
                id=r.id, session_id=r.session_id, label=r.label,
                files=json.loads(r.files or "{}"),
                archive_path=r.archive_path, size_bytes=r.size_bytes,
                sha256=r.sha256, created_at=r.created_at,
            )
            for r in rows
        ]

    async def get(self, snap_id: str) -> Snapshot | None:
        from app.database import SessionLocal
        async with SessionLocal() as s:
            r = await s.get(SnapshotRow, snap_id)
        if not r:
            return None
        return Snapshot(
            id=r.id, session_id=r.session_id, label=r.label,
            files=json.loads(r.files or "{}"),
            archive_path=r.archive_path, size_bytes=r.size_bytes,
            sha256=r.sha256, created_at=r.created_at,
        )

    def restore(self, snap: Snapshot, *, target_dir: str = ".") -> int:
        n = 0
        with zipfile.ZipFile(snap.archive_path, "r") as zf:
            for name in zf.namelist():
                out = os.path.join(target_dir, name)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with open(out, "wb") as f:
                    f.write(zf.read(name))
                n += 1
        return n

    def diff(self, a: Snapshot, b: Snapshot) -> dict[str, list[str]]:
        added = sorted(set(b.files) - set(a.files))
        removed = sorted(set(a.files) - set(b.files))
        common = set(a.files) & set(b.files)
        changed = sorted(p for p in common if a.files[p] != b.files[p])
        return {"added": added, "removed": removed, "changed": changed}
