"""DAPManager: registry of debug adapter clients + language configs."""
from __future__ import annotations

from typing import Any

from .protocol import DAPClient


DEFAULT_ADAPTERS: dict[str, str] = {
    "python": "python -m debugpy.adapter",
    "node": "node --inspect-brk=0",
    "go": "dlv dap --listen=127.0.0.1:0",
}


class DAPManager:
    def __init__(self) -> None:
        self._clients: dict[str, DAPClient] = {}

    async def start(self, language: str, *, custom_cmd: str | None = None) -> DAPClient:
        cmd = custom_cmd or DEFAULT_ADAPTERS.get(language, "")
        if not cmd:
            raise ValueError(f"unknown language: {language}")
        client = DAPClient(cmd)
        await client.start()
        # Standard DAP init handshake
        await client.request("initialize", {"clientID": "pakalon", "adapterID": language})
        self._clients[id(client)] = client
        return client

    def get(self, client_id: str) -> DAPClient | None:
        return self._clients.get(client_id)

    def register(self, key: str, client: DAPClient) -> None:
        self._clients[key] = client

    async def stop(self, key: str) -> bool:
        c = self._clients.pop(key, None)
        if not c:
            return False
        await c.stop()
        return True

    def list(self) -> list[str]:
        return list(self._clients.keys())


_manager: DAPManager | None = None


def get_manager() -> DAPManager:
    global _manager
    if _manager is None:
        _manager = DAPManager()
    return _manager
