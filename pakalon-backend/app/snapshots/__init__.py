"""Snapshots: point-in-time captures of file/dir/branch state."""
from __future__ import annotations

from .service import SnapshotService, Snapshot

__all__ = ["SnapshotService", "Snapshot"]
