"""Worktree manager: branches, snapshots, and control plane."""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .adapters import WorktreeAdapter, select_adapter


class WorktreeStatus(str, Enum):
    ACTIVE = "active"
    MERGED = "merged"
    ABANDONED = "abandoned"
    CONFLICT = "conflict"


@dataclass(slots=True)
class Worktree:
    id: str
    repo: str
    branch: str
    path: str
    base: str
    status: WorktreeStatus = WorktreeStatus.ACTIVE
    created_at: float = field(default_factory=time.time)
    merged_at: float = 0.0
    task_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "repo": self.repo,
            "branch": self.branch,
            "path": self.path,
            "base": self.base,
            "status": self.status.value,
            "created_at": self.created_at,
            "merged_at": self.merged_at,
            "task_id": self.task_id,
        }


class WorktreeManager:
    """Control plane: create / list / merge / cleanup worktrees for tasks."""

    def __init__(self, adapter: WorktreeAdapter | None = None) -> None:
        self.adapter: WorktreeAdapter = adapter or select_adapter()
        self._items: dict[str, Worktree] = {}
        self._lock = asyncio.Lock()

    async def init_for_task(
        self,
        repo: str,
        task_id: str,
        base: str = "main",
    ) -> Worktree:
        wid = f"wt_{uuid.uuid4().hex[:12]}"
        branch = f"agent/{task_id}/{wid}"
        path = os.path.join(repo, ".worktrees", wid)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        await self.adapter.create(repo, branch, path, base)
        wt = Worktree(
            id=wid, repo=repo, branch=branch,
            path=path, base=base, task_id=task_id,
        )
        async with self._lock:
            self._items[wid] = wt
        return wt

    async def list_for_repo(self, repo: str) -> list[dict[str, Any]]:
        return await self.adapter.list(repo)

    async def diff(self, wid: str) -> str:
        wt = self._items[wid]
        return await self.adapter.diff(wt.repo, wt.base, wt.branch)

    async def merge(self, wid: str) -> str:
        wt = self._items[wid]
        msg = await self.adapter.merge(wt.repo, wt.branch, wt.base)
        wt.status = WorktreeStatus.MERGED
        wt.merged_at = time.time()
        return msg

    async def cleanup(self, wid: str, *, force: bool = False) -> None:
        wt = self._items.pop(wid, None)
        if not wt:
            return
        try:
            await self.adapter.remove(wt.repo, wt.path)
        except Exception:
            if not force:
                wt.status = WorktreeStatus.CONFLICT
                self._items[wid] = wt

    async def status(self, wid: str) -> dict[str, Any] | None:
        wt = self._items.get(wid)
        return wt.to_dict() if wt else None

    def list(self) -> list[dict[str, Any]]:
        return [w.to_dict() for w in self._items.values()]


_manager: WorktreeManager | None = None


def get_manager() -> WorktreeManager:
    global _manager
    if _manager is None:
        _manager = WorktreeManager()
    return _manager
