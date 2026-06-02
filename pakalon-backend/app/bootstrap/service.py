"""Bootstrap service."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class StepStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass(slots=True)
class Step:
    id: str
    title: str
    description: str
    status: StepStatus = StepStatus.PENDING
    error: str = ""
    started_at: float = 0.0
    completed_at: float = 0.0


@dataclass(slots=True)
class BootstrapState:
    id: str
    steps: list[Step] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    completed_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "steps": [
                {
                    "id": s.id, "title": s.title, "description": s.description,
                    "status": s.status.value, "error": s.error,
                    "started_at": s.started_at, "completed_at": s.completed_at,
                }
                for s in self.steps
            ],
            "created_at": self.created_at,
            "completed_at": self.completed_at,
            "progress": self.progress,
        }

    @property
    def progress(self) -> float:
        if not self.steps:
            return 0.0
        done = sum(1 for s in self.steps if s.status in (StepStatus.DONE, StepStatus.SKIPPED))
        return done / len(self.steps)


DEFAULT_STEPS: list[tuple[str, str, str]] = [
    ("env", "Verify environment", "Check Python, DB, env vars"),
    ("db", "Run migrations", "Apply alembic up to head"),
    ("auth", "Initialize auth", "Seed default provider keys"),
    ("providers", "Register providers", "Add OpenAI/Anthropic/etc."),
    ("admin", "Create admin user", "Provision initial superuser"),
    ("smoke", "Smoke test", "Verify health endpoints"),
]


class BootstrapService:
    def __init__(self) -> None:
        self._states: dict[str, BootstrapState] = {}

    def start(self) -> BootstrapState:
        bid = f"boot_{uuid.uuid4().hex[:12]}"
        st = BootstrapState(
            id=bid,
            steps=[Step(id=i, title=t, description=d) for i, t, d in DEFAULT_STEPS],
        )
        self._states[bid] = st
        return st

    def get(self, bid: str) -> BootstrapState | None:
        return self._states.get(bid)

    def set_step(self, bid: str, step_id: str, status: StepStatus, error: str = "") -> bool:
        st = self._states.get(bid)
        if not st:
            return False
        for s in st.steps:
            if s.id == step_id:
                s.status = status
                s.error = error
                if status == StepStatus.RUNNING:
                    s.started_at = time.time()
                elif status in (StepStatus.DONE, StepStatus.FAILED, StepStatus.SKIPPED):
                    s.completed_at = time.time()
                return True
        return False

    def finish(self, bid: str) -> None:
        st = self._states.get(bid)
        if st:
            st.completed_at = time.time()

    def list(self) -> list[BootstrapState]:
        return list(self._states.values())
