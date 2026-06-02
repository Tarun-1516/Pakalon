"""Goals: hierarchical task / objective management.

A Goal is a unit of work the agent is trying to accomplish.
Goals can be nested (parent/child), tracked, marked done/blocked,
and bound to sessions.
"""
from __future__ import annotations

from .models import Goal, GoalStatus
from .service import GoalsService

__all__ = ["Goal", "GoalStatus", "GoalsService"]
