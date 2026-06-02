"""Compaction router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .branch_summarization import BranchCompactor, CompactionResult

router = APIRouter(prefix="/compaction", tags=["compaction"])


class Event(BaseModel):
    kind: str = "event"
    payload: str = ""


class CompactRequest(BaseModel):
    branch_id: str
    events: list[Event] = Field(default_factory=list)
    max_chars: int = 4000


@router.post("/branch")
async def compact_branch(body: CompactRequest) -> dict[str, Any]:
    compactor = BranchCompactor()
    result: CompactionResult = await compactor.compact(
        body.branch_id,
        (e.model_dump() for e in body.events),
        max_chars=body.max_chars,
    )
    return {
        "branch_id": result.branch_id,
        "summary": result.summary,
        "original_chars": result.original_chars,
        "summary_chars": result.summary_chars,
        "ratio": result.ratio,
        "events_compacted": result.events_compacted,
    }
