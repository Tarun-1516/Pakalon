"""v2 session data models."""
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


class V2SessionStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    CLOSED = "closed"
    ARCHIVED = "archived"


class V2SessionRow(Base):
    __tablename__ = "sessions_v2"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    parent_id: Mapped[str] = mapped_column(String(64), default="")
    root_id: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(String(512), default="")
    status: Mapped[str] = mapped_column(String(16), default=V2SessionStatus.ACTIVE.value)
    owner: Mapped[str] = mapped_column(String(64), default="")
    project_id: Mapped[str] = mapped_column(String(64), default="")
    head_turn_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)
    updated_at: Mapped[float] = mapped_column(Float, default=time.time)


class V2TurnRow(Base):
    __tablename__ = "sessions_v2_turns"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    parent_turn_id: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    tool_calls: Mapped[str] = mapped_column(Text, default="[]")
    tool_results: Mapped[str] = mapped_column(Text, default="[]")
    model: Mapped[str] = mapped_column(String(128), default="")
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


class V2BranchRow(Base):
    __tablename__ = "sessions_v2_branches"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    parent_branch_id: Mapped[str] = mapped_column(String(64), default="")
    fork_turn_id: Mapped[str] = mapped_column(String(64), default="")
    name: Mapped[str] = mapped_column(String(256), default="")
    head_turn_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[float] = mapped_column(Float, default=time.time)


class V2EventRow(Base):
    __tablename__ = "sessions_v2_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    turn_id: Mapped[str] = mapped_column(String(64), default="")
    kind: Mapped[str] = mapped_column(String(32))
    payload: Mapped[str] = mapped_column(Text, default="")
    ts: Mapped[float] = mapped_column(Float, default=time.time)


@dataclass(slots=True)
class V2Session:
    id: str
    parent_id: str
    root_id: str
    title: str
    status: V2SessionStatus
    owner: str
    project_id: str
    head_turn_id: str
    created_at: float
    updated_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "parent_id": self.parent_id,
            "root_id": self.root_id, "title": self.title,
            "status": self.status.value, "owner": self.owner,
            "project_id": self.project_id, "head_turn_id": self.head_turn_id,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, r: V2SessionRow) -> "V2Session":
        return cls(
            id=r.id, parent_id=r.parent_id, root_id=r.root_id,
            title=r.title, status=V2SessionStatus(r.status),
            owner=r.owner, project_id=r.project_id,
            head_turn_id=r.head_turn_id,
            created_at=r.created_at, updated_at=r.updated_at,
        )


@dataclass(slots=True)
class V2Turn:
    id: str
    session_id: str
    parent_turn_id: str
    role: str
    content: str
    tool_calls: list[dict] = field(default_factory=list)
    tool_results: list[dict] = field(default_factory=list)
    model: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    created_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "session_id": self.session_id,
            "parent_turn_id": self.parent_turn_id, "role": self.role,
            "content": self.content, "tool_calls": self.tool_calls,
            "tool_results": self.tool_results, "model": self.model,
            "tokens_in": self.tokens_in, "tokens_out": self.tokens_out,
            "created_at": self.created_at,
        }

    @classmethod
    def from_row(cls, r: V2TurnRow) -> "V2Turn":
        return cls(
            id=r.id, session_id=r.session_id, parent_turn_id=r.parent_turn_id,
            role=r.role, content=r.content,
            tool_calls=json.loads(r.tool_calls or "[]"),
            tool_results=json.loads(r.tool_results or "[]"),
            model=r.model, tokens_in=r.tokens_in, tokens_out=r.tokens_out,
            created_at=r.created_at,
        )


@dataclass(slots=True)
class V2Branch:
    id: str
    session_id: str
    parent_branch_id: str
    fork_turn_id: str
    name: str
    head_turn_id: str
    created_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "session_id": self.session_id,
            "parent_branch_id": self.parent_branch_id,
            "fork_turn_id": self.fork_turn_id, "name": self.name,
            "head_turn_id": self.head_turn_id, "created_at": self.created_at,
        }

    @classmethod
    def from_row(cls, r: V2BranchRow) -> "V2Branch":
        return cls(
            id=r.id, session_id=r.session_id,
            parent_branch_id=r.parent_branch_id,
            fork_turn_id=r.fork_turn_id, name=r.name,
            head_turn_id=r.head_turn_id, created_at=r.created_at,
        )


@dataclass(slots=True)
class V2Event:
    id: str
    session_id: str
    turn_id: str
    kind: str
    payload: dict
    ts: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "session_id": self.session_id,
            "turn_id": self.turn_id, "kind": self.kind,
            "payload": self.payload, "ts": self.ts,
        }
