"""Penpot session ORM model — tracks the lifecycle of a Penpot container.

The CLI launches a local Penpot container on demand, generates a token,
and pushes wireframe edits back to the project. This ORM records the
container handle, port, sync state, and cooldown to avoid hammering.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


DEFAULT_PENPOT_PORT = 3449


class PenpotSession(Base):
    """A running (or recently-running) Penpot container for a project."""

    __tablename__ = "penpot_sessions"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    project_dir: Mapped[str] = mapped_column(String(1024), nullable=False)
    container_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    port: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_PENPOT_PORT)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="stopped", index=True
    )
    penpot_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    token: Mapped[str | None] = mapped_column(String(256), nullable=True)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sync_changes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cooldown_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(tz=timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(tz=timezone.utc),
        onupdate=lambda: datetime.now(tz=timezone.utc),
    )

    def __repr__(self) -> str:
        return (
            f"<PenpotSession id={self.id!r} project={self.project_dir!r} "
            f"status={self.status!r} port={self.port}>"
        )
