"""Embedding providers for mnemopi.

Default: deterministic hash-based embedder (no external API).
Production: pluggable OpenAI/Cohere/Ollama embedder via interface.
"""
from __future__ import annotations

import hashlib
import math
from typing import Protocol, Sequence


class EmbeddingProvider(Protocol):
    dim: int
    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...
    async def embed_query(self, text: str) -> list[float]: ...


class HashingEmbedder:
    """Fast, dependency-free, deterministic 384-dim embedder.

    Uses feature-hashing of word + bigram tokens into a fixed-dim vector,
    normalized to unit length. Good for semantic-ish retrieval without
    any external model dependency.
    """

    def __init__(self, dim: int = 384) -> None:
        self.dim = dim

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [_hash_vector(t, self.dim) for t in texts]

    async def embed_query(self, text: str) -> list[float]:
        return _hash_vector(text, self.dim)


def _hash_vector(text: str, dim: int) -> list[float]:
    text = (text or "").lower().strip()
    if not text:
        return [0.0] * dim
    tokens = text.split()
    bigrams = [f"{a}_{b}" for a, b in zip(tokens, tokens[1:])]
    feats = tokens + bigrams
    vec = [0.0] * dim
    for f in feats:
        h = hashlib.md5(f.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "big") % dim
        sign = 1.0 if (h[4] & 1) else -1.0
        vec[idx] += sign
    # L2 normalize
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec
