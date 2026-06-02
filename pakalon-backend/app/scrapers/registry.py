"""Scraper registry: routes scrape requests to providers."""
from __future__ import annotations

import time
import uuid
from typing import Any

from .types import ScrapeRequest, ScrapeResult, SCRAPER_DOMAINS
from .providers import BuiltinProvider, ScraperProvider


def _domain_of(url: str) -> str:
    from urllib.parse import urlparse
    host = urlparse(url).hostname or ""
    parts = host.split(".")
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return host


class ScraperRegistry:
    def __init__(self, providers: dict[str, ScraperProvider] | None = None) -> None:
        self.providers: dict[str, ScraperProvider] = providers or {
            "builtin": BuiltinProvider(),
        }

    def register_provider(self, name: str, provider: ScraperProvider) -> None:
        self.providers[name] = provider

    def list_domains(self) -> list[str]:
        return sorted(SCRAPER_DOMAINS.keys())

    def get_adapter(self, domain: str) -> dict[str, Any]:
        return SCRAPER_DOMAINS.get(domain, {"fields": ["title", "content"]})

    async def scrape(self, req: ScrapeRequest) -> ScrapeResult:
        provider = self.providers.get(req.provider) or self.providers["builtin"]
        adapter = self.get_adapter(_domain_of(req.url))
        t0 = time.time()
        try:
            res = await provider.scrape(req.url, adapter)
        except Exception as e:
            return ScrapeResult(
                id=f"scp_{uuid.uuid4().hex[:12]}", url=req.url,
                domain=_domain_of(req.url), title="", content="",
                json_ld=[], fields={}, provider=req.provider,
                duration=time.time() - t0, error=str(e),
            )
        res.id = f"scp_{uuid.uuid4().hex[:12]}"
        res.domain = _domain_of(req.url)
        res.duration = time.time() - t0
        return res
