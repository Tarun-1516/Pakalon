"""Minimal DAP client (Debug Adapter Protocol).

The wire format is:
    Content-Length: <n>\r\n
    \r\n
    <json-payload>

Implements just the request/response + event flow needed to drive a
debugger from inside the agent (initialize, launch, setBreakpoints,
configurationDone, continue, next, stepIn, threads, stackTrace, scopes,
variables, evaluate, disconnect).
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable


@dataclass(slots=True)
class DAPMessage:
    type: str  # request | response | event
    command: str = ""
    seq: int = 0
    message: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class DapEvent:
    event: str
    body: dict[str, Any] = field(default_factory=dict)


class DAPClient:
    """One DAP connection. Spawns the adapter as a child process and
    speaks Content-Length framed JSON over its stdio.
    """

    def __init__(self, adapter_cmd: str) -> None:
        self.adapter_cmd = adapter_cmd
        self._proc: asyncio.subprocess.Process | None = None
        self._seq = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._events: asyncio.Queue[DapEvent] = asyncio.Queue(maxsize=2000)
        self._reader_task: asyncio.Task | None = None
        self._buffer = b""

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_shell(
            self.adapter_cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        assert self._proc is not None
        while True:
            chunk = await self._proc.stdout.read(4096)
            if not chunk:
                return
            self._buffer += chunk
            while True:
                header, _, rest = self._buffer.partition(b"\r\n\r\n")
                if not _:
                    break
                if not header.lower().startswith(b"content-length:"):
                    self._buffer = b""
                    return
                try:
                    length = int(header.split(b":", 1)[1].strip())
                except Exception:
                    self._buffer = b""
                    return
                self._buffer = rest
                while len(self._buffer) < length:
                    more = await self._proc.stdout.read(length - len(self._buffer))
                    if not more:
                        return
                    self._buffer += more
                payload, self._buffer = self._buffer[:length], self._buffer[length:]
                try:
                    obj = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                self._dispatch(obj)

    def _dispatch(self, obj: dict) -> None:
        t = obj.get("type")
        if t == "response":
            fut = self._pending.pop(obj.get("request_seq", -1), None)
            if fut and not fut.done():
                fut.set_result(obj)
        elif t == "event":
            try:
                self._events.put_nowait(DapEvent(event=obj.get("event", ""), body=obj.get("body", {})))
            except asyncio.QueueFull:
                pass

    async def request(self, command: str, arguments: dict | None = None) -> dict:
        seq = self._seq
        self._seq += 1
        msg = {
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments or {},
        }
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[seq] = fut
        await self._send(msg)
        return await fut

    async def _send(self, msg: dict) -> None:
        assert self._proc is not None
        data = json.dumps(msg, separators=(",", ":")).encode("utf-8")
        frame = f"Content-Length: {len(data)}\r\n\r\n".encode("ascii") + data
        self._proc.stdin.write(frame)
        await self._proc.stdin.drain()

    async def next_event(self, timeout: float | None = None) -> DapEvent:
        if timeout is None:
            return await self._events.get()
        return await asyncio.wait_for(self._events.get(), timeout=timeout)

    async def wait_for_event(
        self,
        event_name: str,
        timeout: float = 30.0,
    ) -> DapEvent:
        deadline = time.time() + timeout
        while time.time() < deadline:
            ev = await self.next_event(timeout=deadline - time.time())
            if ev.event == event_name:
                return ev
        raise asyncio.TimeoutError(f"event {event_name} not seen in {timeout}s")

    async def stop(self) -> None:
        try:
            await self.request("disconnect", {"terminateDebuggee": True})
        except Exception:
            pass
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
        self._reader_task and self._reader_task.cancel()
