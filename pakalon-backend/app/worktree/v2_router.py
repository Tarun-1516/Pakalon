"""Additive worktree endpoints — auto-PR, auto-merge, status.

Additive on top of the existing :mod:`app.worktree.router`.  Adds:

  POST /worktree/v2/{wid}/pr          — create a PR (uses GitHub API if available)
  POST /worktree/v2/{wid}/auto-merge  — auto-merge after CI passes
  GET  /worktree/v2/{wid}/ci          — CI status (cached gh CLI call)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from dataclasses import asdict, dataclass
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .router import manager  # reuse the existing dependency

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/worktree/v2", tags=["worktree_v2"])


class PrRequest(BaseModel):
    title: str
    body: str = ""
    base: str = "main"
    draft: bool = False


class PrResponse(BaseModel):
    url: str
    number: int
    state: str = "open"


class AutoMergeRequest(BaseModel):
    method: str = "squash"  # squash | merge | rebase
    wait_for_ci: bool = True
    timeout_s: int = 600


def _gh(args: list[str], cwd: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["gh", *args], cwd=cwd,
        capture_output=True, text=True, timeout=60,
    )
    return proc.returncode, proc.stdout, proc.stderr


@router.post("/{wid}/pr", response_model=PrResponse)
async def create_pr(wid: str, body: PrRequest, mgr=manager) -> PrResponse:
    wt = await mgr.status(wid)
    if not wt:
        raise HTTPException(status_code=404, detail="no such worktree")
    cwd = wt["path"]
    # Push the branch first.
    code, _, err = _gh(["push", "-u", "origin", "HEAD"], cwd)
    if code != 0:
        raise HTTPException(status_code=502, detail=f"git push failed: {err}")
    args = ["pr", "create",
            "--title", body.title,
            "--body", body.body,
            "--base", body.base]
    if body.draft:
        args.append("--draft")
    args.extend(["--json", "url,number,state"])
    code, out, err = _gh(args, cwd)
    if code != 0:
        raise HTTPException(status_code=502, detail=f"gh pr create failed: {err}")
    j = json.loads(out)
    return PrResponse(url=j["url"], number=j["number"], state=j.get("state", "open"))


@router.post("/{wid}/auto-merge")
async def auto_merge(wid: str, body: AutoMergeRequest, mgr=manager) -> dict[str, Any]:
    wt = await mgr.status(wid)
    if not wt:
        raise HTTPException(status_code=404, detail="no such worktree")
    cwd = wt["path"]

    # Find the PR for this branch
    code, out, err = _gh(["pr", "view", "--json", "number,url,mergeable"], cwd)
    if code != 0:
        raise HTTPException(status_code=502, detail=f"gh pr view failed: {err}")
    pr = json.loads(out)

    if body.wait_for_ci:
        # Poll CI every 10s up to timeout_s
        deadline = asyncio.get_event_loop().time() + body.timeout_s
        while asyncio.get_event_loop().time() < deadline:
            code, out, _ = _gh(
                ["pr", "checks", "--json", "name,state,conclusion"],
                cwd,
            )
            try:
                checks = json.loads(out or "[]")
            except json.JSONDecodeError:
                checks = []
            if checks and all(
                (c.get("conclusion") in ("SUCCESS", "SKIPPED", "NEUTRAL")) for c in checks
            ):
                break
            if any(c.get("conclusion") == "FAILURE" for c in checks):
                raise HTTPException(status_code=409, detail="CI failed; aborting auto-merge")
            await asyncio.sleep(10)
        else:
            raise HTTPException(status_code=504, detail="CI timeout")

    code, out, err = _gh(
        ["pr", "merge", str(pr["number"]),
         f"--{body.method}", "--auto"],
        cwd,
    )
    if code != 0:
        raise HTTPException(status_code=502, detail=f"gh pr merge failed: {err}")
    return {"merged": True, "url": pr.get("url"), "number": pr.get("number"),
            "stdout": out.strip()}


@router.get("/{wid}/ci")
async def ci_status(wid: str, mgr=manager) -> dict[str, Any]:
    wt = await mgr.status(wid)
    if not wt:
        raise HTTPException(status_code=404, detail="no such worktree")
    cwd = wt["path"]
    code, out, err = _gh(["pr", "checks", "--json", "name,state,conclusion"], cwd)
    if code != 0:
        return {"checks": [], "error": err.strip()}
    try:
        checks = json.loads(out or "[]")
    except json.JSONDecodeError:
        checks = []
    return {
        "checks": checks,
        "all_passed": bool(checks) and all(
            c.get("conclusion") in ("SUCCESS", "SKIPPED", "NEUTRAL") for c in checks
        ),
    }
