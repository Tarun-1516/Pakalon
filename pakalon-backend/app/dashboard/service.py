"""Dashboard aggregation service."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class DashboardTile:
    id: str
    title: str
    value: Any
    detail: str = ""
    status: str = "ok"  # ok | warn | error
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "value": self.value,
            "detail": self.detail, "status": self.status,
            "updated_at": self.updated_at,
        }


class DashboardService:
    def __init__(self) -> None:
        self._tiles: dict[str, DashboardTile] = {}

    def upsert(self, tile: DashboardTile) -> None:
        tile.updated_at = time.time()
        self._tiles[tile.id] = tile

    def get(self, tile_id: str) -> DashboardTile | None:
        return self._tiles.get(tile_id)

    def all(self) -> list[DashboardTile]:
        return list(self._tiles.values())

    def summary(self) -> dict[str, Any]:
        counts = {"ok": 0, "warn": 0, "error": 0}
        for t in self._tiles.values():
            counts[t.status] = counts.get(t.status, 0) + 1
        return {
            "tiles": [t.to_dict() for t in self._tiles.values()],
            "counts": counts,
            "generated_at": time.time(),
        }


_service: DashboardService | None = None


def get_service() -> DashboardService:
    global _service
    if _service is None:
        _service = DashboardService()
    return _service
