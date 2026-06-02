"""Mnemopi: Semantic long-term memory bank for agentic sessions.

Provides embedding-based storage and retrieval of memory items
that persist across sessions, branches, and modes.
"""
from __future__ import annotations

from .bank import MemoryBank, MemoryItem
from .embeddings import EmbeddingProvider, HashingEmbedder
from .service import MnemopiService

__all__ = [
    "MemoryBank",
    "MemoryItem",
    "EmbeddingProvider",
    "HashingEmbedder",
    "MnemopiService",
]
