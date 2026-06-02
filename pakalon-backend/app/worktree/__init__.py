"""Worktree: git worktree orchestration for parallel agentic work.

Provides:
- Branch ↔ worktree mapping
- Multi-adapter support (git CLI, libgit2/pygit2 if available)
- Snapshot, diff, merge, cleanup operations
"""
from __future__ import annotations

from .manager import WorktreeManager, Worktree, WorktreeStatus
from .adapters import GitCliAdapter, LibGit2Adapter, select_adapter

__all__ = [
    "WorktreeManager", "Worktree", "WorktreeStatus",
    "GitCliAdapter", "LibGit2Adapter", "select_adapter",
]
