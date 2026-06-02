"""Auditor run ORM model — tracks iteration of the code-quality auditor.

The auditor compares generated code against CLI-req.md features, classifies
each as missing/partial/implemented, and triggers remediation when
compliance < 100%.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AuditorRun(Base):
    """One iteration of the auditor's analysis pass over a project."""

    __tablename__ = "auditor_runs"

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
    phase_number: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    max_iterations: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    is_yolo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="queued", index=True
    )
    report_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    report_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    missing_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    partial_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    implemented_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    compliance_pct: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    trigger_remediation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    findings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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
            f"<AuditorRun id={self.id!r} iter={self.iteration}/{self.max_iterations} "
            f"compliance={self.compliance_pct}% status={self.status!r}>"
        )
