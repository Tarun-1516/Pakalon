"""Vector-store adapters for memory + RAG use cases.

This module is additive on top of :mod:`app.hindsight` and
:mod:`app.mnemopi`.  It provides a *unified* sync/async API that
backs onto one of three implementations:

  * **ChromaDBAdapter** — production, persistent vector store.
  * **PgVectorAdapter** — uses the existing PostgreSQL instance
    (no extra infrastructure).
  * **InMemoryAdapter** — pure-Python fallback for tests/dev.

The adapter is selected by ``PAKALON_VECTOR_STORE`` env var
(``chroma`` | ``pgvector`` | ``memory``).  All adapters expose
the same protocol:

    class VectorStore(Protocol):
        async def upsert(self, ids, vectors, metadatas, documents) -> None: ...
        async def query(self, vector, top_k=8, filter=None) -> list[Hit]: ...
        async def delete(self, ids) -> None: ...
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class Hit:
    id: str
    score: float
    metadata: dict[str, Any] = field(default_factory=dict)
    document: Optional[str] = None


@runtime_checkable
class VectorStore(Protocol):
    async def upsert(
        self,
        ids: list[str],
        vectors: list[list[float]],
        metadatas: Optional[list[dict[str, Any]]] = None,
        documents: Optional[list[str]] = None,
    ) -> None: ...

    async def query(
        self,
        vector: list[float],
        top_k: int = 8,
        filter: Optional[dict[str, Any]] = None,
    ) -> list[Hit]: ...

    async def delete(self, ids: list[str]) -> None: ...


# ─── In-memory fallback ─────────────────────────────────────────────────────

class InMemoryAdapter:
    """Pure-Python cosine-similarity store. Used in tests and dev."""

    def __init__(self) -> None:
        self._ids: list[str] = []
        self._vectors: list[list[float]] = []
        self._metas: list[dict[str, Any]] = []
        self._docs: list[Optional[str]] = []

    async def upsert(
        self, ids, vectors, metadatas=None, documents=None,
    ) -> None:
        for i, vid in enumerate(ids):
            if vid in self._ids:
                idx = self._ids.index(vid)
                self._vectors[idx] = vectors[i]
                self._metas[idx] = (metadatas or [{}] * len(ids))[i] or {}
                self._docs[idx] = (documents or [None] * len(ids))[i]
            else:
                self._ids.append(vid)
                self._vectors.append(vectors[i])
                self._metas.append((metadatas or [{}] * len(ids))[i] or {})
                self._docs.append((documents or [None] * len(ids))[i])

    async def query(self, vector, top_k=8, filter=None) -> list[Hit]:
        def _cos(a, b):
            num = sum(x * y for x, y in zip(a, b))
            den_a = sum(x * x for x in a) ** 0.5 or 1.0
            den_b = sum(x * x for x in b) ** 0.5 or 1.0
            return num / (den_a * den_b)

        scored = []
        for i, v in enumerate(self._vectors):
            if filter and not _match_filter(self._metas[i], filter):
                continue
            scored.append((i, _cos(vector, v)))
        scored.sort(key=lambda x: -x[1])
        return [
            Hit(id=self._ids[i], score=s, metadata=self._metas[i], document=self._docs[i])
            for i, s in scored[:top_k]
        ]

    async def delete(self, ids) -> None:
        for vid in ids:
            if vid in self._ids:
                idx = self._ids.index(vid)
                self._ids.pop(idx); self._vectors.pop(idx)
                self._metas.pop(idx); self._docs.pop(idx)


def _match_filter(meta: dict[str, Any], flt: dict[str, Any]) -> bool:
    for k, v in flt.items():
        if k not in meta or meta[k] != v:
            return False
    return True


# ─── ChromaDB adapter ───────────────────────────────────────────────────────

class ChromaDBAdapter:
    """Production vector store using ChromaDB's persistent client.

    Requires ``chromadb`` to be installed (``uv add chromadb``).  The
    collection name is derived from the ``PAKALON_VECTOR_COLLECTION``
    env var, defaulting to ``pakalon_default``.
    """
    def __init__(self) -> None:
        import chromadb  # type: ignore
        path = os.getenv("PAKALON_VECTOR_PATH", "./.vector")
        client = chromadb.PersistentClient(path=path)
        name = os.getenv("PAKALON_VECTOR_COLLECTION", "pakalon_default")
        self._col = client.get_or_create_collection(name)

    async def upsert(self, ids, vectors, metadatas=None, documents=None) -> None:
        self._col.upsert(
            ids=list(ids),
            embeddings=[list(v) for v in vectors],
            metadatas=list(metadatas) if metadatas else None,
            documents=list(documents) if documents else None,
        )

    async def query(self, vector, top_k=8, filter=None) -> list[Hit]:
        res = self._col.query(query_embeddings=[list(vector)], n_results=top_k,
                              where=filter or None)
        ids = (res.get("ids") or [[]])[0]
        scores = (res.get("distances") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        docs = (res.get("documents") or [[]])[0]
        return [
            Hit(id=ids[i], score=1.0 - (scores[i] or 0.0),
                metadata=metas[i] or {}, document=docs[i] if docs else None)
            for i in range(len(ids))
        ]

    async def delete(self, ids) -> None:
        self._col.delete(ids=list(ids))


# ─── pgvector adapter ───────────────────────────────────────────────────────

class PgVectorAdapter:
    """Use the existing PostgreSQL instance for vector storage.

    Expects a ``memvec`` table with columns ``(id text PRIMARY KEY,
    vec vector(<dim>), meta jsonb, doc text)``.  Creates it lazily
    on first upsert.
    """
    def __init__(self) -> None:
        from app.database import SessionLocal  # type: ignore
        self._SessionLocal = SessionLocal
        self._dim = int(os.getenv("PAKALON_VECTOR_DIM", "1536"))
        self._initialised = False

    async def _ensure_table(self, s) -> None:
        if self._initialised:
            return
        from sqlalchemy import text
        await s.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await s.execute(text(
            f"CREATE TABLE IF NOT EXISTS memvec ("
            f"id text PRIMARY KEY, vec vector({self._dim}),"
            f"meta jsonb, doc text)"
        ))
        await s.commit()
        self._initialised = True

    async def upsert(self, ids, vectors, metadatas=None, documents=None) -> None:
        async with self._SessionLocal() as s:
            await self._ensure_table(s)
            from sqlalchemy import text
            for i, vid in enumerate(ids):
                vec_str = "[" + ",".join(str(x) for x in vectors[i]) + "]"
                meta = json.dumps((metadatas or [{}] * len(ids))[i] or {})
                doc = (documents or [None] * len(ids))[i]
                await s.execute(text(
                    "INSERT INTO memvec (id, vec, meta, doc) VALUES (:id, :vec, :meta, :doc) "
                    "ON CONFLICT (id) DO UPDATE SET vec = EXCLUDED.vec, "
                    "meta = EXCLUDED.meta, doc = EXCLUDED.doc"
                ), {"id": vid, "vec": vec_str, "meta": meta, "doc": doc})
            await s.commit()

    async def query(self, vector, top_k=8, filter=None) -> list[Hit]:
        async with self._SessionLocal() as s:
            from sqlalchemy import text
            vec_str = "[" + ",".join(str(x) for x in vector) + "]"
            res = await s.execute(text(
                "SELECT id, 1 - (vec <=> :vec) AS score, meta, doc "
                "FROM memvec ORDER BY vec <=> :vec LIMIT :k"
            ), {"vec": vec_str, "k": top_k})
            rows = res.fetchall()
        return [
            Hit(id=r[0], score=float(r[1] or 0.0),
                metadata=r[2] or {}, document=r[3])
            for r in rows
        ]

    async def delete(self, ids) -> None:
        async with self._SessionLocal() as s:
            from sqlalchemy import text
            await s.execute(text("DELETE FROM memvec WHERE id = ANY(:ids)"),
                            {"ids": list(ids)})
            await s.commit()


# ─── Singleton accessor ────────────────────────────────────────────────────

_STORE: Optional[VectorStore] = None


def get_store() -> VectorStore:
    global _STORE
    if _STORE is not None:
        return _STORE
    kind = (os.getenv("PAKALON_VECTOR_STORE") or "memory").lower()
    if kind == "chroma":
        try:
            _STORE = ChromaDBAdapter()
            logger.info("vector store: chromadb")
        except Exception as e:
            logger.warning("chroma unavailable (%s); falling back to in-memory", e)
            _STORE = InMemoryAdapter()
    elif kind == "pgvector":
        _STORE = PgVectorAdapter()
        logger.info("vector store: pgvector")
    else:
        _STORE = InMemoryAdapter()
        logger.info("vector store: in-memory")
    return _STORE


def reset_store() -> None:
    global _STORE
    _STORE = None


# ─── Convenience: convenience upsert + cosine search across text + embed ───

async def add_texts(texts: list[str], metadatas: Optional[list[dict]] = None) -> list[str]:
    """Embed and upsert a batch of texts, returning their ids."""
    from app.llm_providers.direct.embeddings import get_embedder
    store = get_store()
    emb = get_embedder()
    vecs = await emb.embed_batch(texts)
    ids = [f"vec_{uuid.uuid4().hex[:16]}" for _ in texts]
    await store.upsert(ids, vecs, metadatas=metadatas, documents=texts)
    return ids


async def search_text(query: str, top_k: int = 8,
                      filter: Optional[dict] = None) -> list[Hit]:
    """Embed ``query`` and search the active store."""
    from app.llm_providers.direct.embeddings import get_embedder
    store = get_store()
    emb = get_embedder()
    qv = (await emb.embed_batch([query]))[0]
    return await store.query(qv, top_k=top_k, filter=filter)
