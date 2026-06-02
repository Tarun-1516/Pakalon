"""Patches: unified-diff and JSON-patch representations for files."""
from __future__ import annotations

from .service import PatchService, Patch, PatchOp

__all__ = ["PatchService", "Patch", "PatchOp"]
