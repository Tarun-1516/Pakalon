"""Session observer router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from .service import get_observer, SessionObserver

router = APIRouter(prefix="/session-observer", tags=["session-observer"])


def observer() -> SessionObserver:
    return get_observer()


class ToolEvent(BaseModel):
    tool: str
    success: bool = True
    error: str = ""


class Tokens(BaseModel):
    tokens_in: int = 0
    tokens_out: int = 0


@router.post("/{session_id}/user-message")
async def user_msg(session_id: str) -> dict[str, bool]:
    observer().record_user_message(session_id)
    return {"ok": True}


@router.post("/{session_id}/assistant-message")
async def assistant_msg(session_id: str) -> dict[str, bool]:
    observer().record_assistant_message(session_id)
    return {"ok": True}


@router.post("/{session_id}/tool-start")
async def tool_start(session_id: str, body: ToolEvent) -> dict[str, str]:
    inv = observer().start_tool(session_id, body.tool)
    return {"invocation_id": inv}


@router.post("/{session_id}/tool-end")
async def tool_end(session_id: str, body: ToolEvent) -> dict[str, bool]:
    observer().end_tool(session_id, body.tool, success=body.success, error=body.error)
    return {"ok": True}


@router.post("/{session_id}/tokens")
async def record_tokens(session_id: str, body: Tokens) -> dict[str, bool]:
    observer().record_tokens(session_id, body.tokens_in, body.tokens_out)
    return {"ok": True}


@router.get("/{session_id}/metrics")
async def metrics(session_id: str) -> dict[str, Any]:
    return observer().metrics(session_id)


@router.get("/all")
async def all_metrics() -> list[dict[str, Any]]:
    return observer().all_metrics()
