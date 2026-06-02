"""Web search backend chain.

Implements the 14-backend web search chain used by the `web_search` tool:

  1. Exa
  2. Brave
  3. Jina
  4. Tavily
  5. Parallel
  6. Kagi
  7. You.com
  8. Perplexity (search api)
  9. Exa-Neuron
 10. OpenAI (web search via responses API)
 11. Anthropic (web search via messages API; when available)
 12. Valyu
 13. Cloudflare (browser rendering + ai extraction)
 14. DuckDuckGo (HTML scrape; last-resort fallback)

The chain walks backends in priority order until one returns ≥ 1 result, with
optional per-backend timeouts, retries, and a global budget cap.

The router (also in this package) exposes:
  - POST /web_search/run              — run a search with the chain
  - GET  /web_search/backends         — list backends + their status
  - POST /web_search/{backend}/run    — run a single backend (for debugging)

All backends are typed against a common `SearchBackend` protocol, so adding
a 15th backend is a one-class change.
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Mapping, Optional

import httpx

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Common types
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(slots=True)
class SearchResult:
    """A single search result, normalized across backends."""
    title: str
    url: str
    snippet: str = ""
    published_at: Optional[str] = None  # ISO 8601
    author: Optional[str] = None
    score: Optional[float] = None       # 0..1
    favicon_url: Optional[str] = None
    image_url: Optional[str] = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class SearchResponse:
    query: str
    backend: str
    results: list[SearchResult]
    duration_ms: int
    cost_usd: float = 0.0
    cached: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


class SearchError(RuntimeError):
    def __init__(self, message: str, backend: str, status: int = 0, body: Any = None) -> None:
        super().__init__(f"[{backend}] {message}")
        self.backend = backend
        self.status = status
        self.body = body


# ─────────────────────────────────────────────────────────────────────────────
# SearchBackend protocol
# ─────────────────────────────────────────────────────────────────────────────

class SearchBackend:
    """Base class for all 14 web-search backends."""

    id: str = "abstract"
    label: str = "Abstract"
    requires_api_key: bool = True

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        self.api_key = api_key
        self.opts = opts

    async def search(
        self,
        query: str,
        *,
        top_n: int = 8,
        recency: Optional[str] = None,
        timeout_s: float = 15.0,
        client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        raise NotImplementedError

    def _check_key(self) -> None:
        if self.requires_api_key and not self.api_key:
            raise SearchError("missing API key", self.id)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Exa
# ─────────────────────────────────────────────────────────────────────────────

class ExaBackend(SearchBackend):
    id = "exa"
    label = "Exa (neural)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.exa.ai/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        body = {
            "query": query,
            "numResults": top_n,
            "useAutoprompt": True,
            "contents": {"text": True, "highlights": True},
        }
        if recency:
            body["startPublishedDate"] = recency_to_start(recency)
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(
                self.endpoint,
                json=body,
                headers={"x-api-key": self.api_key, "Accept": "application/json"},
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=(item.get("highlights") or item.get("text") or "")[:500],
                published_at=item.get("publishedDate"),
                author=item.get("author"),
                score=item.get("score"),
                favicon_url=item.get("favicon"),
                raw=item,
            )
            for item in json.get("results", [])
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 2. Brave
# ─────────────────────────────────────────────────────────────────────────────

class BraveBackend(SearchBackend):
    id = "brave"
    label = "Brave Search"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.search.brave.com/res/v1/web/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        params = {"q": query, "count": str(top_n)}
        if recency:
            params["freshness"] = recency  # "pd" / "pw" / "pm" / "py"
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(
                self.endpoint,
                params=params,
                headers={"X-Subscription-Token": self.api_key, "Accept": "application/json"},
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("description", ""),
                published_at=item.get("age"),
                favicon_url=(item.get("profile") or {}).get("img"),
                raw=item,
            )
            for item in json.get("web", {}).get("results", [])
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Jina
# ─────────────────────────────────────────────────────────────────────────────

class JinaBackend(SearchBackend):
    id = "jina"
    label = "Jina Reader (search.serp.dev)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://s.jina.ai/")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(
                self.endpoint,
                params={"q": query, "num": top_n},
                headers={"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"},
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = []
        data = json.get("data") if isinstance(json, dict) else json
        if isinstance(data, list):
            for item in data:
                results.append(SearchResult(
                    title=item.get("title", ""),
                    url=item.get("url", ""),
                    snippet=item.get("description", ""),
                    published_at=item.get("date"),
                    raw=item,
                ))
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Tavily
# ─────────────────────────────────────────────────────────────────────────────

class TavilyBackend(SearchBackend):
    id = "tavily"
    label = "Tavily"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.tavily.com/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        body = {
            "api_key": self.api_key,
            "query": query,
            "max_results": top_n,
            "search_depth": "advanced",
            "include_answer": False,
        }
        if recency:
            body["days"] = recency_to_days(recency)
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(self.endpoint, json=body, timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("content", ""),
                score=item.get("score"),
                published_at=item.get("published_date"),
                raw=item,
            )
            for item in json.get("results", [])
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Parallel
# ─────────────────────────────────────────────────────────────────────────────

class ParallelBackend(SearchBackend):
    id = "parallel"
    label = "Parallel (findapi)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.parallel.ai/v1beta/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        body = {
            "query": query,
            "max_results": top_n,
            "source_policy": {"include_domains": [], "exclude_domains": []},
        }
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(
                self.endpoint,
                json=body,
                headers={"x-api-key": self.api_key, "Content-Type": "application/json"},
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("excerpts", [""])[0] if isinstance(item.get("excerpts"), list) else item.get("excerpts", ""),
                published_at=item.get("publish_date"),
                raw=item,
            )
            for item in json.get("results", [])
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 6. Kagi
# ─────────────────────────────────────────────────────────────────────────────

class KagiBackend(SearchBackend):
    id = "kagi"
    label = "Kagi"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://kagi.com/api/v0/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(
                self.endpoint,
                params={"q": query, "limit": top_n},
                headers={"Authorization": f"Bot {self.api_key}"},
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = []
        for item in json.get("data", []):
            ts = item.get("published") or item.get("t")
            results.append(SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("snippet", ""),
                published_at=ts,
                raw=item,
            ))
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 7. You.com
# ─────────────────────────────────────────────────────────────────────────────

class YouBackend(SearchBackend):
    id = "you"
    label = "You.com"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.ydc-index.io/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(
                self.endpoint,
                params={"query": query, "num_web_results": top_n},
                headers={"X-API-Key": self.api_key},
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("description", ""),
                published_at=item.get("page_age"),
                raw=item,
            )
            for item in json.get("hits", [])
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 8. Perplexity (search api)
# ─────────────────────────────────────────────────────────────────────────────

class PerplexityBackend(SearchBackend):
    id = "perplexity"
    label = "Perplexity (search)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.perplexity.ai/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        body: dict[str, Any] = {
            "query": query,
            "max_results": top_n,
            "max_tokens_per_page": 1024,
        }
        if recency:
            body["search_recency_filter"] = recency  # "day" / "week" / "month" / "year"
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(
                self.endpoint,
                json=body,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("text", "")[:500],
                published_at=item.get("date"),
                raw=item,
            )
            for item in json.get("results", [])
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 9. Exa-Neuron
# ─────────────────────────────────────────────────────────────────────────────

class ExaNeuronBackend(ExaBackend):
    """Exa-Neuron uses a different endpoint (`/v2/neuron-search`) and adds
    neural-ranking on top of the standard Exa search."""
    id = "exa-neuron"
    label = "Exa Neuron"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.exa.ai/v2/neuron-search")


# ─────────────────────────────────────────────────────────────────────────────
# 10. OpenAI (via Responses web search tool)
# ─────────────────────────────────────────────────────────────────────────────

class OpenAIWebSearchBackend(SearchBackend):
    id = "openai"
    label = "OpenAI (web_search tool)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.openai.com/v1/responses")
        self.model = opts.get("model", "gpt-4.1")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 30.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        body = {
            "model": self.model,
            "input": [{"role": "user", "content": [{"type": "input_text", "text": query}]}],
            "tools": [{"type": "web_search", "search_context_size": "high"}],
            "max_output_tokens": 2048,
        }
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(
                self.endpoint,
                json=body,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results: list[SearchResult] = []
        for item in json.get("output", []):
            if item.get("type") == "web_search_call":
                # OpenAI doesn't return the actual page list; it returns an
                # action payload. We surface the action as a single result
                # for transparency.
                action = item.get("action", {})
                results.append(SearchResult(
                    title=f"OpenAI web_search: {action.get('query', query)}",
                    url=action.get("url", ""),
                    snippet=action.get("type", ""),
                    raw=item,
                ))
        # Also extract the assistant's text content as a synthetic result
        text = json.get("output_text", "").strip()
        if text and not results:
            results.append(SearchResult(
                title="OpenAI web_search answer",
                url="",
                snippet=text[:500],
                raw=json,
            ))
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 11. Anthropic (web search via messages API; when available)
# ─────────────────────────────────────────────────────────────────────────────

class AnthropicWebSearchBackend(SearchBackend):
    id = "anthropic"
    label = "Anthropic (web_search tool)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.anthropic.com/v1/messages")
        self.model = opts.get("model", "claude-sonnet-4-5")
        self.version = opts.get("anthropic-version", "2023-06-01")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 30.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        body = {
            "model": self.model,
            "max_tokens": 2048,
            "tools": [
                {
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": 3,
                }
            ],
            "messages": [{"role": "user", "content": query}],
        }
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(
                self.endpoint,
                json=body,
                headers={
                    "x-api-key": self.api_key or "",
                    "anthropic-version": self.version,
                    "content-type": "application/json",
                },
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results: list[SearchResult] = []
        for item in json.get("content", []):
            if item.get("type") == "web_search_tool_result":
                payload = item.get("content", [])
                if isinstance(payload, list):
                    for p in payload:
                        if p.get("type") == "web_search_result":
                            enc = p.get("encrypted_content", "")
                            results.append(SearchResult(
                                title=p.get("title", ""),
                                url=p.get("url", ""),
                                snippet=p.get("page_age", ""),
                                published_at=p.get("page_age"),
                                raw=p,
                            ))
        text_parts = [c.get("text", "") for c in json.get("content", []) if c.get("type") == "text"]
        text = "".join(text_parts).strip()
        if text and not results:
            results.append(SearchResult(
                title="Anthropic web_search answer",
                url="",
                snippet=text[:500],
                raw=json,
            ))
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 12. Valyu
# ─────────────────────────────────────────────────────────────────────────────

class ValyuBackend(SearchBackend):
    id = "valyu"
    label = "Valyu"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.valyu.ai/v1/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        body = {"query": query, "max_results": top_n, "search_type": "web"}
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(
                self.endpoint,
                json=body,
                headers={"x-api-key": self.api_key, "Content-Type": "application/json"},
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        json = r.json()
        results = [
            SearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("content", ""),
                published_at=item.get("date"),
                raw=item,
            )
            for item in json.get("results", [])
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw=json,
        )


# ─────────────────────────────────────────────────────────────────────────────
# 13. Cloudflare (browser rendering + AI extraction)
# ─────────────────────────────────────────────────────────────────────────────

class CloudflareBackend(SearchBackend):
    id = "cloudflare"
    label = "Cloudflare (browser rendering + AI)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.account = opts.get("account_id", os.getenv("CLOUDFLARE_ACCOUNT_ID", ""))
        self.endpoint = opts.get(
            "endpoint",
            f"https://api.cloudflare.com/client/v4/accounts/{self.account}/browser-rendering/scrape",
        )
        self.ai_endpoint = opts.get(
            "ai_endpoint",
            f"https://api.cloudflare.com/client/v4/accounts/{self.account}/ai/run/@cf/meta/llama-3.1-8b-instruct",
        )

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 30.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        # Cloudflare doesn't have a first-class web-search API; it offers
        # browser-rendering + AI summarization. As a search backend we use
        # a Bing-style HTML scrape via the browser-rendering endpoint, then
        # summarize with Workers AI. The caller is expected to have
        # configured `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_KEY`.
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            scrape = await c.post(
                self.endpoint,
                json={
                    "url": f"https://duckduckgo.com/?q={query}",
                    "html": False,
                    "render": True,
                    "screenshot": False,
                },
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=timeout_s,
            )
            if scrape.status_code != 200:
                raise SearchError(
                    f"HTTP {scrape.status_code}: {scrape.text[:200]}",
                    self.id, scrape.status_code,
                )
            text = (scrape.json() or {}).get("result", "")
            summary = await c.post(
                self.ai_endpoint,
                json={
                    "messages": [
                        {"role": "system", "content": "Extract the top search result links and titles. Return JSON: {results: [{title, url}]}."},
                        {"role": "user", "content": text[:8000]},
                    ]
                },
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=timeout_s,
            )
            if summary.status_code != 200:
                raise SearchError(
                    f"AI extraction HTTP {summary.status_code}",
                    self.id, summary.status_code,
                )
            answer = (summary.json() or {}).get("result", {}).get("response", "")
        finally:
            if client is None:
                await c.aclose()
        results = [
            SearchResult(
                title=r.get("title", ""),
                url=r.get("url", ""),
                snippet="",
                raw=r,
            )
            for r in self._parse_ai_results(answer)[:top_n]
        ]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
        )

    @staticmethod
    def _parse_ai_results(text: str) -> list[dict[str, str]]:
        import json
        import re
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                obj = json.loads(m.group(0))
                if isinstance(obj, dict) and "results" in obj:
                    return obj["results"]
            except Exception:
                pass
        return []


# ─────────────────────────────────────────────────────────────────────────────
# 14. DuckDuckGo (HTML scrape; last-resort fallback)
# ─────────────────────────────────────────────────────────────────────────────

class DuckDuckGoBackend(SearchBackend):
    id = "ddg"
    label = "DuckDuckGo (HTML scrape)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.requires_api_key = False
        self.endpoint = opts.get("endpoint", "https://html.duckduckgo.com/html/")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(
                self.endpoint,
                data={"q": query, "kl": "us-en"},
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
                    "Accept": "text/html",
                },
                timeout=timeout_s,
            )
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}", self.id, r.status_code)
        results = self._parse_html(r.text)[:top_n]
        return SearchResponse(
            query=query, backend=self.id, results=results,
            duration_ms=int((time.time() - t0) * 1000),
            raw={"html_len": len(r.text)},
        )

    @staticmethod
    def _parse_html(html: str) -> list[SearchResult]:
        import re
        results: list[SearchResult] = []
        # DuckDuckGo HTML wraps each result in <a class="result__a" href="...">title</a>
        # and a <a class="result__snippet">snippet</a>.
        anchor_re = re.compile(
            r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            re.S,
        )
        snippet_re = re.compile(
            r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
            re.S,
        )
        for m, sm in zip(anchor_re.finditer(html), snippet_re.finditer(html)):
            url = m.group(1)
            if "uddg=" in url:
                # DDG redirects via ?uddg=
                from urllib.parse import parse_qs, urlparse
                q = parse_qs(urlparse(url).query).get("uddg", [url])[0]
                url = q
            title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
            snippet = re.sub(r"<[^>]+>", "", sm.group(1)).strip()
            results.append(SearchResult(
                title=title,
                url=url,
                snippet=snippet,
            ))
        return results


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def recency_to_start(recency: str) -> str:
    """Convert "24h"/"7d"/"30d"/"90d" to an ISO start date."""
    from datetime import datetime, timedelta, timezone
    days = recency_to_days(recency)
    if days <= 0:
        return datetime.now(timezone.utc).isoformat()
    start = datetime.now(timezone.utc) - timedelta(days=days)
    return start.isoformat()


def recency_to_days(recency: str) -> int:
    rec = recency.lower().strip()
    if rec in ("day", "1d", "24h"):
        return 1
    if rec in ("week", "7d", "1w"):
        return 7
    if rec in ("month", "30d"):
        return 30
    if rec in ("quarter", "90d"):
        return 90
    if rec in ("year", "1y", "365d"):
        return 365
    if rec.endswith("d") and rec[:-1].isdigit():
        return int(rec[:-1])
    if rec.endswith("h") and rec[:-1].isdigit():
        return max(1, int(rec[:-1]) // 24)
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# Chain runner
# ─────────────────────────────────────────────────────────────────────────────

# Default priority order (top to bottom). The first backend that returns
# ≥ min_results is used; the rest are skipped unless the caller asks for
# parallel fan-out.
DEFAULT_CHAIN: list[type[SearchBackend]] = [
    ExaBackend,
    TavilyBackend,
    ParallelBackend,
    PerplexityBackend,
    ExaNeuronBackend,
    JinaBackend,
    BraveBackend,
    KagiBackend,
    YouBackend,
    ValyuBackend,
    OpenAIWebSearchBackend,
    AnthropicWebSearchBackend,
    CloudflareBackend,
    DuckDuckGoBackend,  # last resort — no API key needed
]


def default_backends_from_env() -> list[SearchBackend]:
    """Build the chain from environment variables. Backends without an
    API key set (and that require one) are skipped."""
    return [
        cls(api_key=os.getenv(f"{cls.id.upper().replace('-', '_')}_API_KEY") or os.getenv(f"{cls.id.upper()}_API_KEY"))
        for cls in DEFAULT_CHAIN
    ]


@dataclass(slots=True)
class ChainOptions:
    backends: list[SearchBackend] = field(default_factory=default_backends_from_env)
    min_results: int = 1
    per_backend_timeout_s: float = 15.0
    total_budget_ms: int = 25_000
    parallel: bool = False
    max_concurrency: int = 4
    cache: Optional["SearchCache"] = None  # type: ignore


class SearchCache:
    """Simple in-process LRU + TTL cache. Persistent caches can be plugged
    in by replacing this class with a Redis-backed one."""
    def __init__(self, ttl_s: int = 600, max_entries: int = 256) -> None:
        self.ttl_s = ttl_s
        self.max_entries = max_entries
        self._store: dict[tuple[str, tuple[str, ...]], tuple[float, SearchResponse]] = {}

    def _key(self, backend_id: str, query: str, top_n: int, recency: Optional[str]) -> tuple[str, tuple[str, ...]]:
        return (backend_id, (query, str(top_n), recency or ""))

    def get(self, backend_id: str, query: str, top_n: int, recency: Optional[str]) -> Optional[SearchResponse]:
        k = self._key(backend_id, query, top_n, recency)
        v = self._store.get(k)
        if not v:
            return None
        ts, resp = v
        if time.time() - ts > self.ttl_s:
            self._store.pop(k, None)
            return None
        # Use `dataclasses.replace` so we work with @dataclass(slots=True) too
        # (those classes don't expose `__dict__`).
        return dataclasses.replace(resp, cached=True)

    def put(self, backend_id: str, query: str, top_n: int, recency: Optional[str], resp: SearchResponse) -> None:
        if len(self._store) >= self.max_entries:
            # Drop oldest
            oldest = min(self._store.items(), key=lambda kv: kv[1][0])
            self._store.pop(oldest[0], None)
        k = self._key(backend_id, query, top_n, recency)
        self._store[k] = (time.time(), resp)


class WebSearchChain:
    def __init__(self, options: Optional[ChainOptions] = None) -> None:
        self.options = options or ChainOptions()
        self.cache = self.options.cache or SearchCache()
        self._semaphore = asyncio.Semaphore(self.options.max_concurrency)

    async def run(
        self,
        query: str,
        *,
        top_n: int = 8,
        recency: Optional[str] = None,
    ) -> SearchResponse:
        # Quick global timeout
        async def _runner() -> SearchResponse:
            if self.options.parallel:
                return await self._run_parallel(query, top_n=top_n, recency=recency)
            return await self._run_sequential(query, top_n=top_n, recency=recency)
        return await asyncio.wait_for(_runner(), timeout=self.options.total_budget_ms / 1000.0)

    async def _run_sequential(
        self, query: str, *, top_n: int, recency: Optional[str],
    ) -> SearchResponse:
        last_error: Optional[Exception] = None
        async with httpx.AsyncClient() as client:
            for backend in self.options.backends:
                try:
                    cached = self.cache.get(backend.id, query, top_n, recency)
                    if cached:
                        return cached
                    resp = await backend.search(
                        query, top_n=top_n, recency=recency,
                        timeout_s=self.options.per_backend_timeout_s, client=client,
                    )
                    self.cache.put(backend.id, query, top_n, recency, resp)
                    if len(resp.results) >= self.options.min_results:
                        return resp
                except SearchError as e:
                    last_error = e
                    logger.debug("backend %s failed: %s", backend.id, e)
                    continue
                except Exception as e:  # pragma: no cover
                    last_error = e
                    logger.exception("backend %s crashed", backend.id)
                    continue
        # If we got here, every backend failed. Return a synthetic empty
        # response so the caller can still surface a useful error.
        return SearchResponse(
            query=query, backend="<chain>", results=[],
            duration_ms=0,
            raw={"errors": str(last_error) if last_error else None},
        )

    async def _run_parallel(
        self, query: str, *, top_n: int, recency: Optional[str],
    ) -> SearchResponse:
        async with httpx.AsyncClient() as client:
            async def one(b: SearchBackend) -> Optional[SearchResponse]:
                try:
                    async with self._semaphore:
                        cached = self.cache.get(b.id, query, top_n, recency)
                        if cached:
                            return cached
                        resp = await b.search(
                            query, top_n=top_n, recency=recency,
                            timeout_s=self.options.per_backend_timeout_s, client=client,
                        )
                        self.cache.put(b.id, query, top_n, recency, resp)
                        return resp
                except Exception as e:
                    logger.debug("parallel backend %s failed: %s", b.id, e)
                    return None
            tasks = [asyncio.create_task(one(b)) for b in self.options.backends]
            results = await asyncio.gather(*tasks)
        non_empty = [r for r in results if r and r.results]
        if not non_empty:
            return SearchResponse(
                query=query, backend="<parallel-chain>", results=[],
                duration_ms=0,
            )
        # Use the one with the most results; tie-break by shortest duration.
        chosen = max(non_empty, key=lambda r: (len(r.results), -r.duration_ms))
        return chosen


# ─────────────────────────────────────────────────────────────────────────────
# Singleton accessor
# ─────────────────────────────────────────────────────────────────────────────

_chain: Optional[WebSearchChain] = None


def get_chain() -> WebSearchChain:
    global _chain
    if _chain is None:
        _chain = WebSearchChain()
    return _chain


def reset_chain() -> None:
    global _chain
    _chain = None
