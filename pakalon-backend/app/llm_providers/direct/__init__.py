"""Direct LLM provider implementations.

Each module here implements the same `DirectProvider` async-protocol so the
router can dispatch to any of them uniformly.  They are additive — the
existing `catalog.py` metadata and `ai_proxy` router continue to work.

Public protocol
---------------
    class DirectProvider(Protocol):
        id: str
        async def chat(self, req: ChatRequest) -> ChatResponse: ...
        async def stream(self, req: ChatRequest) -> AsyncIterator[StreamChunk]: ...

The dispatch table is in :func:`get_provider` below.
"""
from __future__ import annotations

from .base import (
    ChatRequest,
    ChatResponse,
    StreamChunk,
    ToolCall,
    ToolDef,
    Usage,
    Message,
    Role,
    DirectError,
    DirectProvider,
    register_provider,
    get_provider,
    list_provider_ids,
)

__all__ = [
    "ChatRequest", "ChatResponse", "StreamChunk",
    "ToolCall", "ToolDef", "Usage", "Message", "Role",
    "DirectError", "DirectProvider",
    "register_provider", "get_provider", "list_provider_ids",
]
