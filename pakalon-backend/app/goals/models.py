"""Goal data model."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from sqlalchemy import String, Text, Float, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class GoalStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    BLOCKED = "blocked"
    DONE = "done"
    CANCELLED = "cancelled"


class GoalRow(Base):
    __tablename__ = "goals"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    parent_id: Mapped[str] = mapped_column(String(64), default="")
    session_id: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(String(512))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default=GoalStatus.PENDING.value)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    tags: Mapped[str] = mapped_column(Text, default="[]")
    blocked_by: Mapped[str] = mapped_column(Text, default="[]")  # list of goal ids
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    updated_at: Mapped[float] = mapped_column(Float, default=time.time)
    completed_at: Mapped[float] = mapped_column(Float, default=0.0)


@dataclass(slots=True)
class Goal:
    id: str
    parent_id: str
    session_id: str
    title: str
    description: str
    status: GoalStatus
    priority: int
    progress: float
    tags: list[str] = field(default_factory=list)
    blocked_by: list[str] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0
    completed_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "parent_id": self.parent_id,
            "session_id": self.session_id,
            "title": self.title,
            "description": self.description,
            "status": self.status.value,
            "priority": self.priority,
            "progress": self.progress,
            "tags": self.tags,
            "blocked_by": self.blocked_by,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
        }

    @classmethod
    def from_row(cls, r: GoalRow) -> "Goal":
        return cls(
            id=r.id,
            parent_id=r.parent_id,
            session_id=r.session_id,
            title=r.title,
            description=r.description,
            status=GoalStatus(r.status),
            priority=r.priority,
            progress=r.progress,
            tags=json.loads(r.tags or "[]"),
            blocked_by=json.loads(r.blocked_by or "[]"),
            created_at=r.created_at,
            updated_at=r.updated_at,
            completed_at=r.completed_at,
        )
