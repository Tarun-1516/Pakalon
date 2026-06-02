"""Telegram-specific endpoints.

A thin wrapper around the generic /bridge router. The CLI's
/connect-end command posts to /api/telegram/disconnect to clear
the user's stored bot token. We delegate to the existing bridge
service so we don't fork the storage logic.
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.services import bridge as svc
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/telegram", tags=["telegram"])


class TelegramDisconnectRequest(BaseModel):
    bot_token: str | None = None
    """Optional — the bot token to disconnect. If omitted, the
    currently-active bridge for the user is disconnected."""


class TelegramDisconnectResponse(BaseModel):
    ok: bool
    bridge_id: str | None = None
    reason: str | None = None


@router.post(
    "/disconnect",
    response_model=TelegramDisconnectResponse,
    summary="Disconnect the user's Telegram bot from Pakalon",
)
async def telegram_disconnect(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    body: TelegramDisconnectRequest | None = None,
) -> TelegramDisconnectResponse:
    """Clear the stored Telegram bridge for the authenticated user."""
    try:
        bridge = await svc.disconnect_bridge(session, current_user.id)
    except LookupError:
        # Nothing to disconnect — still return 200 so the CLI cleans up local state
        return TelegramDisconnectResponse(ok=True, reason="no_active_bridge")
    except Exception as exc:  # noqa: BLE001
        logger.exception("telegram_disconnect failed")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    await session.commit()
    return TelegramDisconnectResponse(
        ok=True,
        bridge_id=str(bridge.id),
        reason="disconnected",
    )
