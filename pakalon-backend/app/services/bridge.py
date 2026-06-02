"""Bridge service — manages Telegram / Supabase connections and message flow.

The bot token is stored base64-encoded as a stub. In production, the
backend should use Fernet (or a KMS) for symmetric encryption at rest.
"""
from __future__ import annotations

import base64
import binascii
import logging
import uuid
from datetime import datetime, timezone
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.bridge_connection import BridgeConnection

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _encode_token(token: str) -> str:
    """Stub: base64-encode the token. Production should use Fernet."""
    return base64.b64encode(token.encode("utf-8")).decode("ascii")


def _decode_token(encoded: str) -> str:
    try:
        return base64.b64decode(encoded.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return "<decrypt-failed>"


async def connect_bridge(
    session: AsyncSession,
    *,
    user_id: str,
    channel_type: str,
    bot_token: str,
    chat_id: str | None = None,
    session_id: str | None = None,
) -> BridgeConnection:
    existing = await session.execute(
        select(BridgeConnection).where(BridgeConnection.user_id == user_id)
    )
    bridge = existing.scalar_one_or_none()
    if bridge is None:
        bridge = BridgeConnection(
            user_id=user_id,
            session_id=session_id,
            channel_type=channel_type,
            status="pending",
        )
        session.add(bridge)
    else:
        bridge.channel_type = channel_type
        bridge.status = "pending"
        bridge.disconnected_at = None
        bridge.error_message = None
    bridge.bot_token_encrypted = _encode_token(bot_token)
    bridge.chat_id = chat_id
    bridge.webhook_secret = uuid.uuid4().hex + uuid.uuid4().hex
    bridge.webhook_url = f"/api/bridge/{bridge.webhook_secret[:16]}/webhook"
    bridge.status = "active"
    bridge.connected_at = _now()
    await session.flush()
    logger.info(
        f"[bridge] connect user_id={user_id} channel={channel_type} "
        f"id={bridge.id}"
    )
    return bridge


async def get_bridge_for_user(
    session: AsyncSession, user_id: str
) -> BridgeConnection:
    bridge = await session.execute(
        select(BridgeConnection).where(BridgeConnection.user_id == user_id)
    )
    row = bridge.scalar_one_or_none()
    if row is None:
        raise LookupError(f"No bridge for user_id {user_id}")
    return row


async def get_bridge_status(
    session: AsyncSession, user_id: str
) -> BridgeConnection:
    return await get_bridge_for_user(session, user_id)


async def disconnect_bridge(
    session: AsyncSession, user_id: str
) -> BridgeConnection:
    bridge = await get_bridge_for_user(session, user_id)
    bridge.status = "disconnected"
    bridge.disconnected_at = _now()
    await session.flush()
    logger.info(f"[bridge] disconnect user_id={user_id} id={bridge.id}")
    return bridge


async def record_send(
    session: AsyncSession, user_id: str, *, text: str
) -> BridgeConnection:
    bridge = await get_bridge_for_user(session, user_id)
    if bridge.status != "active":
        raise ValueError(f"Bridge is not active (status={bridge.status!r})")
    bridge.messages_sent += 1
    bridge.last_message_at = _now()
    bridge.last_message_text = text
    await session.flush()
    return bridge


async def record_receive(
    session: AsyncSession, user_id: str, *, text: str
) -> BridgeConnection:
    bridge = await get_bridge_for_user(session, user_id)
    bridge.messages_received += 1
    bridge.last_message_at = _now()
    bridge.last_message_text = text
    await session.flush()
    return bridge


# ── In-memory message log (per-user) ────────────────────────────────────────
# This complements the ORM counters. In production this should be moved to
# a proper table for retention and querying.
_MESSAGE_LOG: dict[str, list[BridgeMessage]] = {}


def _log_message(user_id: str, direction: str, text: str) -> BridgeMessage:
    msg = BridgeMessage(
        id=uuid.uuid4().hex,
        direction=direction,
        text=text,
        received_at=_now(),
    )
    bucket: list = _MESSAGE_LOG.setdefault(user_id, [])
    bucket.append(msg)
    if len(bucket) > 500:
        del bucket[: len(bucket) - 500]
    return msg


def list_messages(user_id: str, limit: int = 50) -> list[BridgeMessage]:
    bucket = _MESSAGE_LOG.get(user_id, [])
    return list(bucket[-limit:])


# ── Convenience wrappers that combine ORM + log ─────────────────────────────
async def send_bridge_message(
    session: AsyncSession, user_id: str, *, text: str
) -> tuple[BridgeConnection, BridgeMessage]:
    bridge = await record_send(session, user_id, text=text)
    msg = _log_message(user_id, "outbound", text)
    return bridge, msg


async def receive_bridge_message(
    session: AsyncSession, user_id: str, *, text: str
) -> tuple[BridgeConnection, BridgeMessage]:
    bridge = await record_receive(session, user_id, text=text)
    msg = _log_message(user_id, "inbound", text)
    return bridge, msg
