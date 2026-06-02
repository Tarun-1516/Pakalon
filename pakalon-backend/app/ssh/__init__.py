"""SSH: remote command execution for agentic tasks.

Uses asyncssh if available; otherwise provides a synchronous paramiko
fallback wrapped in `asyncio.to_thread`. If neither library is present,
raises an informative error at call time.
"""
from __future__ import annotations

import asyncio
import shlex
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class SshConnection:
    host: str
    user: str
    port: int = 22
    key_filename: str = ""
    password: str = ""
    client: Any = None  # asyncssh.Connection or paramiko.SSHClient

    async def run(self, command: str, *, timeout: float = 60.0) -> "SshResult":
        return await _default_backend.run(self, command, timeout=timeout)

    async def close(self) -> None:
        if self.client is None:
            return
        try:
            if hasattr(self.client, "close"):
                maybe = self.client.close
                if asyncio.iscoroutinefunction(maybe):
                    await maybe()
                else:
                    maybe()
        except Exception:
            pass


@dataclass(slots=True)
class SshResult:
    stdout: str
    stderr: str
    exit_code: int
    duration: float = 0.0


class _AsyncsshBackend:
    async def connect(self, conn: SshConnection) -> SshConnection:
        try:
            import asyncssh  # type: ignore
        except ImportError as e:
            raise RuntimeError("asyncssh not installed; `pip install asyncssh`") from e
        client = await asyncssh.connect(
            conn.host, port=conn.port, username=conn.user,
            client_keys=[conn.key_filename] if conn.key_filename else None,
            password=conn.password or None,
            known_hosts=None,
        )
        conn.client = client
        return conn

    async def run(self, conn: SshConnection, command: str, timeout: float) -> SshResult:
        import time
        t0 = time.time()
        assert conn.client is not None
        out = await asyncio.wait_for(conn.client.run(command), timeout=timeout)
        return SshResult(
            stdout=str(out.stdout) if out.stdout else "",
            stderr=str(out.stderr) if out.stderr else "",
            exit_code=int(out.exit_status) if out.exit_status is not None else 0,
            duration=time.time() - t0,
        )


class _ParamikoBackend:
    async def connect(self, conn: SshConnection) -> SshConnection:
        try:
            import paramiko  # type: ignore
        except ImportError as e:
            raise RuntimeError("paramiko not installed; `pip install paramiko`") from e
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        await asyncio.to_thread(
            client.connect,
            conn.host, port=conn.port, username=conn.user,
            key_filename=conn.key_filename or None,
            password=conn.password or None,
            look_for_keys=False,
        )
        conn.client = client
        return conn

    async def run(self, conn: SshConnection, command: str, timeout: float) -> SshResult:
        import time
        t0 = time.time()
        assert conn.client is not None
        stdin, stdout, stderr = await asyncio.to_thread(conn.client.exec_command, command, timeout=timeout)
        data_out = await asyncio.to_thread(stdout.read().decode, "utf-8", "replace")
        data_err = await asyncio.to_thread(stderr.read().decode, "utf-8", "replace")
        code = await asyncio.to_thread(stdout.channel.recv_exit_status)
        return SshResult(
            stdout=data_out, stderr=data_err, exit_code=int(code),
            duration=time.time() - t0,
        )


def _select_backend():
    try:
        import asyncssh  # noqa: F401
        return _AsyncsshBackend()
    except ImportError:
        pass
    try:
        import paramiko  # noqa: F401
        return _ParamikoBackend()
    except ImportError:
        pass
    return None  # type: ignore[return-value]


_default_backend = _select_backend()  # may be None if no SSH lib installed
