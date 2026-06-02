"""Pydantic v2 schemas for sandbox lifecycle and execution."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


SandboxStatus = Literal[
    "stopped", "starting", "running", "executing", "paused", "error", "stopping"
]


class SandboxCreate(BaseModel):
    session_id: str | None = None
    project_dir: str = Field(..., min_length=1, max_length=1024)
    image: str = Field("pakalon-sandbox:latest", max_length=256)
    network: str = Field("pakalon-sandbox-net", max_length=64)
    sandbox_port: int = Field(7432, ge=1024, le=65535)
    app_port: int = Field(3000, ge=1, le=65535)
    cpu_limit: str = Field("1.0", max_length=16)
    memory_limit: str = Field("1g", max_length=16)
    policy_id: str | None = None


class SandboxExecRequest(BaseModel):
    command: str = Field(..., min_length=1, max_length=4_000)
    working_dir: str | None = Field(None, max_length=1024)
    env: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: int = Field(60, ge=1, le=3600)


class SandboxExecResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int


class SandboxSnapshotRequest(BaseModel):
    label: str = Field("", max_length=128)
    include_state: bool = True


class SandboxSnapshotResponse(BaseModel):
    snapshot_id: str
    sandbox_id: str
    label: str
    created_at: datetime


class SandboxRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    session_id: str | None
    project_dir: str
    container_id: str | None
    image: str
    network: str
    sandbox_port: int
    app_port: int
    status: SandboxStatus
    policy_id: str | None
    policy_violations: int
    cpu_limit: str
    memory_limit: str
    started_at: datetime | None
    stopped_at: datetime | None
    last_health_check_at: datetime | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime


class SandboxListResponse(BaseModel):
    sandboxes: list[SandboxRead]
    total: int
