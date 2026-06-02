"""Commit data model."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from sqlalchemy import String, Text, Float
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CommitType(str, Enum):
    FEAT = "feat"
    FIX = "fix"
    REFACTOR = "refactor"
    DOCS = "docs"
    TEST = "test"
    CHORE = "chore"
    PERF = "perf"
    STYLE = "style"
    BUILD = "build"
    CI = "ci"


class CommitRow(Base):
    __tablename__ = "commits"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), default="")
    branch: Mapped[str] = mapped_column(String(256), default="")
    type: Mapped[str] = mapped_column(String(32), default=CommitType.FEAT.value)
    scope: Mapped[str] = mapped_column(String(128), default="")
    subject: Mapped[str] = mapped_column(String(512))
    body: Mapped[str] = mapped_column(Text, default="")
    footer: Mapped[str] = mapped_column(Text, default="")
    files: Mapped[str] = mapped_column(Text, default="[]")
    breaking: Mapped[str] = mapped_column(String(8), default="false")
    sha: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class Commit:
    id: str
    session_id: str
    branch: str
    type: CommitType
    scope: str
    subject: str
    body: str
    footer: str
    files: list[str] = field(default_factory=list)
    breaking: bool = False
    sha: str = ""
    created_at: float = 0.0

    def message(self) -> str:
        head = f"{self.type.value}"
        if self.scope:
            head += f"({self.scope})"
        if self.breaking:
            head += "!"
        head += f": {self.subject}"
        parts = [head]
        if self.body:
            parts.append("")
            parts.append(self.body)
        if self.footer:
            parts.append("")
            parts.append(self.footer)
        return "\n".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "branch": self.branch,
            "type": self.type.value,
            "scope": self.scope,
            "subject": self.subject,
            "body": self.body,
            "footer": self.footer,
            "files": self.files,
            "breaking": self.breaking,
            "sha": self.sha,
            "message": self.message(),
            "created_at": self.created_at,
        }

    @classmethod
    def from_row(cls, r: CommitRow) -> "Commit":
        return cls(
            id=r.id, session_id=r.session_id, branch=r.branch,
            type=CommitType(r.type), scope=r.scope,
            subject=r.subject, body=r.body, footer=r.footer,
            files=json.loads(r.files or "[]"),
            breaking=(r.breaking == "true"),
            sha=r.sha, created_at=r.created_at,
        )
