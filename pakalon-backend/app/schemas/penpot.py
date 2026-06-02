"""Pydantic v2 schemas for Penpot wireframe sync."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


PenpotStatus = Literal[
    "stopped", "starting", "running", "syncing", "error", "stopping"
]
PenpotChangeType = Literal["create", "update", "delete", "move", "style"]


class PenpotSessionCreate(BaseModel):
    session_id: str | None = None
    project_dir: str = Field(..., min_length=1, max_length=1024)
    port: int = Field(3449, ge=1024, le=65535)


class PenpotSyncEvent(BaseModel):
    element_id: str = Field(..., min_length=1, max_length=128)
    change_type: PenpotChangeType
    before_state: dict | None = None
    after_state: dict | None = None
    occurred_at: datetime | None = None


class PenpotSyncRequest(BaseModel):
    events: list[PenpotSyncEvent] = Field(..., min_length=1)
    cooldown_seconds: int = Field(2, ge=0, le=60)


class PenpotSyncResponse(BaseModel):
    accepted: int
    cooldown_until: datetime | None
    sync_changes: int


class PenpotSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    session_id: str | None
    project_dir: str
    container_id: str | None
    port: int
    status: PenpotStatus
    penpot_url: str | None
    token: str | None
    last_sync_at: datetime | None
    sync_changes: int
    cooldown_until: datetime | None
    error_message: str | None
    started_at: datetime | None
    stopped_at: datetime | None
    created_at: datetime
    updated_at: datetime


class PenpotSessionListResponse(BaseModel):
    sessions: list[PenpotSessionRead]
    total: int
