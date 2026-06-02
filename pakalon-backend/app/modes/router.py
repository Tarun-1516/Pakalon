"""Modes router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .registry import ModeRegistry, AgentMode
from .ultrathink import UltrathinkMode, get_default

router = APIRouter(prefix="/modes", tags=["modes"])
_registry = ModeRegistry()
_ultrathink = get_default()
# wire ultrathink handler into the shared registry
_ultrathink_meta = _ultrathink.registry.get(AgentMode.ULTRATHINK)
_registry.register(AgentMode.ULTRATHINK, _ultrathink_meta, handler=_ultrathink.run)


class InvokeRequest(BaseModel):
    mode: AgentMode
    payload: dict[str, Any] = Field(default_factory=dict)


@router.get("")
async def list_modes() -> list[dict[str, Any]]:
    return _registry.list_modes()


@router.get("/{mode}")
async def get_mode(mode: AgentMode) -> dict[str, Any]:
    m = _registry.get(mode)
    return {
        "name": m.name.value, "label": m.label, "description": m.description,
        "allowed_tools": m.allowed_tools, "disallowed_tools": m.disallowed_tools,
        "max_steps": m.max_steps,
    }


@router.post("/invoke")
async def invoke(body: InvokeRequest) -> dict[str, Any]:
    return await _registry.invoke(body.mode, body.payload)
