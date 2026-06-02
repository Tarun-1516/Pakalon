"""Additional web-search backends (CurrentsAPI, NewsAPI, Serper,
Google PSE, Bing, Brave News, Mojeek, SearXNG, Yandex, Kagi Summarizer).

Additive on top of the 14 backends in :mod:`app.web_search.chain`.
Add a backend by:

  1. Subclass :class:`SearchBackend`
  2. Add the class to :data:`EXTRA_CHAIN` (it gets appended after
     the existing 14).

The dispatcher in :func:`app.web_search.chain.get_chain` is left
untouched; new backends are exported through a *new* singleton in
:mod:`app.web_search.extra`.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from .chain import SearchBackend, SearchError, SearchResponse, SearchResult

logger = logging.getLogger(__name__)


# ─── News / fresh-content backends ─────────────────────────────────────────

class CurrentsAPIBackend(SearchBackend):
    """CurrentsAPI — fresh news across many sources. No key for free tier."""
    id = "currents"
    label = "CurrentsAPI (news)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.requires_api_key = False
        self.endpoint = opts.get("endpoint", "https://api.currentsapi.services/v1/latest-news")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            params: dict[str, Any] = {"keywords": query, "page_size": top_n}
            if self.api_key:
                params["apiKey"] = self.api_key
            r = await c.get(self.endpoint, params=params, timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        results = [
            SearchResult(
                title=n.get("title", ""),
                url=n.get("url", ""),
                snippet=(n.get("description") or "")[:500],
                published_at=n.get("published"),
                image_url=n.get("image"),
                raw=n,
            )
            for n in (data.get("news") or [])[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


class NewsAPIBackend(SearchBackend):
    """NewsAPI.org — global news with a free developer tier."""
    id = "newsapi"
    label = "NewsAPI (news)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://newsapi.org/v2/everything")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            params: dict[str, Any] = {"q": query, "pageSize": top_n, "sortBy": "publishedAt"}
            if recency == "day":
                params["from"] = _iso_days_ago(1)
            elif recency == "week":
                params["from"] = _iso_days_ago(7)
            elif recency == "month":
                params["from"] = _iso_days_ago(30)
            r = await c.get(self.endpoint, params=params,
                            headers={"X-Api-Key": self.api_key}, timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        results = [
            SearchResult(
                title=a.get("title", ""), url=a.get("url", ""),
                snippet=(a.get("description") or "")[:500],
                published_at=a.get("publishedAt"),
                author=a.get("author"),
                image_url=a.get("urlToImage"), raw=a,
            )
            for a in (data.get("articles") or [])[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


# ─── General search (Serper, Google PSE, Bing) ─────────────────────────────

class SerperBackend(SearchBackend):
    """Serper.dev — Google SERP API, very fast."""
    id = "serper"
    label = "Serper (Google SERP)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://google.serper.dev/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.post(self.endpoint, json={"q": query, "num": top_n},
                             headers={"X-API-KEY": self.api_key,
                                      "Content-Type": "application/json"},
                             timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        results = [
            SearchResult(
                title=o.get("title", ""), url=o.get("link", ""),
                snippet=o.get("snippet", ""),
                favicon_url=o.get("favicon"),
                raw=o,
            )
            for o in (data.get("organic") or [])[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


class GooglePSEBackend(SearchBackend):
    """Google Programmable Search Engine (CSE)."""
    id = "google_cse"
    label = "Google CSE"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.cx = opts.get("cx") or os.getenv("GOOGLE_CSE_CX", "")
        self.endpoint = opts.get("endpoint", "https://www.googleapis.com/customsearch/v1")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        if not self.cx:
            raise SearchError("GOOGLE_CSE_CX env var is required", self.id)
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(self.endpoint, params={"key": self.api_key, "cx": self.cx,
                                                    "q": query, "num": top_n},
                            timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        results = [
            SearchResult(
                title=i.get("title", ""), url=i.get("link", ""),
                snippet=i.get("snippet", ""),
                raw=i,
            )
            for i in (data.get("items") or [])[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


class BingSearchBackend(SearchBackend):
    """Bing Web Search API v7."""
    id = "bing"
    label = "Bing Web Search"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.bing.microsoft.com/v7.0/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(self.endpoint, params={"q": query, "count": top_n,
                                                    "mkt": "en-US"},
                            headers={"Ocp-Apim-Subscription-Key": self.api_key},
                            timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        web_pages = (data.get("webPages") or {}).get("value") or []
        results = [
            SearchResult(
                title=i.get("name", ""), url=i.get("url", ""),
                snippet=i.get("snippet", ""),
                raw=i,
            )
            for i in web_pages[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


# ─── Privacy-friendly / open backends ───────────────────────────────────────

class MojeekBackend(SearchBackend):
    """Mojeek — privacy-respecting, no tracking, no API key needed."""
    id = "mojeek"
    label = "Mojeek (privacy)"
    requires_api_key = False

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://www.mojeek.com/search.json")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(self.endpoint, params={"q": query, "fmt": "json", "limit": top_n},
                            headers={"User-Agent": "Pakalon/1.0"}, timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        results = [
            SearchResult(
                title=i.get("title", ""), url=i.get("url", ""),
                snippet=i.get("desc", ""),
                raw=i,
            )
            for i in (data.get("results") or [])[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


class SearXNGBackend(SearchBackend):
    """SearXNG — open metasearch; point at any public instance."""
    id = "searxng"
    label = "SearXNG (metasearch)"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.requires_api_key = False
        self.instance = opts.get("instance") or os.getenv(
            "SEARXNG_INSTANCE", "https://searx.be/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(self.instance, params={"q": query, "format": "json",
                                                    "language": "en", "safesearch": 0},
                            headers={"User-Agent": "Pakalon/1.0",
                                     "Accept": "application/json"},
                            timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        results = [
            SearchResult(
                title=i.get("title", ""), url=i.get("url", ""),
                snippet=i.get("content", ""),
                raw=i,
            )
            for i in (data.get("results") or [])[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


class YandexSearchBackend(SearchBackend):
    """Yandex XML search (paid; free tier via XML API key)."""
    id = "yandex"
    label = "Yandex XML"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.user = opts.get("user") or os.getenv("YANDEX_USER", "")
        self.endpoint = opts.get("endpoint", "https://yandex.com/search/xml")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        if not self.user:
            raise SearchError("YANDEX_USER env var is required", self.id)
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(self.endpoint,
                            params={"key": self.api_key, "user": self.user,
                                    "query": query, "l10n": "en", "filter": "none",
                                    "maxpassages": 2, "groupby": f"mode=flat groups=on docs-in-group={top_n}"},
                            timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        # Yandex XML — we do a simple regex parse of <url> <title> pairs.
        results = self._parse_xml(r.text, top_n)
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000),
                              raw={"xml_len": len(r.text)})

    @staticmethod
    def _parse_xml(xml: str, top_n: int) -> list[SearchResult]:
        import re
        out: list[SearchResult] = []
        # <doc><url>…</url><title>…</title><passages><passage>…</passage></passages></doc>
        for m in re.finditer(
            r'<doc[^>]*>\s*<url>(.*?)</url>\s*<title>(.*?)</title>.*?(?:<passage>(.*?)</passage>)?',
            xml, re.S,
        ):
            out.append(SearchResult(
                title=re.sub(r"<[^>]+>", "", m.group(2)).strip(),
                url=m.group(1).strip(),
                snippet=re.sub(r"<[^>]+>", "", m.group(3) or "").strip()[:500],
            ))
            if len(out) >= top_n:
                break
        return out


# ─── Brave news (verticalised) ─────────────────────────────────────────────

class BraveNewsBackend(SearchBackend):
    """Brave News API — news-specific vertical of the Brave Search API."""
    id = "brave_news"
    label = "Brave News"

    def __init__(self, api_key: Optional[str] = None, **opts: Any) -> None:
        super().__init__(api_key, **opts)
        self.endpoint = opts.get("endpoint", "https://api.search.brave.com/res/v1/news/search")

    async def search(
        self, query: str, *, top_n: int = 8, recency: Optional[str] = None,
        timeout_s: float = 15.0, client: Optional[httpx.AsyncClient] = None,
    ) -> SearchResponse:
        self._check_key()
        t0 = time.time()
        c = client or httpx.AsyncClient()
        try:
            r = await c.get(self.endpoint, params={"q": query, "count": top_n,
                                                    "freshness": recency or "pd"},
                            headers={"X-Subscription-Token": self.api_key,
                                     "Accept": "application/json"},
                            timeout=timeout_s)
        finally:
            if client is None:
                await c.aclose()
        if r.status_code != 200:
            raise SearchError(f"HTTP {r.status_code}: {r.text[:200]}", self.id, r.status_code)
        data = r.json()
        results = [
            SearchResult(
                title=i.get("title", ""), url=i.get("url", ""),
                snippet=i.get("description", ""),
                published_at=i.get("age"),
                image_url=(i.get("thumbnail") or {}).get("src"),
                raw=i,
            )
            for i in (data.get("results") or [])[:top_n]
        ]
        return SearchResponse(query=query, backend=self.id, results=results,
                              duration_ms=int((time.time() - t0) * 1000), raw=data)


# ─── Helper ────────────────────────────────────────────────────────────────

def _iso_days_ago(days: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


# ─── Extra chain order ────────────────────────────────────────────────────

EXTRA_CHAIN: list[type[SearchBackend]] = [
    CurrentsAPIBackend,
    NewsAPIBackend,
    SerperBackend,
    GooglePSEBackend,
    BingSearchBackend,
    BraveNewsBackend,
    MojeekBackend,
    SearXNGBackend,
    YandexSearchBackend,
]
