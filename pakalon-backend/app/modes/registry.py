"""Agent mode registry."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable


class AgentMode(str, Enum):
    CHAT = "chat"
    PLAN = "plan"
    EDIT = "edit"
    YOLO = "yolo"
    ULTRATHINK = "ultrathink"
    AUDIT = "audit"
    DEVOPS = "devops"
    SCRAP = "scrap"
    DEBUG = "debug"
    SECURITY = "security"
    RESEARCH = "research"
    MIGRATE = "migrate"


@dataclass(slots=True)
class ModeMetadata:
    name: AgentMode
    label: str
    description: str
    allowed_tools: list[str] = field(default_factory=list)
    disallowed_tools: list[str] = field(default_factory=list)
    max_steps: int = 50
    system_prompt_suffix: str = ""


Handler = Callable[[dict], Awaitable[dict]]


DEFAULT_MODES: dict[AgentMode, ModeMetadata] = {
    AgentMode.CHAT: ModeMetadata(
        name=AgentMode.CHAT, label="Chat", description="Interactive Q&A without code changes",
        allowed_tools=["read_file", "grep", "web_search", "web_fetch"],
        max_steps=20,
    ),
    AgentMode.PLAN: ModeMetadata(
        name=AgentMode.PLAN, label="Plan", description="Read-only planning and design",
        allowed_tools=["read_file", "grep", "ls", "web_search", "web_fetch"],
        max_steps=50,
    ),
    AgentMode.EDIT: ModeMetadata(
        name=AgentMode.EDIT, label="Edit", description="Targeted file edits with user approval",
        allowed_tools=["read_file", "write_file", "edit_file", "grep", "ls"],
        max_steps=50,
    ),
    AgentMode.YOLO: ModeMetadata(
        name=AgentMode.YOLO, label="YOLO", description="Auto-accept everything, no prompts",
        allowed_tools=["*"], max_steps=500,
    ),
    AgentMode.ULTRATHINK: ModeMetadata(
        name=AgentMode.ULTRATHINK, label="Ultrathink",
        description="Deep reasoning mode with extended thinking, model routing, and verification",
        allowed_tools=["*"], max_steps=1000,
        system_prompt_suffix="\nThink carefully. Verify your assumptions. Re-read the question. Plan before acting. Reflect after each step.",
    ),
    AgentMode.AUDIT: ModeMetadata(
        name=AgentMode.AUDIT, label="Audit", description="Code-quality audit without modifications",
        allowed_tools=["read_file", "grep", "ls"],
        max_steps=100,
    ),
    AgentMode.DEVOPS: ModeMetadata(
        name=AgentMode.DEVOPS, label="DevOps", description="CI/CD, infra, deploys",
        allowed_tools=["read_file", "write_file", "exec", "git"],
        max_steps=200,
    ),
    AgentMode.SCRAP: ModeMetadata(
        name=AgentMode.SCRAP, label="Scrap", description="Web scraping with multiple providers",
        allowed_tools=["scrape", "web_fetch", "write_file"],
        max_steps=200,
    ),
    AgentMode.DEBUG: ModeMetadata(
        name=AgentMode.DEBUG, label="Debug", description="Debug session with breakpoints",
        allowed_tools=["*"],
        max_steps=200,
        system_prompt_suffix="\nWhen debugging, gather evidence first (logs, traces, repro steps) before forming hypotheses.",
    ),
    AgentMode.SECURITY: ModeMetadata(
        name=AgentMode.SECURITY, label="Security", description="Threat-model + SAST/DAST workflow",
        allowed_tools=["read_file", "grep", "exec", "sast", "dast"],
        max_steps=300,
    ),
    AgentMode.RESEARCH: ModeMetadata(
        name=AgentMode.RESEARCH, label="Research", description="Long-running research with citations",
        allowed_tools=["read_file", "web_search", "web_fetch", "scrape"],
        max_steps=500,
    ),
    AgentMode.MIGRATE: ModeMetadata(
        name=AgentMode.MIGRATE, label="Migrate", description="Migrations, refactors, version-bumps",
        allowed_tools=["read_file", "write_file", "edit_file", "exec", "git"],
        max_steps=500,
    ),
}


class ModeRegistry:
    def __init__(self) -> None:
        self._modes: dict[AgentMode, ModeMetadata] = dict(DEFAULT_MODES)
        self._handlers: dict[AgentMode, Handler] = {}

    def get(self, mode: AgentMode) -> ModeMetadata:
        return self._modes.get(mode, self._modes[AgentMode.CHAT])

    def register(self, mode: AgentMode, meta: ModeMetadata, handler: Handler | None = None) -> None:
        self._modes[mode] = meta
        if handler is not None:
            self._handlers[mode] = handler

    def list_modes(self) -> list[dict[str, Any]]:
        return [
            {
                "name": m.name.value, "label": m.label, "description": m.description,
                "allowed_tools": m.allowed_tools, "disallowed_tools": m.disallowed_tools,
                "max_steps": m.max_steps,
            }
            for m in self._modes.values()
        ]

    async def invoke(self, mode: AgentMode, payload: dict) -> dict:
        handler = self._handlers.get(mode)
        if not handler:
            meta = self.get(mode)
            return {
                "mode": mode.value, "label": meta.label,
                "received": payload, "handled": False,
                "note": "no handler registered; metadata echoed",
            }
        return await handler(payload)
