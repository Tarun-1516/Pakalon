"""Branch-summarization compaction.

Used during context-window pressure to summarize an entire branch of
a session into a compact, retrievable summary that can be re-injected.
"""
from __future__ import annotations

import time
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol


class Summarizer(Protocol):
    async def summarize(self, text: str, *, max_tokens: int = 512) -> str: ...


@dataclass(slots=True)
class CompactionResult:
    branch_id: str
    summary: str
    original_chars: int
    summary_chars: int
    events_compacted: int
    created_at: float = 0.0

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = time.time()

    @property
    def ratio(self) -> float:
        if self.original_chars == 0:
            return 0.0
        return self.summary_chars / self.original_chars


class BranchCompactor:
    """Heuristic compactor: extracts salient sentences and trims to budget.

    A real LLM-backed summarizer can be injected via the constructor.
    """

    def __init__(self, summarizer: Summarizer | None = None) -> None:
        self.summarizer = summarizer

    async def compact(
        self,
        branch_id: str,
        events: Iterable[dict],
        max_chars: int = 4000,
    ) -> CompactionResult:
        joined = "\n".join(_render(e) for e in events)
        original = len(joined)
        if self.summarizer is not None:
            summary = await self.summarizer.summarize(joined, max_tokens=max_chars // 4)
        else:
            summary = _heuristic_summary(joined, max_chars)
        events_list = list(events) if isinstance(events, list) else []
        return CompactionResult(
            branch_id=branch_id,
            summary=summary,
            original_chars=original,
            summary_chars=len(summary),
            events_compacted=len(events_list),
        )


def _render(ev: dict) -> str:
    kind = ev.get("kind", "event")
    payload = ev.get("payload", "")
    return f"[{kind}] {payload}"


def _heuristic_summary(text: str, max_chars: int) -> str:
    """Keep sentences with the highest 'information score':
    - mentions code-ish tokens
    - has numbers
    - has capitalized identifiers
    - is non-trivial length
    """
    if not text:
        return ""
    sents = [s.strip() for s in text.replace("\n", " ").split(".") if s.strip()]
    scored: list[tuple[float, str]] = []
    for s in sents:
        sc = 0.0
        if any(c.isdigit() for c in s):
            sc += 1.0
        if any(t in s for t in ("def ", "class ", "import ", "from ", "$", "=>", "->")):
            sc += 1.5
        words = s.split()
        if 6 <= len(words) <= 40:
            sc += 0.5
        if any(w[:1].isupper() and w[1:].islower() for w in words):
            sc += 0.3
        scored.append((sc, s + "."))
    scored.sort(key=lambda t: t[0], reverse=True)
    out: list[str] = []
    total = 0
    for _, s in scored:
        if total + len(s) > max_chars:
            break
        out.append(s)
        total += len(s)
    if not out:
        return text[:max_chars]
    return " ".join(out)
