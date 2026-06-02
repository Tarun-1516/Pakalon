"""Memory public package — additive on top of :mod:`app.hindsight`."""
from .extractor import (
    ExtractedMemory,
    extract_memories,
    extract_memories_batch,
    reflect_on_memories,
    EXTRACTION_TOOL,
)
from .vector_store import (
    Hit, VectorStore,
    InMemoryAdapter, ChromaDBAdapter, PgVectorAdapter,
    get_store, reset_store,
    add_texts, search_text,
)

__all__ = [
    "ExtractedMemory", "extract_memories", "extract_memories_batch",
    "reflect_on_memories", "EXTRACTION_TOOL",
    "Hit", "VectorStore",
    "InMemoryAdapter", "ChromaDBAdapter", "PgVectorAdapter",
    "get_store", "reset_store",
    "add_texts", "search_text",
]
