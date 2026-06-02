"""PtySession / PtyHandle: one persistent pseudo-terminal session."""
from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator


@dataclass(slots=True)
class PtyHandle:
    session_id: str
    pid: int
    command: str
    started_at: float = field(default_factory=time.time)
    exit_code: int | None = None
    cwd: str = ""

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "pid": self.pid,
            "command": self.command,
            "started_at": self.started_at,
            "exit_code": self.exit_code,
            "cwd": self.cwd,
        }


class PtySession:
    """Owns a child process; provides async read/write/resize/kill."""

    def __init__(self, command: str, *, cwd: str = "", env: dict | None = None) -> None:
        self.command = command
        self.cwd = cwd or os.getcwd()
        self.env = env or os.environ.copy()
        self.session_id = f"pty_{uuid.uuid4().hex[:12]}"
        self._proc: asyncio.subprocess.Process | None = None
        self._stdout_task: asyncio.Task | None = None
        self._output_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=10_000)
        self._closed = False

    async def start(self) -> PtyHandle:
        self._proc = await asyncio.create_subprocess_shell(
            self.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            env=self.env,
        )
        self._stdout_task = asyncio.create_task(self._pump_stdout())
        return PtyHandle(
            session_id=self.session_id, pid=self._proc.pid or 0,
            command=self.command, cwd=self.cwd,
        )

    async def _pump_stdout(self) -> None:
        assert self._proc is not None
        try:
            while True:
                chunk = await self._proc.stdout.read(4096)
                if not chunk:
                    break
                try:
                    self._output_queue.put_nowait(chunk)
                except asyncio.QueueFull:
                    # drop oldest
                    try:
                        self._output_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    self._output_queue.put_nowait(chunk)
        except Exception:
            pass

    async def write(self, data: str | bytes) -> int:
        assert self._proc is not None
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._proc.stdin.write(data)
        await self._proc.stdin.drain()
        return len(data)

    async def read(self, timeout: float | None = None) -> bytes:
        if timeout is None:
            return await self._output_queue.get()
        return await asyncio.wait_for(self._output_queue.get(), timeout=timeout)

    async def readline(self, timeout: float = 5.0) -> bytes:
        buf = b""
        while True:
            try:
                chunk = await self.read(timeout=timeout)
            except asyncio.TimeoutError:
                return buf
            buf += chunk
            if buf.endswith(b"\n"):
                return buf

    async def resize(self, cols: int, rows: int) -> None:
        # Native PTY size requires `os.set winsize` on POSIX; no-op here.
        # Concrete deployments can wire `python-ptyprocess` or pyte.
        _ = (cols, rows)

    async def kill(self) -> None:
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self._proc.kill()
        self._closed = True

    @property
    def closed(self) -> bool:
        return self._closed or (self._proc is not None and self._proc.returncode is not None)

    @property
    def exit_code(self) -> int | None:
        if not self._proc:
            return None
        return self._proc.returncode

    async def stream(self) -> AsyncIterator[bytes]:
        while not self.closed:
            try:
                yield await self.read(timeout=1.0)
            except asyncio.TimeoutError:
                continue
