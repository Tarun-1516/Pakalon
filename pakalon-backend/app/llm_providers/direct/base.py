"""Shared types and registry for direct LLM providers.

The 14 backends in `app/web_search/chain.py` and the 40+ entries in
`catalog.py` are metadata only.  These `DirectProvider` classes are
the *real* HTTP-callable implementations, additive on top of the
catalog.

Adding a new provider is a 3-step process:

  1. Subclass :class:`BaseHTTPProvider` and implement ``_request`` /
     ``_parse_response`` / ``_parse_stream``.
  2. Call :func:`register_provider` once at import time.
  3. Re-export from :mod:`app.llm_providers.direct`.

The dispatcher in :func:`get_provider` then exposes the new backend
via ``GET /llm_providers/direct/{provider_id}/chat`` and
``GET /llm_providers/direct/{provider_id}/stream``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Callable, Optional, Protocol, runtime_checkable

import httpx

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Shared types
# ─────────────────────────────────────────────────────────────────────────────

class Role(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass(slots=True)
class ToolDef:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(slots=True)
class Message:
    role: Role
    content: str
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: list["ToolCall"] = field(default_factory=list)


@dataclass(slots=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    cached_input_tokens: int = 0


@dataclass(slots=True)
class ChatRequest:
    model: str
    messages: list[Message]
    max_tokens: int = 1024
    temperature: float = 0.7
    top_p: float = 1.0
    stop: list[str] = field(default_factory=list)
    tools: list[ToolDef] = field(default_factory=list)
    tool_choice: Optional[str] = None  # "auto" | "any" | "none" | {"name": ...}
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ChatResponse:
    id: str
    model: str
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"
    usage: Usage = field(default_factory=Usage)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class StreamChunk:
    delta: str = ""
    tool_call_delta: Optional[ToolCall] = None
    finish_reason: Optional[str] = None
    usage: Optional[Usage] = None


class DirectError(RuntimeError):
    """Raised by a direct provider when a request fails."""

    def __init__(self, message: str, provider: str, status: int = 0, body: Any = None) -> None:
        super().__init__(f"[{provider}] {message}")
        self.provider = provider
        self.status = status
        self.body = body


# ─────────────────────────────────────────────────────────────────────────────
# Protocol + registry
# ─────────────────────────────────────────────────────────────────────────────

@runtime_checkable
class DirectProvider(Protocol):
    """The minimum contract every direct provider must satisfy."""

    id: str
    default_model: str

    async def chat(self, req: ChatRequest, *, api_key: Optional[str] = None) -> ChatResponse: ...
    def stream(self, req: ChatRequest, *, api_key: Optional[str] = None) -> AsyncIterator[StreamChunk]: ...


_REGISTRY: dict[str, type] = {}


def register_provider(cls: type) -> type:
    """Decorator — registers a DirectProvider subclass by its ``id``."""
    pid = getattr(cls, "id", None)
    if not pid:
        raise ValueError(f"{cls.__name__} must set class attribute `id`")
    if pid in _REGISTRY:
        logger.debug("provider %r already registered; overwriting", pid)
    _REGISTRY[pid] = cls
    return cls


def get_provider(provider_id: str, *, api_key: Optional[str] = None) -> DirectProvider:
    """Instantiate the provider class registered under ``provider_id``."""
    cls = _REGISTRY.get(provider_id)
    if cls is None:
        raise DirectError(f"unknown direct provider: {provider_id}", provider_id)
    inst = cls()
    if api_key is not None:
        inst.api_key = api_key  # type: ignore[attr-defined]
    return inst


def list_provider_ids() -> list[str]:
    return sorted(_REGISTRY)


# ─────────────────────────────────────────────────────────────────────────────
# Base class with shared HTTP plumbing
# ─────────────────────────────────────────────────────────────────────────────

class BaseHTTPProvider:
    """Shared HTTP plumbing for OpenAI-compatible, Anthropic, Google, etc.

    Subclasses override:
      - ``id`` and ``default_model`` (class attrs)
      - ``base_url``
      - ``auth_headers(api_key)`` (default: ``Authorization: Bearer …``)
      - ``_payload(req, api_key)`` — serialize ChatRequest to provider JSON
      - ``_parse_response(json, req)`` — parse JSON body to ChatResponse
      - ``_stream_lines(req, api_key)`` — return AsyncIterator[bytes] for SSE
      - ``_parse_stream_line(line)`` — parse one SSE line to StreamChunk|None
    """

    id: str = "abstract"
    default_model: str = ""
    base_url: str = ""
    requires_api_key: bool = True
    api_key: Optional[str] = None

    def __init__(self) -> None:
        # Default API key from environment, keyed by the provider id.
        env_key = f"{self.id.upper().replace('-', '_')}_API_KEY"
        self.api_key = os.getenv(env_key)

    # -- auth -----------------------------------------------------------------

    def auth_headers(self, api_key: Optional[str]) -> dict[str, str]:
        key = api_key or self.api_key
        return {"Authorization": f"Bearer {key}"}

    def _resolve_key(self, api_key: Optional[str]) -> str:
        key = api_key or self.api_key
        if self.requires_api_key and not key:
            raise DirectError(
                f"missing API key (set {self.id.upper().replace('-', '_')}_API_KEY or pass api_key=)",
                self.id,
            )
        return key or ""

    # -- chat (subclass-overridden) ------------------------------------------

    async def chat(self, req: ChatRequest, *, api_key: Optional[str] = None) -> ChatResponse:
        raise NotImplementedError

    def stream(self, req: ChatRequest, *, api_key: Optional[str] = None) -> AsyncIterator[StreamChunk]:
        raise NotImplementedError

    # -- helpers used by subclasses ------------------------------------------

    @staticmethod
    def json_dumps(obj: Any) -> str:
        return json.dumps(obj, ensure_ascii=False, default=str)

    @staticmethod
    def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
        """Very rough cost estimate based on the public list price table.
        Returns 0.0 if the model is unknown — never raises."""
        # (model, $/1M in, $/1M out)
        PRICE_TABLE: dict[str, tuple[float, float]] = {
            "claude-opus-4.8": (15.0, 75.0),
            "claude-opus-4.7": (15.0, 75.0),
            "claude-opus-4.5": (15.0, 75.0),
            "claude-sonnet-4.6": (3.0, 15.0),
            "claude-sonnet-4.5": (3.0, 15.0),
            "claude-haiku-4.5": (0.80, 4.0),
            "gpt-5.5": (10.0, 30.0),
            "gpt-5.4": (5.0, 15.0),
            "gpt-5.4-mini": (0.40, 1.60),
            "gpt-5.2": (2.50, 10.0),
            "gpt-4o": (2.50, 10.0),
            "gpt-4o-mini": (0.15, 0.60),
            "gemini-3.1-pro-preview": (1.25, 10.0),
            "gemini-2.5-pro": (1.25, 10.0),
            "gemini-3.5-flash": (0.075, 0.30),
            "grok-3": (3.0, 15.0),
            "grok-3-mini": (0.30, 0.50),
            "deepseek-chat": (0.27, 1.10),
            "deepseek-reasoner": (0.55, 2.19),
            "mistral-large-2": (2.0, 6.0),
            "codestral": (0.30, 0.90),
        }
        row = PRICE_TABLE.get(model)
        if not row:
            return 0.0
        in_price, out_price = row
        return (input_tokens * in_price + output_tokens * out_price) / 1_000_000

    @staticmethod
    def tool_to_openai(t: ToolDef) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            },
        }

    @staticmethod
    def messages_to_openai(messages: list[Message]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in messages:
            entry: dict[str, Any] = {"role": m.role.value, "content": m.content}
            if m.name:
                entry["name"] = m.name
            if m.tool_call_id:
                entry["tool_call_id"] = m.tool_call_id
            if m.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                        },
                    }
                    for tc in m.tool_calls
                ]
            out.append(entry)
        return out


# ─────────────────────────────────────────────────────────────────────────────
# Token estimation (rough; never required by callers)
# ─────────────────────────────────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """A very rough 4-chars-per-token estimator. Used for budget caps only."""
    if not text:
        return 0
    return max(1, len(text) // 4)
