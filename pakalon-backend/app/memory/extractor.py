"""LLM-driven memory extraction.

Uses the direct provider layer (:mod:`app.llm_providers.direct`) to
extract structured memories from a chunk of text.  This is the
"remember" half of the retain/recall/reflect loop — the agent
ingests text (a transcript, a doc, a tool result) and we ask an
LLM to extract the durable facts worth remembering.

Additive on top of the existing :mod:`app.hindsight` service: the
service still owns the bank index and the persistence; this module
just produces the *content* it stores.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from app.llm_providers.direct.base import (
    ChatRequest, Message, Role, ToolDef,
)
from app.llm_providers.direct import get_provider

logger = logging.getLogger(__name__)


EXTRACTION_TOOL = ToolDef(
    name="record_memory",
    description=(
        "Persist a single fact to long-term memory. Call once per "
        "durable fact worth keeping. Do NOT call for transient state, "
        "in-conversation summaries, or anything the user told you to "
        "forget."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "Atomic, self-contained fact. Phrased as if telling a future agent with no prior context.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Short topic tags (e.g. ['cli', 'auth', 'preference']).",
            },
            "importance": {
                "type": "number",
                "minimum": 0.0, "maximum": 1.0,
                "description": "0 = trivial, 1 = identity-defining. Default 0.5.",
            },
        },
        "required": ["content", "tags", "importance"],
        "additionalProperties": False,
    },
)


@dataclass(slots=True)
class ExtractedMemory:
    id: str
    content: str
    tags: list[str]
    importance: float
    raw: dict[str, Any] = field(default_factory=dict)


def _parse_tool_call(resp) -> Optional[ExtractedMemory]:
    if not resp.tool_calls:
        return None
    tc = resp.tool_calls[0]
    args = tc.arguments or {}
    content = (args.get("content") or "").strip()
    if not content:
        return None
    return ExtractedMemory(
        id=f"mem_{uuid.uuid4().hex[:16]}",
        content=content,
        tags=list(args.get("tags") or []),
        importance=float(args.get("importance") or 0.5),
    )


async def extract_memories(
    text: str,
    *,
    model: str = "gpt-4o-mini",
    provider_id: str = "openai",
    max_facts: int = 12,
    context_hint: str = "",
    api_key: Optional[str] = None,
) -> list[ExtractedMemory]:
    """Run the LLM extractor over ``text`` and return the durable facts."""
    if not text or not text.strip():
        return []
    try:
        prov = get_provider(provider_id, api_key=api_key)
    except Exception as e:
        logger.warning("LLM extractor: provider %r unavailable (%s); skipping", provider_id, e)
        return []
    sys = (
        "You are a memory-extraction agent. Given a chunk of text, "
        "identify every durable fact worth remembering for future sessions. "
        "For each fact, call `record_memory` exactly once. "
        "Skip transient state, session-local details, and anything the user "
        "asked to forget. At most " + str(max_facts) + " facts."
    )
    if context_hint:
        sys += "\n\nContext for this extraction: " + context_hint
    req = ChatRequest(
        model=model,
        messages=[Message(role=Role.SYSTEM, content=sys),
                  Message(role=Role.USER, content=text[:32_000])],
        max_tokens=2048, temperature=0.0,
        tools=[EXTRACTION_TOOL], tool_choice="auto",
    )
    try:
        resp = await prov.chat(req, api_key=api_key)
    except Exception as e:
        logger.warning("LLM extractor chat failed: %s", e)
        return []
    mem = _parse_tool_call(resp)
    return [mem] if mem else []


async def extract_memories_batch(
    texts: list[str],
    *,
    model: str = "gpt-4o-mini",
    provider_id: str = "openai",
    max_concurrency: int = 4,
) -> list[ExtractedMemory]:
    """Run the extractor in parallel across a batch of texts."""
    import asyncio
    sem = asyncio.Semaphore(max_concurrency)

    async def _one(t: str) -> list[ExtractedMemory]:
        async with sem:
            return await extract_memories(t, model=model, provider_id=provider_id)

    results = await asyncio.gather(*[_one(t) for t in texts])
    return [m for batch in results for m in batch]


# ─── Reflect: summarise the recalled memories into a coherent brief ───────

async def reflect_on_memories(
    query: str,
    memories: list[str],
    *,
    model: str = "gpt-4o",
    provider_id: str = "openai",
    api_key: Optional[str] = None,
) -> str:
    """Ask the LLM to synthesise a brief reflecting on the recalled facts."""
    if not memories:
        return ""
    try:
        prov = get_provider(provider_id, api_key=api_key)
    except Exception as e:
        return "\n".join(f"• {m}" for m in memories)
    sys = (
        "You are a reflection agent. Given a user query and a list of "
        "previously-stored memories, synthesise a brief that the calling "
        "agent can use as context. Be terse. Surface contradictions. "
        "Quote the most relevant fact verbatim when appropriate."
    )
    user = (
        f"Query: {query}\n\n"
        f"Memories:\n" + "\n".join(f"- {m}" for m in memories[:50])
    )
    req = ChatRequest(
        model=model, max_tokens=800, temperature=0.2,
        messages=[Message(role=Role.SYSTEM, content=sys),
                  Message(role=Role.USER, content=user)],
    )
    try:
        resp = await prov.chat(req, api_key=api_key)
        return resp.content
    except Exception as e:
        logger.warning("reflect failed: %s", e)
        return "\n".join(f"• {m}" for m in memories)
