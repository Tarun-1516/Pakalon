"""Eval runner."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .py import PyEval
from .js import JSEval


class EvalLanguage(str, Enum):
    PYTHON = "python"
    JAVASCRIPT = "javascript"
    TYPESCRIPT = "typescript"
    SHELL = "shell"
    DENO = "deno"
    BUN = "bun"


@dataclass(slots=True)
class EvalResult:
    id: str
    language: EvalLanguage
    code: str
    stdout: str
    stderr: str
    exit_code: int
    duration: float
    artifacts: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "language": self.language.value, "code": self.code,
            "stdout": self.stdout, "stderr": self.stderr,
            "exit_code": self.exit_code, "duration": self.duration,
            "artifacts": self.artifacts,
        }


class EvalRunner:
    """Dispatches to language-specific runners."""

    def __init__(self, *, default_timeout: float = 10.0, workdir: str = "/tmp") -> None:
        self.default_timeout = default_timeout
        self.workdir = workdir
        self._runners: dict[EvalLanguage, Any] = {
            EvalLanguage.PYTHON: PyEval(),
            EvalLanguage.JAVASCRIPT: JSEval(),
        }

    def register(self, lang: EvalLanguage, runner: Any) -> None:
        self._runners[lang] = runner

    async def run(
        self,
        code: str,
        *,
        language: EvalLanguage = EvalLanguage.PYTHON,
        timeout: float | None = None,
        env: dict[str, str] | None = None,
        stdin: str = "",
    ) -> EvalResult:
        runner = self._runners.get(language)
        if runner is None:
            return EvalResult(
                id=f"ev_{uuid.uuid4().hex[:12]}", language=language, code=code,
                stdout="", stderr=f"no runner for {language}", exit_code=-1, duration=0.0,
            )
        t0 = time.time()
        try:
            res = await runner.run(
                code, timeout=timeout or self.default_timeout,
                env=env, stdin=stdin, workdir=self.workdir,
            )
        except Exception as e:
            return EvalResult(
                id=f"ev_{uuid.uuid4().hex[:12]}", language=language, code=code,
                stdout="", stderr=f"runner error: {e}", exit_code=-1,
                duration=time.time() - t0,
            )
        res.id = f"ev_{uuid.uuid4().hex[:12]}"
        res.duration = time.time() - t0
        return res
