"""Pydantic v2 schemas for SubAgentRun."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


SubAgentStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


PHASE3_AGENTS = Literal["frontend", "backend", "integration", "debug", "feedback"]
PHASE4_AGENTS = Literal["sast", "dast", "code-review", "cicd-review", "best-practices"]
AgentName = Literal[
    "frontend", "backend", "integration", "debug", "feedback",
    "sast", "dast", "code-review", "cicd-review", "best-practices",
]


class SubAgentRunCreate(BaseModel):
    phase_run_id: str | None = None
    session_id: str | None = None
    agent_name: AgentName
    phase_number: int = Field(3, ge=1, le=6)
    input_prompt: str = Field("", max_length=64_000)


class SubAgentRunStartRequest(BaseModel):
    pass


class SubAgentRunCompleteRequest(BaseModel):
    output_artifact_path: str | None = None
    output_summary: str | None = None
    tokens_used: int = 0


class SubAgentRunFailRequest(BaseModel):
    error_message: str = Field(..., min_length=1)


class SubAgentRunCancelRequest(BaseModel):
    reason: str | None = None


class SubAgentRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    phase_run_id: str | None
    user_id: str
    session_id: str | None
    agent_name: AgentName
    phase_number: int
    status: SubAgentStatus
    input_prompt: str
    output_artifact_path: str | None
    output_summary: str | None
    tokens_used: int
    started_at: datetime | None
    completed_at: datetime | None
    error_message: str | None
    metadata_json: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class SubAgentRunUpdate(BaseModel):
    status: SubAgentStatus | None = None
    error_message: str | None = None


class SubAgentRunListResponse(BaseModel):
    runs: list[SubAgentRunRead]
    total: int
