"""PTY: pseudo-terminal sessions for shell-like agentic control.

A thin abstraction over asyncio subprocesses with a PTY interface
(works on POSIX). On Windows we fall back to plain subprocess pipes.
"""
from __future__ import annotations

from .session import PtySession, PtyHandle
from .manager import PtyManager

__all__ = ["PtySession", "PtyHandle", "PtyManager"]
