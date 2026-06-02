"""Worktree router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .manager import WorktreeManager, get_manager

router = APIRouter(prefix="/worktree", tags=["worktree"])


def manager() -> WorktreeManager:
    return get_manager()


class InitRequest(BaseModel):
    repo: str
    task_id: str
    base: str = "main"


@router.post("/init")
async def init_worktree(
    body: InitRequest, mgr: WorktreeManager = Depends(manager)
) -> dict[str, Any]:
    wt = await mgr.init_for_task(body.repo, body.task_id, base=body.base)
    return wt.to_dict()


@router.get("/list")
async def list_worktrees(mgr: WorktreeManager = Depends(manager)) -> list[dict[str, Any]]:
    return mgr.list()


@router.get("/repo/{repo:path}")
async def list_repo_worktrees(
    repo: str, mgr: WorktreeManager = Depends(manager)
) -> list[dict[str, Any]]:
    return await mgr.list_for_repo(repo)


@router.get("/{wid}/diff")
async def diff_worktree(
    wid: str, mgr: WorktreeManager = Depends(manager)
) -> dict[str, str]:
    try:
        out = await mgr.diff(wid)
    except KeyError:
        raise HTTPException(status_code=404, detail="no such worktree")
    return {"diff": out}


@router.post("/{wid}/merge")
async def merge_worktree(
    wid: str, mgr: WorktreeManager = Depends(manager)
) -> dict[str, str]:
    try:
        msg = await mgr.merge(wid)
    except KeyError:
        raise HTTPException(status_code=404, detail="no such worktree")
    return {"merged": msg}


@router.post("/{wid}/cleanup")
async def cleanup_worktree(
    wid: str, force: bool = False, mgr: WorktreeManager = Depends(manager)
) -> dict[str, bool]:
    await mgr.cleanup(wid, force=force)
    return {"cleaned": True}


@router.get("/{wid}/status")
async def worktree_status(
    wid: str, mgr: WorktreeManager = Depends(manager)
) -> dict[str, Any]:
    s = await mgr.status(wid)
    if not s:
        raise HTTPException(status_code=404, detail="no such worktree")
    return s
