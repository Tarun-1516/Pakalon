"""v2 session model: durable, multi-branch, event-sourced sessions.

Adds to the existing v1 session model:
- Branch tree (parent/child sessions)
- Event-sourced turns (immutable, append-only)
- Resumable from any point
- Causal timestamps
"""
from __future__ import annotations

from .models import V2Session, V2Turn, V2Branch, V2Event
from .service import V2SessionService

__all__ = ["V2Session", "V2Turn", "V2Branch", "V2Event", "V2SessionService"]
