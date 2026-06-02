"""Pydantic v2 schemas for the auditor."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


AuditorStatus = Literal[
    "queued", "running", "analyzing", "completed", "failed", "cancelled"
]
FindingStatus = Literal["missing", "partial", "implemented"]
FindingSeverity = Literal["low", "medium", "high", "critical"]


class AuditorFinding(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    status: FindingStatus
    description: str = Field("", max_length=4_000)
    file_path: str | None = None
    line_number: int | None = None
    severity: FindingSeverity = "medium"


class AuditorRunCreate(BaseModel):
    session_id: str | None = None
    project_dir: str = Field(..., min_length=1, max_length=1024)
    phase_number: int = Field(3, ge=1, le=6)
    max_iterations: int = Field(10, ge=1, le=50)
    is_yolo: bool = False


class AuditorFindingsRequest(BaseModel):
    findings: list[AuditorFinding] = Field(..., min_length=1)
    report_path: str | None = None
    report_summary: str | None = None


class AuditorRunCancelRequest(BaseModel):
    reason: str | None = None


class AuditorRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    session_id: str | None
    project_dir: str
    phase_number: int
    iteration: int
    max_iterations: int
    is_yolo: bool
    status: AuditorStatus
    report_path: str | None
    report_summary: str | None
    missing_count: int
    partial_count: int
    implemented_count: int
    total_count: int
    compliance_pct: float
    trigger_remediation: bool
    findings: list[dict[str, Any]]
    started_at: datetime | None
    completed_at: datetime | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime


class AuditorRunListResponse(BaseModel):
    runs: list[AuditorRunRead]
    total: int
