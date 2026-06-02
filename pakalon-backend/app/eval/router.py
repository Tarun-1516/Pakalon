"""Eval router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .runner import EvalRunner, EvalLanguage

router = APIRouter(prefix="/eval", tags=["eval"])
_runner = EvalRunner()


class RunRequest(BaseModel):
    code: str
    language: EvalLanguage = EvalLanguage.PYTHON
    timeout: float = 10.0
    stdin: str = ""
    env: dict[str, str] = Field(default_factory=dict)


@router.post("/run")
async def run(body: RunRequest) -> dict[str, Any]:
    res = await _runner.run(
        body.code, language=body.language,
        timeout=body.timeout, stdin=body.stdin, env=body.env or None,
    )
    return res.to_dict()
