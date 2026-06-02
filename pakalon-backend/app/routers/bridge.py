"""Bridge router — Telegram / Supabase integration endpoints."""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.bridge import (
    BridgeConnectRequest,
    BridgeConnectResponse,
    BridgeDisconnectResponse,
    BridgeMessageListResponse,
    BridgeSendMessageRequest,
    BridgeStatusResponse,
    BridgeWebhookRequest,
)
from app.services import bridge as svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/bridge", tags=["bridge"])


@router.post(
    "/connect",
    response_model=BridgeConnectResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Connect a Telegram or Supabase channel",
)
async def connect_bridge(
    body: BridgeConnectRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BridgeConnectResponse:
    bridge = await svc.connect_bridge(
        session,
        user_id=current_user.id,
        channel_type=body.channel_type,
        bot_token=body.bot_token,
        chat_id=body.chat_id,
        session_id=body.session_id,
    )
    await session.commit()
    return BridgeConnectResponse(
        id=bridge.id,
        channel_type=bridge.channel_type,  # type: ignore[arg-type]
        status=bridge.status,  # type: ignore[arg-type]
        webhook_url=bridge.webhook_url,
        webhook_secret=bridge.webhook_secret,
        chat_id=bridge.chat_id,
    )


@router.get(
    "/status",
    response_model=BridgeStatusResponse,
    summary="Get current bridge connection status",
)
async def bridge_status(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BridgeStatusResponse:
    try:
        bridge = await svc.get_bridge_status(session, current_user.id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return BridgeStatusResponse.model_validate(bridge)


@router.post(
    "/disconnect",
    response_model=BridgeDisconnectResponse,
    summary="Disconnect the active channel",
)
async def disconnect_bridge(
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BridgeDisconnectResponse:
    try:
        bridge = await svc.disconnect_bridge(session, current_user.id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    await session.commit()
    return BridgeDisconnectResponse(
        id=bridge.id,
        status=bridge.status,  # type: ignore[arg-type]
        disconnected_at=bridge.disconnected_at,  # type: ignore[arg-type]
    )


@router.post(
    "/send",
    response_model=BridgeStatusResponse,
    summary="Send a message through the active channel",
)
async def send_bridge_message(
    body: BridgeSendMessageRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BridgeStatusResponse:
    try:
        bridge, _msg = await svc.send_bridge_message(
            session, current_user.id, text=body.text
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    await session.commit()
    return BridgeStatusResponse.model_validate(bridge)


@router.post(
    "/webhook",
    response_model=BridgeStatusResponse,
    summary="Receive an inbound webhook update from the channel",
)
async def bridge_webhook(
    body: BridgeWebhookRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> BridgeStatusResponse:
    try:
        bridge, _msg = await svc.receive_bridge_message(
            session, current_user.id, text=body.text
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    await session.commit()
    return BridgeStatusResponse.model_validate(bridge)


@router.get(
    "/messages",
    response_model=BridgeMessageListResponse,
    summary="List recent in-memory message log entries for the current user",
)
async def list_messages(
    current_user: Annotated[User, Depends(get_current_user)],
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
) -> BridgeMessageListResponse:
    msgs = svc.list_messages(current_user.id, limit=limit)
    return BridgeMessageListResponse(messages=msgs, total=len(msgs))
