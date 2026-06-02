"""Scraper shared types: request, result, domain table (no providers)."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ScrapeRequest:
    url: str
    fields: list[str] = field(default_factory=list)
    max_tokens: int = 8000
    provider: str = "builtin"


@dataclass(slots=True)
class ScrapeResult:
    id: str
    url: str
    domain: str
    title: str
    content: str
    json_ld: list[dict]
    fields: dict[str, Any]
    provider: str
    duration: float = 0.0
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "url": self.url, "domain": self.domain,
            "title": self.title, "content": self.content,
            "json_ld": self.json_ld, "fields": self.fields,
            "provider": self.provider, "duration": self.duration,
            "error": self.error,
        }


# 78 domain adapters — most extract structured fields (title/content/json_ld)
# plus optional selectors specific to the domain.
SCRAPER_DOMAINS: dict[str, dict[str, Any]] = {
    "anthropic.com": {"fields": ["title", "description", "models"]},
    "openai.com": {"fields": ["title", "description", "research"]},
    "google.com": {"fields": ["title", "snippet"]},
    "github.com": {"fields": ["repo", "readme", "stars", "language"]},
    "gitlab.com": {"fields": ["repo", "readme", "stars"]},
    "bitbucket.org": {"fields": ["repo", "readme"]},
    "huggingface.co": {"fields": ["model", "readme", "tags"]},
    "arxiv.org": {"fields": ["title", "authors", "abstract", "pdf"]},
    "stackoverflow.com": {"fields": ["question", "answers", "tags"]},
    "reddit.com": {"fields": ["title", "comments"]},
    "twitter.com": {"fields": ["tweet", "author"]},
    "x.com": {"fields": ["tweet", "author"]},
    "news.ycombinator.com": {"fields": ["title", "comments"]},
    "medium.com": {"fields": ["title", "body"]},
    "dev.to": {"fields": ["title", "body", "tags"]},
    "linkedin.com": {"fields": ["profile", "experience"]},
    "wikipedia.org": {"fields": ["title", "summary", "sections"]},
    "mozilla.org": {"fields": ["title", "docs"]},
    "w3.org": {"fields": ["spec", "title"]},
    "w3schools.com": {"fields": ["title", "example"]},
    "mdn.io": {"fields": ["title", "docs"]},
    "developer.mozilla.org": {"fields": ["title", "docs"]},
    "npmjs.com": {"fields": ["package", "readme"]},
    "pypi.org": {"fields": ["package", "readme"]},
    "crates.io": {"fields": ["crate", "readme"]},
    "rubygems.org": {"fields": ["gem", "readme"]},
    "go.dev": {"fields": ["package", "docs"]},
    "pkg.go.dev": {"fields": ["package", "docs"]},
    "docs.python.org": {"fields": ["title", "docs"]},
    "docs.rs": {"fields": ["crate", "docs"]},
    "react.dev": {"fields": ["title", "docs"]},
    "vuejs.org": {"fields": ["title", "docs"]},
    "angular.io": {"fields": ["title", "docs"]},
    "svelte.dev": {"fields": ["title", "docs"]},
    "solidjs.com": {"fields": ["title", "docs"]},
    "nextjs.org": {"fields": ["title", "docs"]},
    "nuxt.com": {"fields": ["title", "docs"]},
    "remix.run": {"fields": ["title", "docs"]},
    "fastapi.tiangolo.com": {"fields": ["title", "docs"]},
    "flask.palletsprojects.com": {"fields": ["title", "docs"]},
    "django.com": {"fields": ["title", "docs"]},
    "djangoproject.com": {"fields": ["title", "docs"]},
    "expressjs.com": {"fields": ["title", "docs"]},
    "nestjs.com": {"fields": ["title", "docs"]},
    "rust-lang.org": {"fields": ["title", "docs"]},
    "typescriptlang.org": {"fields": ["title", "docs"]},
    "kotlinlang.org": {"fields": ["title", "docs"]},
    "swift.org": {"fields": ["title", "docs"]},
    "rubyonrails.org": {"fields": ["title", "docs"]},
    "elixir-lang.org": {"fields": ["title", "docs"]},
    "phoenixframework.org": {"fields": ["title", "docs"]},
    "dotnet.microsoft.com": {"fields": ["title", "docs"]},
    "learn.microsoft.com": {"fields": ["title", "docs"]},
    "docs.oracle.com": {"fields": ["title", "docs"]},
    "cloud.google.com": {"fields": ["title", "docs"]},
    "aws.amazon.com": {"fields": ["title", "docs"]},
    "azure.microsoft.com": {"fields": ["title", "docs"]},
    "digitalocean.com": {"fields": ["title", "docs"]},
    "vercel.com": {"fields": ["title", "docs"]},
    "netlify.com": {"fields": ["title", "docs"]},
    "render.com": {"fields": ["title", "docs"]},
    "fly.io": {"fields": ["title", "docs"]},
    "supabase.com": {"fields": ["title", "docs"]},
    "firebase.google.com": {"fields": ["title", "docs"]},
    "planetscale.com": {"fields": ["title", "docs"]},
    "neon.tech": {"fields": ["title", "docs"]},
    "prisma.io": {"fields": ["title", "docs"]},
    "drizzle.team": {"fields": ["title", "docs"]},
    "stripe.com": {"fields": ["title", "docs"]},
    "paypal.com": {"fields": ["title", "docs"]},
    "docs.stripe.com": {"fields": ["title", "docs"]},
    "shopify.dev": {"fields": ["title", "docs"]},
    "twilio.com": {"fields": ["title", "docs"]},
    "sendgrid.com": {"fields": ["title", "docs"]},
    "mailgun.com": {"fields": ["title", "docs"]},
    "auth0.com": {"fields": ["title", "docs"]},
    "clerk.com": {"fields": ["title", "docs"]},
    "okta.com": {"fields": ["title", "docs"]},
    "polar.sh": {"fields": ["title", "docs"]},
    "svix.com": {"fields": ["title", "docs"]},
    "resend.com": {"fields": ["title", "docs"]},
    "postmarkapp.com": {"fields": ["title", "docs"]},
    "playwright.dev": {"fields": ["title", "docs"]},
    "cypress.io": {"fields": ["title", "docs"]},
    "selenium.dev": {"fields": ["title", "docs"]},
    "pptr.dev": {"fields": ["title", "docs"]},
    "firecrawl.dev": {"fields": ["title", "docs"]},
    "scrapingbee.com": {"fields": ["title", "docs"]},
    "browsercat.com": {"fields": ["title", "docs"]},
}
