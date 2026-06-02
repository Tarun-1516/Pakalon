"""Scrapers: domain adapters + pluggable providers.

The scraper registry can pull from Firecrawl, ScrapingBee, BrowserCat,
or run a lightweight built-in HTML+JSON-LD extractor as a fallback.
"""
from __future__ import annotations

from .types import SCRAPER_DOMAINS, ScrapeRequest, ScrapeResult
from .registry import ScraperRegistry
from .providers import (
    ScraperProvider, BuiltinProvider, FirecrawlProvider, ScrapingBeeProvider,
)

__all__ = [
    "SCRAPER_DOMAINS", "ScraperRegistry", "ScrapeRequest", "ScrapeResult",
    "ScraperProvider", "BuiltinProvider", "FirecrawlProvider", "ScrapingBeeProvider",
]
