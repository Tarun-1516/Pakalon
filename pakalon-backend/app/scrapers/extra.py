"""Additive scraper providers (Diffbot, ScrapingAnt, Browserless,
Apify, Zenrows, BrowseAI).

Additive on top of the existing Builtin/Firecrawl/ScrapingBee
providers in :mod:`app.scrapers.providers`.  Each provider is a
self-contained class with the same protocol:

    class ScraperProvider(Protocol):
        name: str
        async def scrape(self, url: str, adapter: dict) -> ScrapeResult: ...

Register via :func:`register_all` (called from
:mod:`app.scrapers.registry`) to extend the ``builtin`` registry.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from .types import ScrapeResult

logger = logging.getLogger(__name__)


# ─── Diffbot ───────────────────────────────────────────────────────────────

@dataclass
class DiffbotProvider:
    """Diffbot Article API — extracts clean article markdown from any URL."""
    api_key: str = ""
    name = "diffbot"

    def __init__(self) -> None:
        import os
        self.api_key = os.getenv("DIFFBOT_API_KEY", "")

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return self._err(url, "DIFFBOT_API_KEY not set")
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.get(
                "https://api.diffbot.com/v3/article",
                params={"token": self.api_key, "url": url,
                        "fields": "title,html,text,siteName,images,author,date"},
            )
            r.raise_for_status()
            data = r.json()
        objs = data.get("objects") or []
        if not objs:
            return self._err(url, "diffbot returned no objects")
        a = objs[0]
        text = a.get("text", "")
        return ScrapeResult(
            id="", url=url, domain="", title=a.get("title", ""),
            content=text, json_ld=[], fields={
                "title": a.get("title", ""),
                "siteName": a.get("siteName", ""),
                "author": a.get("author"),
                "date": a.get("date"),
                "image": ((a.get("images") or [{}])[0]).get("url") if a.get("images") else None,
            },
            provider=self.name,
        )

    def _err(self, url, msg):
        return ScrapeResult(id="", url=url, domain="", title="", content="",
                            json_ld=[], fields={}, provider=self.name, error=msg)


# ─── ScrapingAnt ───────────────────────────────────────────────────────────

@dataclass
class ScrapingAntProvider:
    api_key: str = ""
    name = "scrapingant"

    def __init__(self) -> None:
        import os
        self.api_key = os.getenv("SCRAPINGANT_API_KEY", "")

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return ScrapeResult(id="", url=url, domain="", title="", content="",
                                json_ld=[], fields={}, provider=self.name,
                                error="SCRAPINGANT_API_KEY not set")
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.get(
                "https://api.scrapingant.com/v2/general",
                params={"url": url, "x-api-key": self.api_key, "browser": "false"},
            )
            r.raise_for_status()
            html = r.text
        return _builtin_extract(url, html, self.name)


# ─── Browserless ───────────────────────────────────────────────────────────

@dataclass
class BrowserlessProvider:
    """Browserless.io — headless Chrome scraping with custom JS evaluation."""
    api_key: str = ""
    name = "browserless"

    def __init__(self) -> None:
        import os
        self.api_key = os.getenv("BROWSERLESS_API_KEY", "")

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return ScrapeResult(id="", url=url, domain="", title="", content="",
                                json_ld=[], fields={}, provider=self.name,
                                error="BROWSERLESS_API_KEY not set")
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.post(
                f"https://chrome.browserless.io/scrape?token={self.api_key}",
                json={"url": url, "elements": [
                    {"selector": "title", "attribute": "text"},
                    {"selector": "body", "attribute": "text"},
                ]},
            )
            r.raise_for_status()
            data = r.json()
        title = ""
        content = ""
        for e in data.get("data", []):
            attr = e.get("results", [{}])[0].get("text", "")
            if e.get("selector") == "title":
                title = attr
            elif e.get("selector") == "body":
                content = attr
        return ScrapeResult(
            id="", url=url, domain="", title=title, content=content[:20_000],
            json_ld=[], fields={"title": title}, provider=self.name,
        )


# ─── Apify ─────────────────────────────────────────────────────────────────

@dataclass
class ApifyProvider:
    """Apify — calls a configurable actor (e.g. 'apify/web-scraper')."""
    api_key: str = ""
    name = "apify"
    default_actor: str = "apify~web-scraper"

    def __init__(self) -> None:
        import os
        self.api_key = os.getenv("APIFY_API_KEY", "")

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return ScrapeResult(id="", url=url, domain="", title="", content="",
                                json_ld=[], fields={}, provider=self.name,
                                error="APIFY_API_KEY not set")
        actor = adapter.get("actor", self.default_actor)
        async with httpx.AsyncClient(timeout=120.0) as c:
            # Start actor run
            start = await c.post(
                f"https://api.apify.com/v2/acts/{actor}/runs",
                params={"token": self.api_key},
                json={"startUrls": [{"url": url}],
                      "useRequestQueue": False,
                      "maxRequestsPerCrawl": 1},
            )
            start.raise_for_status()
            run = start.json()
            run_id = run["data"]["id"]
            default_ds_id = run["data"]["defaultDatasetId"]

            # Poll for completion
            import asyncio
            for _ in range(60):
                await asyncio.sleep(2)
                chk = await c.get(
                    f"https://api.apify.com/v2/actor-runs/{run_id}",
                    params={"token": self.api_key},
                )
                chk.raise_for_status()
                status = chk.json()["data"]["status"]
                if status in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
                    break

            # Pull dataset
            ds = await c.get(
                f"https://api.apify.com/v2/datasets/{default_ds_id}/items",
                params={"token": self.api_key, "limit": 1},
            )
            ds.raise_for_status()
            items = ds.json()
        if not items:
            return ScrapeResult(id="", url=url, domain="", title="", content="",
                                json_ld=[], fields={}, provider=self.name,
                                error="apify returned empty dataset")
        first = items[0]
        return ScrapeResult(
            id="", url=url, domain="", title=first.get("title", ""),
            content=first.get("text") or first.get("markdown") or "",
            json_ld=[], fields=first, provider=self.name,
        )


# ─── Zenrows ───────────────────────────────────────────────────────────────

@dataclass
class ZenrowsProvider:
    api_key: str = ""
    name = "zenrows"

    def __init__(self) -> None:
        import os
        self.api_key = os.getenv("ZENROWS_API_KEY", "")

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return ScrapeResult(id="", url=url, domain="", title="", content="",
                                json_ld=[], fields={}, provider=self.name,
                                error="ZENROWS_API_KEY not set")
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.get(
                "https://api.zenrows.com/v1/",
                params={"apikey": self.api_key, "url": url, "js_render": "true"},
            )
            r.raise_for_status()
            html = r.text
        return _builtin_extract(url, html, self.name)


# ─── BrowseAI ──────────────────────────────────────────────────────────────

@dataclass
class BrowseAIProvider:
    """BrowseAI — runs a configurable 'robot' against a URL."""
    api_key: str = ""
    name = "browseai"
    default_robot: str = ""

    def __init__(self) -> None:
        import os
        self.api_key = os.getenv("BROWSEAI_API_KEY", "")

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return ScrapeResult(id="", url=url, domain="", title="", content="",
                                json_ld=[], fields={}, provider=self.name,
                                error="BROWSEAI_API_KEY not set")
        robot_id = adapter.get("robot_id", self.default_robot)
        if not robot_id:
            return ScrapeResult(id="", url=url, domain="", title="", content="",
                                json_ld=[], fields={}, provider=self.name,
                                error="browseai requires a robot_id (set per-adapter)")
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.post(
                f"https://api.browse.ai/v2/robots/{robot_id}/tasks",
                json={"inputParameters": {"url": url}},
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            r.raise_for_status()
            task = r.json()["result"]
            task_id = task["id"]
            # Poll
            import asyncio
            for _ in range(60):
                await asyncio.sleep(2)
                chk = await c.get(
                    f"https://api.browse.ai/v2/robots/{robot_id}/tasks/{task_id}",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                chk.raise_for_status()
                st = chk.json()["result"]["status"]
                if st == "successful":
                    captured = chk.json()["result"].get("capturedLists", {})
                    return ScrapeResult(
                        id="", url=url, domain="", title=url,
                        content=json.dumps(captured, ensure_ascii=False),
                        json_ld=[], fields=captured, provider=self.name,
                    )
                if st in ("failed", "aborted"):
                    return ScrapeResult(id="", url=url, domain="", title="", content="",
                                        json_ld=[], fields={}, provider=self.name,
                                        error=f"browseai task {st}")
        return ScrapeResult(id="", url=url, domain="", title="", content="",
                            json_ld=[], fields={}, provider=self.name,
                            error="browseai task timed out")


# ─── Shared helper (re-uses the existing builtin extractor) ───────────────

def _builtin_extract(url: str, html: str, provider: str) -> ScrapeResult:
    title = ""
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if m:
        title = m.group(1).strip()
    json_ld: list[dict] = []
    for jm in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.IGNORECASE | re.DOTALL,
    ):
        try:
            obj = json.loads(jm.group(1))
            json_ld.append(obj) if isinstance(obj, dict) else json_ld.extend(obj)
        except Exception:
            continue
    no_script = re.sub(r"<script.*?</script>", " ", html, flags=re.IGNORECASE | re.DOTALL)
    no_style = re.sub(r"<style.*?</style>", " ", no_script, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", no_style)).strip()
    return ScrapeResult(
        id="", url=url, domain="", title=title, content=text[:20_000],
        json_ld=json_ld, fields={"title": title}, provider=provider,
    )


# ─── Registry hook ────────────────────────────────────────────────────────

def register_all() -> None:
    """Attach these providers to the global :mod:`app.scrapers.registry`."""
    from . import registry  # local import to avoid circulars

    reg = registry.ScraperRegistry()  # default-builtin registry
    for cls in (DiffbotProvider, ScrapingAntProvider, BrowserlessProvider,
                ApifyProvider, ZenrowsProvider, BrowseAIProvider):
        try:
            reg.register_provider(cls().name, cls())
        except Exception as e:
            logger.warning("failed to register %s: %s", cls.__name__, e)
