"""Ultrathink mode: deeper reasoning + verification pipeline."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from .registry import ModeRegistry, AgentMode, ModeMetadata


@dataclass(slots=True)
class UltrathinkStep:
    label: str
    output: str
    duration: float


@dataclass(slots=True)
class UltrathinkTrace:
    id: str
    question: str
    steps: list[UltrathinkStep] = field(default_factory=list)
    final: str = ""
    started_at: float = 0.0
    ended_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "question": self.question, "final": self.final,
            "steps": [{"label": s.label, "output": s.output, "duration": s.duration} for s in self.steps],
            "started_at": self.started_at, "ended_at": self.ended_at,
            "duration": (self.ended_at - self.started_at) if self.ended_at else 0.0,
        }


class UltrathinkMode:
    """Implements a multi-step reasoning loop:

    1. Re-state the question
    2. Identify unknowns
    3. Plan steps
    4. Execute (delegated to caller-supplied LLM hook)
    5. Verify
    6. Reflect
    """

    def __init__(self, *, llm_hook=None) -> None:
        self.llm_hook = llm_hook
        self._registry = ModeRegistry()
        self._registry.register(
            AgentMode.ULTRATHINK,
            ModeMetadata(
                name=AgentMode.ULTRATHINK, label="Ultrathink",
                description="Deep reasoning with verification",
                allowed_tools=["*"], max_steps=1000,
            ),
            handler=self.run,
        )

    @property
    def registry(self) -> ModeRegistry:
        return self._registry

    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        question = (payload.get("question") or payload.get("prompt") or "").strip()
        trace = UltrathinkTrace(
            id=f"ut_{uuid.uuid4().hex[:12]}", question=question,
            started_at=time.time(),
        )
        # 1. Restate
        t0 = time.time()
        restate = await self._step("restate", f"Restating: {question}")
        trace.steps.append(UltrathinkStep("restate", restate, time.time() - t0))
        # 2. Unknowns
        t0 = time.time()
        unknowns = await self._step(
            "unknowns",
            f"Identify unknowns relevant to: {question}\n- assumptions\n- data needed\n- definitions",
        )
        trace.steps.append(UltrathinkStep("unknowns", unknowns, time.time() - t0))
        # 3. Plan
        t0 = time.time()
        plan = await self._step("plan", f"Plan steps to answer: {question}")
        trace.steps.append(UltrathinkStep("plan", plan, time.time() - t0))
        # 4. Execute (placeholder: ask LLM for a draft)
        t0 = time.time()
        exec_out = await self._step("execute", f"Execute the plan for: {question}")
        trace.steps.append(UltrathinkStep("execute", exec_out, time.time() - t0))
        # 5. Verify
        t0 = time.time()
        verify = await self._step("verify", "Critique and check the answer")
        trace.steps.append(UltrathinkStep("verify", verify, time.time() - t0))
        # 6. Reflect
        t0 = time.time()
        reflect = await self._step("reflect", "Reflect on lessons learned")
        trace.steps.append(UltrathinkStep("reflect", reflect, time.time() - t0))

        trace.final = exec_out
        trace.ended_at = time.time()
        return trace.to_dict()

    async def _step(self, label: str, prompt: str) -> str:
        if self.llm_hook is None:
            return f"[{label}] (no LLM hook; would call: {prompt[:200]})"
        try:
            return await self.llm_hook(prompt)
        except Exception as e:
            return f"[{label}] LLM error: {e}"


def get_default() -> UltrathinkMode:
    return UltrathinkMode()
