"""Tiny: ultra-small side-effectful tasks (notes, links, snippets, snippets-of-the-day).

Handy in-conversation primitives for the agent to drop lightweight
artifacts into the user's workspace.
"""
from __future__ import annotations

from .service import TinyService, TinyItem, TinyKind

__all__ = ["TinyService", "TinyItem", "TinyKind"]
