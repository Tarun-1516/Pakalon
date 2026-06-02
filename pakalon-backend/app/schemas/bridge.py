"""Pydantic v2 schemas for the bridge (Telegram + Supabase)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


BridgeChannel = Literal["telegram", "supabase"]
BridgeStatus = Literal["pending", "active", "paused", "disconnected", "error"]
MessageDirection = Literal["inbound", "outbound"]


class BridgeConnectRequest(BaseModel):
    channel_type: BridgeChannel = "telegram"
    bot_token: str = Field(..., min_length=8, max_length=512)
    chat_id: str | None = None
    session_id: str | None = None


class BridgeSendMessageRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8_000)


class BridgeWebhookRequest(BaseModel):
    update_id: int = Field(..., ge=1)
    chat_id: str = Field(..., min_length=1)
    text: str = Field(..., min_length=1, max_length=8_000)


class BridgeMessage(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    direction: MessageDirection
    text: str
    received_at: datetime


class BridgeConnectResponse(BaseModel):
    id: str
    channel_type: BridgeChannel
    status: BridgeStatus
    webhook_url: str | None
    webhook_secret: str | None
    chat_id: str | None


class BridgeStatusResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    channel_type: BridgeChannel
    status: BridgeStatus
    chat_id: str | None
    messages_sent: int
    messages_received: int
    last_message_at: datetime | None
    last_message_text: str | None
    error_message: str | None
    connected_at: datetime | None
    disconnected_at: datetime | None


class BridgeMessageListResponse(BaseModel):
    messages: list[BridgeMessage]
    total: int


class BridgeDisconnectResponse(BaseModel):
    id: str
    status: BridgeStatus
    disconnected_at: datetime
