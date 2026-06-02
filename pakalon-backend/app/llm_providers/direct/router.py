"""Router for the direct provider implementations.

Endpoints (additive — the existing ``/llm_providers`` router is unchanged):

  GET  /direct/providers                              — list registered provider ids
  POST /direct/{provider_id}/chat                    — single-shot chat
  POST /direct/{provider_id}/stream                  — SSE stream
  POST /direct/embed                                 — embed texts
  POST /direct/oauth/{provider}/start                — start an OAuth flow
  GET  /direct/oauth/{flow_id}/poll                  — poll / complete an OAuth flow
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, HTTPException, Path
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .base import (
    ChatRequest,
    DirectError,
    Message,
    Role,
    ToolDef,
    get_provider,
    list_provider_ids,
)
from .embeddings import get_embedder, list_embedders
from .oauth import (
    OAuthError,
    OAuthFlow,
    complete_flow,
    load_flow,
    save_flow,
    start_github_copilot,
    start_openai_codex,
    start_cursor,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/direct", tags=["llm_providers_direct"])


# ─── Pydantic schemas (decoupled from internal dataclasses) ────────────────

class ToolDefSchema(BaseModel):
    name: str
    description: str
    input_schema: dict[str, Any] = Field(default_factory=dict)


class MessageSchema(BaseModel):
    role: str
    content: str
    name: Optional[str] = None
    tool_call_id: Optional[str] = None


class ChatRequestSchema(BaseModel):
    model: Optional[str] = None
    messages: list[MessageSchema]
    max_tokens: int = 1024
    temperature: float = 0.7
    top_p: float = 1.0
    stop: list[str] = Field(default_factory=list)
    tools: list[ToolDefSchema] = Field(default_factory=list)
    tool_choice: Optional[str] = None
    extra: dict[str, Any] = Field(default_factory=dict)
    api_key: Optional[str] = None


class EmbedRequestSchema(BaseModel):
    texts: list[str]
    provider: Optional[str] = None


class OAuthStartSchema(BaseModel):
    github_token: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None


def _to_chat_request(s: ChatRequestSchema) -> ChatRequest:
    return ChatRequest(
        model=s.model or "",
        messages=[Message(role=Role(m.role), content=m.content,
                          name=m.name, tool_call_id=m.tool_call_id)
                  for m in s.messages],
        max_tokens=s.max_tokens, temperature=s.temperature, top_p=s.top_p,
        stop=list(s.stop),
        tools=[ToolDef(name=t.name, description=t.description, input_schema=t.input_schema)
               for t in s.tools],
        tool_choice=s.tool_choice, extra=dict(s.extra),
    )


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/providers")
async def list_providers() -> dict[str, Any]:
    return {
        "providers": list_provider_ids(),
        "embedders": list_embedders(),
        "ts": int(time.time()),
    }


@router.post("/{provider_id}/chat")
async def chat(provider_id: str, body: ChatRequestSchema) -> dict[str, Any]:
    try:
        prov = get_provider(provider_id, api_key=body.api_key)
        req = _to_chat_request(body)
        resp = await prov.chat(req, api_key=body.api_key)
    except DirectError as e:
        raise HTTPException(status_code=e.status or 502, detail=str(e))
    return {
        "id": resp.id, "model": resp.model, "content": resp.content,
        "tool_calls": [{"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                       for tc in resp.tool_calls],
        "finish_reason": resp.finish_reason,
        "usage": {
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
            "cost_usd": resp.usage.cost_usd,
            "cached_input_tokens": resp.usage.cached_input_tokens,
        },
        "raw": resp.raw,
    }


@router.post("/{provider_id}/stream")
async def stream(provider_id: str, body: ChatRequestSchema) -> StreamingResponse:
    try:
        prov = get_provider(provider_id, api_key=body.api_key)
        req = _to_chat_request(body)
    except DirectError as e:
        raise HTTPException(status_code=e.status or 502, detail=str(e))

    async def _gen() -> AsyncIterator[bytes]:
        try:
            async for chunk in prov.stream(req, api_key=body.api_key):
                payload = {
                    "delta": chunk.delta,
                    "tool_call_delta": (
                        {"id": chunk.tool_call_delta.id,
                         "name": chunk.tool_call_delta.name,
                         "arguments": chunk.tool_call_delta.arguments}
                        if chunk.tool_call_delta else None
                    ),
                    "finish_reason": chunk.finish_reason,
                }
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")
            yield b"data: [DONE]\n\n"
        except DirectError as e:
            err = json.dumps({"error": str(e), "status": e.status}).encode("utf-8")
            yield f"data: {err}\n\n".encode("utf-8")

    return StreamingResponse(_gen(), media_type="text/event-stream")


@router.post("/embed")
async def embed(body: EmbedRequestSchema) -> dict[str, Any]:
    if not body.texts:
        return {"embeddings": [], "provider": body.provider or "default"}
    try:
        prov = get_embedder(body.provider)
        vecs = await prov.embed_batch(body.texts)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"embed failed: {e!s}")
    return {
        "provider": prov.id,
        "dimensions": getattr(prov, "dimensions", len(vecs[0]) if vecs else 0),
        "embeddings": vecs,
    }


# ─── OAuth endpoints ────────────────────────────────────────────────────────

@router.post("/oauth/{provider}/start")
async def oauth_start(provider: str, body: OAuthStartSchema) -> dict[str, Any]:
    try:
        if provider == "github_copilot":
            if not body.github_token:
                raise OAuthError("github_token is required")
            flow = await start_github_copilot(body.github_token)
        elif provider == "openai_codex":
            flow = await start_openai_codex()
        elif provider == "cursor":
            if not (body.email and body.password):
                raise OAuthError("email and password are required")
            flow = await start_cursor(body.email, body.password)
        else:
            raise OAuthError(f"unknown oauth provider: {provider}")
    except OAuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    save_flow(flow)
    return {
        "flow_id": flow.flow_id,
        "provider": flow.provider,
        "user_code": flow.user_code,
        "verification_url": flow.verification_url,
        "interval_s": flow.interval_s,
        "expires_at": flow.expires_at,
        "completed": flow.completed,
    }


@router.get("/oauth/{flow_id}/poll")
async def oauth_poll(flow_id: str) -> dict[str, Any]:
    flow = load_flow(flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="unknown flow")
    flow = await complete_flow(flow_id)
    return {
        "flow_id": flow.flow_id,
        "provider": flow.provider,
        "completed": flow.completed,
        "error": flow.error,
        "has_api_key": bool(flow.api_key),
    }
