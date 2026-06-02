"""Scraper router."""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .registry import ScraperRegistry
from .types import ScrapeRequest
from .providers import FirecrawlProvider, ScrapingBeeProvider

router = APIRouter(prefix="/scrapers", tags=["scrapers"])

_registry = ScraperRegistry()
_registry.register_provider("firecrawl", FirecrawlProvider(api_key=os.environ.get("FIRECRAWL_API_KEY", "")))
_registry.register_provider("scrapingbee", ScrapingBeeProvider(api_key=os.environ.get("SCRAPINGBEE_API_KEY", "")))


class ScrapeBody(BaseModel):
    url: str
    fields: list[str] = Field(default_factory=list)
    max_tokens: int = 8000
    provider: str = "builtin"


@router.get("/domains")
async def list_domains() -> list[str]:
    return _registry.list_domains()


@router.post("/scrape")
async def scrape(body: ScrapeBody) -> dict[str, Any]:
    req = ScrapeRequest(
        url=body.url, fields=body.fields,
        max_tokens=body.max_tokens, provider=body.provider,
    )
    res = await _registry.scrape(req)
    return res.to_dict()
