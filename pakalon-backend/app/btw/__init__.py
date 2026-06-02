"""Btw: by-the-way / ambient event bus for cross-feature notifications.

Used by the agent to surface passive context to the user (e.g. "btw, your
build is failing", "btw, you have 3 new messages").
"""
from __future__ import annotations

from .service import BtwService, BtwNote, BtwSeverity

__all__ = ["BtwService", "BtwNote", "BtwSeverity"]
