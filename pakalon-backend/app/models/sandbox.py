"""Sandbox ORM model — tracks the lifecycle of a sandbox container per project.

The sandbox isolates project execution (Phase 3-5) in a Docker container
with explicit CPU/memory limits, network policy, and snapshot support.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


DEFAULT_SANDBOX_IMAGE = "pakalon-sandbox:latest"
DEFAULT_SANDBOX_NETWORK = "pakalon-sandbox-net"
DEFAULT_SANDBOX_PORT = 7432
DEFAULT_APP_PORT = 3000
DEFAULT_CPU_LIMIT = "1.0"
DEFAULT_MEMORY_LIMIT = "1g"


class Sandbox(Base):
    """One sandbox container tied to a project directory and user session."""

    __tablename__ = "sandboxes"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("sessions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    project_dir: Mapped[str] = mapped_column(String(1024), nullable=False)
    container_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    image: Mapped[str] = mapped_column(
        String(256), nullable=False, default=DEFAULT_SANDBOX_IMAGE
    )
    network: Mapped[str] = mapped_column(
        String(64), nullable=False, default=DEFAULT_SANDBOX_NETWORK
    )
    sandbox_port: Mapped[int] = mapped_column(
        Integer, nullable=False, default=DEFAULT_SANDBOX_PORT
    )
    app_port: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_APP_PORT)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="stopped", index=True
    )
    policy_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    policy_violations: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cpu_limit: Mapped[str] = mapped_column(
        String(16), nullable=False, default=DEFAULT_CPU_LIMIT
    )
    memory_limit: Mapped[str] = mapped_column(
        String(16), nullable=False, default=DEFAULT_MEMORY_LIMIT
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_health_check_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
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
            f"<Sandbox id={self.id!r} image={self.image!r} "
            f"status={self.status!r} port={self.sandbox_port}>"
        )
