"""Additive eval endpoints.

Additive on top of the existing :mod:`app.eval.router`.  Adds:

  POST /eval/v2/suite        — run a directory of test files
  POST /eval/v2/regression   — compare two runs for regression
  GET  /eval/v2/history      — list past runs (in-memory, last 200)
  GET  /eval/v2/history/{id} — get a specific past run
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Deque, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .router import RunRequest
from .runner import EvalRunner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/eval/v2", tags=["eval_v2"])


# ─── In-memory run history (last 200) ───────────────────────────────────────

@dataclass
class HistoricalRun:
    id: str
    ts: float
    language: str
    duration_ms: int
    exit_code: int
    passed: bool
    stdout_excerpt: str


_RUNS: Deque[HistoricalRun] = deque(maxlen=200)


# ─── Pydantic schemas ────────────────────────────────────────────────────────

class SuiteFile(BaseModel):
    name: str
    language: str = "python"
    code: str
    stdin: str = ""
    timeout: float = 10.0


class SuiteRequest(BaseModel):
    files: list[SuiteFile] = Field(default_factory=list)
    parallel: bool = True
    max_concurrency: int = 4
    fail_fast: bool = False


class SuiteResult(BaseModel):
    total: int
    passed: int
    failed: int
    duration_ms: int
    results: list[dict[str, Any]]


class RegressionRequest(BaseModel):
    baseline_run_id: str
    candidate_run_id: str


class RegressionDiff(BaseModel):
    baseline: dict[str, Any]
    candidate: dict[str, Any]
    regressions: list[str]
    improvements: list[str]
    passed: bool


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/suite", response_model=SuiteResult)
async def run_suite(body: SuiteRequest) -> SuiteResult:
    runner = EvalRunner()
    started = time.perf_counter()
    sem = asyncio.Semaphore(body.max_concurrency)

    async def _one(f: SuiteFile) -> dict[str, Any]:
        async with sem:
            t0 = time.perf_counter()
            try:
                res = await runner.run(
                    f.code, language=f.language,
                    timeout=f.timeout, stdin=f.stdin,
                )
                ok = res.exit_code == 0 and not res.error
                _RUNS.append(HistoricalRun(
                    id=f"run_{uuid.uuid4().hex[:12]}",
                    ts=time.time(),
                    language=f.language,
                    duration_ms=int((time.perf_counter() - t0) * 1000),
                    exit_code=res.exit_code,
                    passed=ok,
                    stdout_excerpt=res.stdout[-500:] if res.stdout else "",
                ))
                return {"name": f.name, "passed": ok,
                        "exit_code": res.exit_code,
                        "stdout": res.stdout[-1000:],
                        "stderr": res.stderr[-500:],
                        "duration_ms": int((time.perf_counter() - t0) * 1000)}
            except Exception as e:  # pragma: no cover
                return {"name": f.name, "passed": False, "error": str(e),
                        "duration_ms": int((time.perf_counter() - t0) * 1000)}

    if body.parallel:
        results = await asyncio.gather(*[_one(f) for f in body.files])
    else:
        results = []
        for f in body.files:
            r = await _one(f)
            results.append(r)
            if body.fail_fast and not r.get("passed"):
                break
    passed = sum(1 for r in results if r.get("passed"))
    return SuiteResult(
        total=len(results),
        passed=passed,
        failed=len(results) - passed,
        duration_ms=int((time.perf_counter() - started) * 1000),
        results=results,
    )


@router.post("/regression", response_model=RegressionDiff)
async def regression(body: RegressionRequest) -> RegressionDiff:
    by_id = {r.id: r for r in _RUNS}
    base = by_id.get(body.baseline_run_id)
    cand = by_id.get(body.candidate_run_id)
    if not base or not cand:
        raise HTTPException(status_code=404, detail="unknown run id")

    regressions: list[str] = []
    improvements: list[str] = []
    if base.passed and not cand.passed:
        regressions.append(f"test passed in baseline but failed in candidate")
    if not base.passed and cand.passed:
        improvements.append(f"test failed in baseline but now passes")
    if cand.duration_ms > base.duration_ms * 1.5:
        regressions.append(
            f"candidate is {cand.duration_ms / max(base.duration_ms, 1):.1f}× slower"
        )
    if cand.duration_ms < base.duration_ms * 0.5:
        improvements.append(
            f"candidate is {cand.duration_ms / max(base.duration_ms, 1):.1f}× faster"
        )
    return RegressionDiff(
        baseline=asdict(base), candidate=asdict(cand),
        regressions=regressions, improvements=improvements,
        passed=not regressions,
    )


@router.get("/history")
async def history(limit: int = 50) -> list[dict[str, Any]]:
    return [asdict(r) for r in list(_RUNS)[-limit:]]


@router.get("/history/{run_id}")
async def history_one(run_id: str) -> dict[str, Any]:
    for r in _RUNS:
        if r.id == run_id:
            return asdict(r)
    raise HTTPException(status_code=404, detail="unknown run")
