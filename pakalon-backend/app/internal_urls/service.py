"""Internal URL service."""
from __future__ import annotations

from typing import Any

from .protocols import LocalProtocol, SecureProtocol, ParsedUrl


class InternalUrlService:
    def __init__(
        self,
        local: LocalProtocol | None = None,
        secure: SecureProtocol | None = None,
    ) -> None:
        self.local = local or LocalProtocol()
        self.secure = secure or SecureProtocol()

    def build(
        self,
        workspace: str,
        path: str,
        *,
        scheme: str = "local",
        ttl_seconds: int = 3600,
        **meta,
    ) -> str:
        if scheme == "secure":
            return self.secure.build(workspace, path, ttl_seconds=ttl_seconds, **meta)
        return self.local.build(workspace, path, **meta)

    def resolve(self, url: str) -> ParsedUrl | None:
        if url.startswith("secure://"):
            return self.secure.verify(url)
        if url.startswith("local://"):
            return self.local.verify(url)
        return None
