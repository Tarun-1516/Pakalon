"""Hindsight service: orchestrates banks, mental models, transcript, state."""
from __future__ import annotations

import time
from typing import Sequence

from app.mnemopi.bank import MemoryBank, MemoryItem
from app.mnemopi.service import MnemopiService

from .bank import HindsightBank, HindsightEntry
from .mental_models import MentalModel, MentalModelStore
from .transcript import TranscriptBuffer, TranscriptEvent, EventKind
from .state import HindsightState, HindsightStateStore


class HindsightService:
    """High-level API combining mnemopi with hindsight index/state."""

    def __init__(
        self,
        mnemopi: MnemopiService,
        bank: HindsightBank,
        models: MentalModelStore,
        transcript: TranscriptBuffer,
        state: HindsightStateStore,
    ) -> None:
        self.mnemopi = mnemopi
        self.bank = bank
        self.models = models
        self.transcript = transcript
        self.state = state

    # ---- memory ----
    async def remember(
        self,
        content: str,
        *,
        bank: str = "global",
        scope_id: str = "",
        tags: Sequence[str] = (),
        pinned: bool = False,
    ) -> tuple[MemoryItem, HindsightEntry]:
        item = await self.mnemopi.remember(
            content, tags=tags, scope=bank, scope_id=scope_id, pinned=pinned
        )
        entry = await self.bank.add(bank, scope_id, item.id)
        return item, entry

    async def recall(
        self,
        query: str,
        *,
        k: int = 5,
        bank: str | None = None,
        scope_id: str | None = None,
    ) -> list[tuple[MemoryItem, float]]:
        return await self.mnemopi.recall(
            query, k=k, scope=bank, scope_id=scope_id
        )

    # ---- transcript ----
    async def log(
        self,
        session_id: str,
        kind: EventKind,
        payload: str,
    ) -> TranscriptEvent:
        return await self.transcript.append(session_id, kind, payload)

    async def transcript(self, session_id: str, n: int = 50) -> list[TranscriptEvent]:
        return await self.transcript.load(session_id, limit=n)

    # ---- state ----
    async def get_state(self, session_id: str) -> HindsightState:
        return await self.state.get(session_id)

    async def set_focus(self, session_id: str, focus: str) -> HindsightState:
        st = await self.state.get(session_id)
        st.focus = focus
        await self.state.save(st)
        return st

    async def set_summary(self, session_id: str, summary: str) -> HindsightState:
        st = await self.state.get(session_id)
        st.summary = summary
        await self.state.save(st)
        return st

    async def add_todo(self, session_id: str, todo: str) -> HindsightState:
        st = await self.state.get(session_id)
        if todo and todo not in st.todos:
            st.todos.append(todo)
            await self.state.save(st)
        return st

    async def add_open_thread(self, session_id: str, thread: str) -> HindsightState:
        st = await self.state.get(session_id)
        if thread and thread not in st.open_threads:
            st.open_threads.append(thread)
            await self.state.save(st)
        return st

    # ---- mental models ----
    async def synthesize_model(
        self,
        name: str,
        description: str,
        memory_ids: Sequence[str],
        confidence: float = 0.6,
    ) -> MentalModel:
        return await self.models.upsert(
            name=name, description=description,
            memory_ids=memory_ids, confidence=confidence,
        )

    async def list_models(self) -> list[MentalModel]:
        return await self.models.list_models()


def build_default_service(mnemopi: MnemopiService) -> HindsightService:
    return HindsightService(
        mnemopi=mnemopi,
        bank=HindsightBank(mnemopi.bank),
        models=MentalModelStore(),
        transcript=TranscriptBuffer(),
        state=HindsightStateStore(),
    )
