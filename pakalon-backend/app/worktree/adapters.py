"""Worktree adapters (git CLI primary, libgit2 optional)."""
from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from dataclasses import dataclass
from typing import Protocol


class WorktreeAdapter(Protocol):
    name: str
    async def is_available(self) -> bool: ...
    async def create(self, repo: str, branch: str, path: str, base: str) -> str: ...
    async def remove(self, repo: str, path: str) -> None: ...
    async def list(self, repo: str) -> list[dict]: ...
    async def diff(self, repo: str, base: str, head: str) -> str: ...
    async def merge(self, repo: str, src: str, dst: str) -> str: ...


class GitCliAdapter:
    name = "git-cli"

    async def is_available(self) -> bool:
        return shutil.which("git") is not None

    async def _run(self, *args: str, cwd: str) -> str:
        proc = await asyncio.create_subprocess_exec(
            "git", *args, cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"git {args[0]} failed: {err.decode('utf-8', 'replace')}")
        return out.decode("utf-8", "replace").strip()

    async def create(self, repo: str, branch: str, path: str, base: str) -> str:
        # ensure branch
        await self._run("rev-parse", "--verify", branch, cwd=repo)
        await self._run("worktree", "add", "-b", branch, path, base, cwd=repo)
        return path

    async def remove(self, repo: str, path: str) -> None:
        await self._run("worktree", "remove", "--force", path, cwd=repo)

    async def list(self, repo: str) -> list[dict]:
        out = await self._run("worktree", "list", "--porcelain", cwd=repo)
        items: list[dict] = []
        cur: dict = {}
        for line in out.splitlines():
            if not line:
                if cur:
                    items.append(cur)
                    cur = {}
                continue
            k, _, v = line.partition(" ")
            cur[k] = v
        if cur:
            items.append(cur)
        return items

    async def diff(self, repo: str, base: str, head: str) -> str:
        return await self._run("diff", f"{base}...{head}", cwd=repo)

    async def merge(self, repo: str, src: str, dst: str) -> str:
        return await self._run("merge", "--no-ff", "-m", f"merge {src} into {dst}", src, cwd=repo)


class LibGit2Adapter:
    name = "libgit2"

    async def is_available(self) -> bool:
        try:
            import pygit2  # noqa: F401
            return True
        except ImportError:
            return False

    async def create(self, repo: str, branch: str, path: str, base: str) -> str:
        import pygit2
        r = pygit2.Repository(repo)
        commit = r.revparse_single(base)
        r.branches.local.create(branch, commit)
        # pygit2 doesn't expose worktrees as conveniently; do via CLI fallback
        cli = GitCliAdapter()
        await cli.create(repo, branch, path, base)
        return path

    async def remove(self, repo: str, path: str) -> None:
        await GitCliAdapter().remove(repo, path)

    async def list(self, repo: str) -> list[dict]:
        return await GitCliAdapter().list(repo)

    async def diff(self, repo: str, base: str, head: str) -> str:
        return await GitCliAdapter().diff(repo, base, head)

    async def merge(self, repo: str, src: str, dst: str) -> str:
        return await GitCliAdapter().merge(repo, src, dst)


def select_adapter() -> WorktreeAdapter:
    # Pick libgit2 if available, else git CLI
    try:
        import pygit2  # noqa: F401
        return LibGit2Adapter()
    except ImportError:
        return GitCliAdapter()
