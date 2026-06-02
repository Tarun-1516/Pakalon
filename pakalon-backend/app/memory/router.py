"""FastAPI router for the additive memory layer.

Endpoints (additive on top of :mod:`app.hindsight.router`):

  POST /memory/retain          — extract facts from text + store them
  POST /memory/recall          — embed query + cosine search the vector store
  POST /memory/reflect         — synthesise a brief from recalled facts
  POST /memory/dream           — background consolidation hook
  GET  /memory/vector/health   — which vector store is active + counts
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .extractor import (
    extract_memories,
    extract_memories_batch,
    reflect_on_memories,
)
from .vector_store import (
    add_texts, get_store, search_text,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/memory", tags=["memory"])


# ─── Schemas ────────────────────────────────────────────────────────────────

class RetainRequest(BaseModel):
    text: str
    model: str = "gpt-4o-mini"
    provider: str = "openai"
    bank: str = "global"            # forward-compat; ignored here, passed in
                                   # via headers/x-pakalon-bank to the parent
                                   # /hindsight/remember endpoint if needed
    context_hint: str = ""
    max_facts: int = 12
    api_key: Optional[str] = None


class ExtractedMemoryOut(BaseModel):
    id: str
    content: str
    tags: list[str]
    importance: float


class RetainResponse(BaseModel):
    stored: list[ExtractedMemoryOut]
    elapsed_ms: int


class RecallRequest(BaseModel):
    query: str
    top_k: int = 8
    filter: Optional[dict[str, Any]] = None
    provider: Optional[str] = None


class HitOut(BaseModel):
    id: str
    score: float
    metadata: dict[str, Any]
    document: Optional[str] = None


class ReflectRequest(BaseModel):
    query: str
    top_k: int = 12
    model: str = "gpt-4o"
    provider: str = "openai"
    api_key: Optional[str] = None


class ReflectResponse(BaseModel):
    brief: str
    hits: list[HitOut]


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/retain", response_model=RetainResponse)
async def retain(body: RetainRequest) -> RetainResponse:
    t0 = time.perf_counter()
    mems = await extract_memories(
        body.text, model=body.model, provider_id=body.provider,
        max_facts=body.max_facts, context_hint=body.context_hint,
        api_key=body.api_key,
    )
    if mems:
        await add_texts(
            [m.content for m in mems],
            metadatas=[{"tags": m.tags, "importance": m.importance,
                        "bank": body.bank, "ts": time.time()} for m in mems],
        )
    return RetainResponse(
        stored=[
            ExtractedMemoryOut(id=m.id, content=m.content,
                                tags=m.tags, importance=m.importance)
            for m in mems
        ],
        elapsed_ms=int((time.perf_counter() - t0) * 1000),
    )


@router.post("/recall")
async def recall(body: RecallRequest) -> dict[str, Any]:
    hits = await search_text(body.query, top_k=body.top_k, filter=body.filter)
    return {
        "hits": [
            {"id": h.id, "score": h.score,
             "metadata": h.metadata, "document": h.document}
            for h in hits
        ],
        "embedder": os.getenv("PAKALON_EMBEDDER", "local"),
    }


@router.post("/reflect", response_model=ReflectResponse)
async def reflect(body: ReflectRequest) -> ReflectResponse:
    hits = await search_text(body.query, top_k=body.top_k)
    docs = [h.document for h in hits if h.document]
    brief = await reflect_on_memories(
        body.query, docs, model=body.model, provider_id=body.provider,
        api_key=body.api_key,
    )
    return ReflectResponse(
        brief=brief,
        hits=[HitOut(id=h.id, score=h.score, metadata=h.metadata,
                     document=h.document) for h in hits],
    )


@router.post("/dream")
async def dream(batch_size: int = 16) -> dict[str, Any]:
    """Lightweight consolidation hook.

    Reads the most recent batch of stored memories, asks the LLM to
    identify duplicates / supersedes chains, and returns a summary
    of what it would consolidate.  In a future iteration this will
    rewrite the bank; for now it returns the candidate operations.
    """
    # We don't keep a separate index of "what was just inserted",
    # so for now this returns an empty plan with the API in place.
    return {
        "status": "ok",
        "consolidated": 0,
        "batch_size": batch_size,
        "note": "dream is a stub; full consolidation lands in v2",
    }


@router.get("/vector/health")
async def vector_health() -> dict[str, Any]:
    kind = os.getenv("PAKALON_VECTOR_STORE", "memory")
    return {"store": kind, "embedder": os.getenv("PAKALON_EMBEDDER", "local"),
            "ok": True, "ts": int(time.time())}
