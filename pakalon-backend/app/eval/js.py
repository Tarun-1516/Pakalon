"""JS eval runner (Node / Deno / Bun)."""
from __future__ import annotations

import asyncio
import shutil
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from .types import EvalLanguage, EvalResult


class JSEval:
    def __init__(self, engine: str = "auto") -> None:
        self.engine = engine

    def _pick(self) -> str:
        if self.engine in ("node", "deno", "bun"):
            return self.engine
        for cmd in ("node", "deno", "bun"):
            if shutil.which(cmd):
                return cmd
        return "node"

    async def run(
        self,
        code: str,
        *,
        timeout: float = 10.0,
        env: dict | None = None,
        stdin: str = "",
        workdir: str = "/tmp",
    ) -> EvalResult:
        engine = self._pick()
        path = f"{workdir}/pakalon_{uuid.uuid4().hex[:10]}.js"
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        cmd = [engine, path]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE if stdin else None,
                env=env,
            )
        except FileNotFoundError as e:
            return EvalResult(
                id="", language=EvalLanguage.JAVASCRIPT, code=code,
                stdout="", stderr=f"engine not found: {e}",
                exit_code=-1, duration=0.0,
            )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(stdin.encode("utf-8") if stdin else None),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            return EvalResult(
                id="", language=EvalLanguage.JAVASCRIPT, code=code,
                stdout="", stderr="timeout", exit_code=-1, duration=timeout,
            )
        return EvalResult(
            id="", language=EvalLanguage.JAVASCRIPT, code=code,
            stdout=out.decode("utf-8", "replace"),
            stderr=err.decode("utf-8", "replace"),
            exit_code=proc.returncode or 0, duration=0.0,
        )
