"""Scraper providers (builtin HTML/JSON-LD extractor + remote providers)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from .types import ScrapeResult


class ScraperProvider(Protocol):
    name: str
    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult: ...


@dataclass
class BuiltinProvider:
    name: str = "builtin"

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as c:
            r = await c.get(url, headers={"User-Agent": "pakalon/1.0"})
            r.raise_for_status()
            html = r.text
        title = _extract_title(html)
        json_ld = _extract_jsonld(html)
        # Synthesize content from main text containers
        content = _extract_text(html)[: 20_000]
        fields: dict[str, Any] = {
            "title": title, "content_excerpt": content[:1000],
        }
        # Map adapter-declared fields to content
        for f in adapter.get("fields", []):
            if f not in fields:
                fields[f] = content
        return ScrapeResult(
            id="", url=url, domain="", title=title, content=content,
            json_ld=json_ld, fields=fields, provider=self.name,
        )


@dataclass
class FirecrawlProvider:
    api_key: str = ""
    name: str = "firecrawl"

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return ScrapeResult(
                id="", url=url, domain="", title="", content="",
                json_ld=[], fields={}, provider=self.name,
                error="FIRECRAWL_API_KEY not set",
            )
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.post(
                "https://api.firecrawl.dev/v1/scrape",
                json={"url": url, "formats": ["markdown", "extract"]},
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            r.raise_for_status()
            data = r.json()
        return ScrapeResult(
            id="", url=url, domain="", title=data.get("data", {}).get("metadata", {}).get("title", ""),
            content=data.get("data", {}).get("markdown", ""),
            json_ld=[], fields=data.get("data", {}).get("extract", {}),
            provider=self.name,
        )


@dataclass
class ScrapingBeeProvider:
    api_key: str = ""
    name: str = "scrapingbee"

    async def scrape(self, url: str, adapter: dict[str, Any]) -> ScrapeResult:
        if not self.api_key:
            return ScrapeResult(
                id="", url=url, domain="", title="", content="",
                json_ld=[], fields={}, provider=self.name,
                error="SCRAPINGBEE_API_KEY not set",
            )
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.get(
                "https://app.scrapingbee.com/api/v1/",
                params={"api_key": self.api_key, "url": url, "render_js": "false"},
            )
            r.raise_for_status()
            html = r.text
        title = _extract_title(html)
        content = _extract_text(html)[: 20_000]
        return ScrapeResult(
            id="", url=url, domain="", title=title, content=content,
            json_ld=_extract_jsonld(html), fields={"title": title},
            provider=self.name,
        )


def _extract_title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if m:
        return _clean(m.group(1))
    m = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
    if m:
        return _clean(m.group(1))
    return ""


def _extract_jsonld(html: str) -> list[dict]:
    out: list[dict] = []
    import json
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.IGNORECASE | re.DOTALL,
    ):
        try:
            obj = json.loads(m.group(1))
            if isinstance(obj, list):
                out.extend(obj)
            else:
                out.append(obj)
        except Exception:
            continue
    return out


def _extract_text(html: str) -> str:
    # Strip script/style then tags.
    no_script = re.sub(r"<script.*?</script>", " ", html, flags=re.IGNORECASE | re.DOTALL)
    no_style = re.sub(r"<style.*?</style>", " ", no_script, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", no_style)
    text = re.sub(r"\s+", " ", text)
    return _clean(text)


def _clean(s: str) -> str:
    return s.strip()
