"""Pydantic v2 schemas for PhaseRun."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


PhaseStatus = Literal[
    "pending", "running", "paused", "checkpoint", "completed", "failed", "aborted"
]
CheckpointDecision = Literal["approve", "reject", "modify"]


class PhaseRunCreate(BaseModel):
    session_id: str | None = None
    project_dir: str = Field(..., min_length=1, max_length=1024)
    phase_number: int = Field(..., ge=1, le=6)
    is_yolo: bool = False


class PhaseCheckpointRequest(BaseModel):
    summary: str = Field(..., min_length=1)
    artifacts: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)


class PhaseCheckpointDecisionRequest(BaseModel):
    decision: CheckpointDecision
    notes: str | None = None


class PhaseAbortRequest(BaseModel):
    reason: str | None = None


class PhaseRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    session_id: str | None
    user_id: str
    project_dir: str
    phase_number: int
    phase_name: str
    status: PhaseStatus
    is_yolo: bool
    started_at: datetime | None
    paused_at: datetime | None
    completed_at: datetime | None
    artifacts: list[str]
    checkpoint_data: dict[str, Any] | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime


class PhaseRunUpdate(BaseModel):
    status: PhaseStatus | None = None
    error_message: str | None = None


class PhaseRunListResponse(BaseModel):
    runs: list[PhaseRunRead]
    total: int
