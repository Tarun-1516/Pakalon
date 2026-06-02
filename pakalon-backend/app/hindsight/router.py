"""FastAPI router for hindsight."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.mnemopi.service import MnemopiService
from .service import HindsightService, build_default_service

router = APIRouter(prefix="/hindsight", tags=["hindsight"])


def get_service(session: AsyncSession = Depends(get_session)) -> HindsightService:
    mnemopi = MnemopiService(session)
    return build_default_service(mnemopi)


# ---- schemas ----
class RememberRequest(BaseModel):
    content: str
    bank: Literal["global", "project", "branch", "session"] = "global"
    scope_id: str = ""
    tags: list[str] = Field(default_factory=list)
    pinned: bool = False


class RecallRequest(BaseModel):
    query: str
    k: int = 5
    bank: Literal["global", "project", "branch", "session"] | None = None
    scope_id: str | None = None


class MemoryHit(BaseModel):
    id: str
    content: str
    scope: str
    scope_id: str
    score: float


class TranscriptRequest(BaseModel):
    session_id: str
    kind: Literal[
        "user_message", "assistant_message", "tool_call",
        "tool_result", "file_change", "error", "note",
    ]
    payload: str


class TranscriptOut(BaseModel):
    id: str
    session_id: str
    kind: str
    payload: str
    ts: float


class StateOut(BaseModel):
    session_id: str
    focus: str
    summary: str
    todos: list[str]
    open_threads: list[str]
    updated_at: float


class FocusRequest(BaseModel):
    session_id: str
    focus: str


class SummaryRequest(BaseModel):
    session_id: str
    summary: str


class TodoRequest(BaseModel):
    session_id: str
    todo: str


class ThreadRequest(BaseModel):
    session_id: str
    thread: str


class MentalModelRequest(BaseModel):
    name: str
    description: str
    memory_ids: list[str] = Field(default_factory=list)
    confidence: float = 0.5


class MentalModelOut(BaseModel):
    id: str
    name: str
    description: str
    memory_ids: list[str]
    confidence: float


# ---- endpoints ----
@router.post("/remember")
async def remember(
    body: RememberRequest, svc: HindsightService = Depends(get_service)
) -> dict[str, Any]:
    item, entry = await svc.remember(
        body.content, bank=body.bank, scope_id=body.scope_id,
        tags=body.tags, pinned=body.pinned,
    )
    return {"memory_id": item.id, "entry_id": entry.memory_id, "bank": entry.bank}


@router.post("/recall")
async def recall(
    body: RecallRequest, svc: HindsightService = Depends(get_service)
) -> list[MemoryHit]:
    hits = await svc.recall(
        body.query, k=body.k, bank=body.bank, scope_id=body.scope_id
    )
    return [
        MemoryHit(
            id=it.id, content=it.content, scope=it.scope, scope_id=it.scope_id,
            score=score,
        )
        for it, score in hits
    ]


@router.post("/transcript")
async def log_event(
    body: TranscriptRequest, svc: HindsightService = Depends(get_service)
) -> TranscriptOut:
    ev = await svc.log(body.session_id, body.kind, body.payload)
    return TranscriptOut(
        id=ev.id, session_id=ev.session_id,
        kind=ev.kind, payload=ev.payload, ts=ev.ts,
    )


@router.get("/transcript/{session_id}")
async def get_transcript(
    session_id: str, n: int = 50, svc: HindsightService = Depends(get_service)
) -> list[TranscriptOut]:
    events = await svc.transcript(session_id, n=n)
    return [
        TranscriptOut(
            id=e.id, session_id=e.session_id, kind=e.kind,
            payload=e.payload, ts=e.ts,
        )
        for e in events
    ]


@router.get("/state/{session_id}")
async def get_state(
    session_id: str, svc: HindsightService = Depends(get_service)
) -> StateOut:
    st = await svc.get_state(session_id)
    return StateOut(**st.to_dict())


@router.post("/state/focus")
async def set_focus(
    body: FocusRequest, svc: HindsightService = Depends(get_service)
) -> StateOut:
    st = await svc.set_focus(body.session_id, body.focus)
    return StateOut(**st.to_dict())


@router.post("/state/summary")
async def set_summary(
    body: SummaryRequest, svc: HindsightService = Depends(get_service)
) -> StateOut:
    st = await svc.set_summary(body.session_id, body.summary)
    return StateOut(**st.to_dict())


@router.post("/state/todo")
async def add_todo(
    body: TodoRequest, svc: HindsightService = Depends(get_service)
) -> StateOut:
    st = await svc.add_todo(body.session_id, body.todo)
    return StateOut(**st.to_dict())


@router.post("/state/thread")
async def add_thread(
    body: ThreadRequest, svc: HindsightService = Depends(get_service)
) -> StateOut:
    st = await svc.add_open_thread(body.session_id, body.thread)
    return StateOut(**st.to_dict())


@router.post("/mental-model")
async def synthesize_model(
    body: MentalModelRequest, svc: HindsightService = Depends(get_service)
) -> MentalModelOut:
    m = await svc.synthesize_model(
        body.name, body.description, body.memory_ids, body.confidence
    )
    return MentalModelOut(
        id=m.id, name=m.name, description=m.description,
        memory_ids=m.memory_ids, confidence=m.confidence,
    )


@router.get("/mental-models")
async def list_models(
    svc: HindsightService = Depends(get_service),
) -> list[MentalModelOut]:
    models = await svc.list_models()
    return [
        MentalModelOut(
            id=m.id, name=m.name, description=m.description,
            memory_ids=m.memory_ids, confidence=m.confidence,
        )
        for m in models
    ]
