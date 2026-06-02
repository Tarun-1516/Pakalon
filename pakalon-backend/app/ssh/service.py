"""SSH service: connection pool + commands."""
from __future__ import annotations

import asyncio
from typing import Any

from . import SshConnection, SshResult, _default_backend


class SshService:
    def __init__(self) -> None:
        self._pool: dict[str, SshConnection] = {}
        self._lock = asyncio.Lock()

    def _key(self, host: str, user: str, port: int) -> str:
        return f"{user}@{host}:{port}"

    async def connect(
        self,
        host: str,
        user: str,
        *,
        port: int = 22,
        key_filename: str = "",
        password: str = "",
    ) -> SshConnection:
        if _default_backend is None:
            raise RuntimeError("No SSH backend available; install asyncssh or paramiko")
        conn = SshConnection(
            host=host, user=user, port=port,
            key_filename=key_filename, password=password,
        )
        conn = await _default_backend.connect(conn)
        async with self._lock:
            self._pool[self._key(host, user, port)] = conn
        return conn

    async def run(
        self,
        host: str,
        user: str,
        command: str,
        *,
        port: int = 22,
        timeout: float = 60.0,
    ) -> SshResult:
        conn = self._pool.get(self._key(host, user, port))
        if conn is None:
            conn = await self.connect(host, user, port=port)
        return await conn.run(command, timeout=timeout)

    async def disconnect(self, host: str, user: str, port: int = 22) -> bool:
        conn = self._pool.pop(self._key(host, user, port), None)
        if not conn:
            return False
        await conn.close()
        return True

    def list(self) -> list[str]:
        return list(self._pool.keys())


_service: SshService | None = None


def get_service() -> SshService:
    global _service
    if _service is None:
        _service = SshService()
    return _service
