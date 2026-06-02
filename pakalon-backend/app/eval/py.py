"""Python eval runner."""
from __future__ import annotations

import asyncio
import sys
import uuid
from typing import Any

from .types import EvalLanguage, EvalResult


class PyEval:
    async def run(
        self,
        code: str,
        *,
        timeout: float = 10.0,
        env: dict | None = None,
        stdin: str = "",
        workdir: str = "/tmp",
    ) -> EvalResult:
        path = f"{workdir}/pakalon_{uuid.uuid4().hex[:10]}.py"
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE if stdin else None,
                env=env,
            )
        except Exception as e:
            return EvalResult(
                id="", language=EvalLanguage.PYTHON, code=code,
                stdout="", stderr=str(e), exit_code=-1, duration=0.0,
            )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(stdin.encode("utf-8") if stdin else None),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            return EvalResult(
                id="", language=EvalLanguage.PYTHON, code=code,
                stdout="", stderr="timeout", exit_code=-1, duration=timeout,
            )
        return EvalResult(
            id="", language=EvalLanguage.PYTHON, code=code,
            stdout=out.decode("utf-8", "replace"),
            stderr=err.decode("utf-8", "replace"),
            exit_code=proc.returncode or 0, duration=0.0,
        )
