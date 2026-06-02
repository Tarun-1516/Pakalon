"""
web_search/router.py — FastAPI router for the web search chain.

Endpoints
---------
  POST /web_search/run                — run a search across the chain
  GET  /web_search/backends           — list backends + status
  POST /web_search/{backend}/run      — run a single backend (debug/diag)
  GET  /web_search/health             — quick health check (no auth)

The chain itself is a singleton: see `chain.get_chain()`.

Auth
----
  All routes require a Bearer JWT (Supabase / OAuth / local).
  The single-backend debug route additionally requires the caller to be
  admin (or the request to come from loopback).
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from pydantic import BaseModel, Field

from app.dependencies import get_current_user
from app.models.user import User

from .chain import (
    DEFAULT_CHAIN,
    SearchResponse,
    WebSearchChain,
    default_backends_from_env,
    get_chain,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/web_search", tags=["web_search"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class WebSearchRequest(BaseModel):
    """Body for POST /web_search/run."""
    query: str = Field(..., min_length=1, max_length=2048)
    top_n: int = Field(8, ge=1, le=50)
    recency: Optional[str] = Field(
        None,
        description=(
            "One of: 'day' | 'week' | 'month' | 'year'. "
            "Maps to a date-restricted search when the backend supports it."
        ),
    )
    backends: Optional[list[str]] = Field(
        None,
        description=(
            "Override the default chain order. Backend ids: "
            + ", ".join(b.id for b in DEFAULT_CHAIN)
        ),
    )
    parallel: bool = Field(False, description="Run backends in parallel and pick the best response")
    per_backend_timeout_s: float = Field(15.0, ge=1.0, le=60.0)
    total_budget_ms: int = Field(25_000, ge=1_000, le=120_000)
    max_concurrency: int = Field(4, ge=1, le=32)
    min_results: int = Field(1, ge=1, le=20)


class WebSearchResult(BaseModel):
    """A single search result, normalised across backends."""
    title: str
    url: str
    snippet: str = ""
    published_at: Optional[str] = None
    author: Optional[str] = None
    score: Optional[float] = None
    favicon_url: Optional[str] = None
    image_url: Optional[str] = None


class WebSearchResponse(BaseModel):
    query: str
    backend: str
    results: list[WebSearchResult]
    duration_ms: int
    cost_usd: float = 0.0
    cached: bool = False


class BackendStatus(BaseModel):
    id: str
    label: str
    requires_api_key: bool
    has_key: bool
    available: bool


class BackendsList(BaseModel):
    default_chain: list[str]
    configured: list[BackendStatus]
    all: list[BackendStatus]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_admin_or_loopback(request: Request, user: User) -> bool:
    """Allow single-backend debug route if admin or call from loopback."""
    if getattr(user, "is_admin", False):
        return True
    client = request.client
    if client and client.host in {"127.0.0.1", "::1", "localhost"}:
        return True
    return False


def _build_chain(backends: Optional[list[str]], req: WebSearchRequest) -> WebSearchChain:
    """Construct a chain honoring the per-request override."""
    from .chain import ChainOptions, SearchBackend  # local import to avoid cycles

    if backends:
        all_backends = default_backends_from_env()
        by_id = {b.id: b for b in all_backends}
        chosen: list[SearchBackend] = []
        for bid in backends:
            if bid not in by_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"unknown backend: {bid}",
                )
            chosen.append(by_id[bid])
        opts = ChainOptions(
            backends=chosen,
            min_results=req.min_results,
            per_backend_timeout_s=req.per_backend_timeout_s,
            total_budget_ms=req.total_budget_ms,
            parallel=req.parallel,
            max_concurrency=req.max_concurrency,
        )
        return WebSearchChain(opts)
    # Fall back to the singleton, but mutate the parallel/timeout for this call.
    chain = get_chain()
    chain.options.parallel = req.parallel
    chain.options.per_backend_timeout_s = req.per_backend_timeout_s
    chain.options.total_budget_ms = req.total_budget_ms
    chain.options.max_concurrency = req.max_concurrency
    chain.options.min_results = req.min_results
    return chain


def _to_response(resp: SearchResponse) -> WebSearchResponse:
    return WebSearchResponse(
        query=resp.query,
        backend=resp.backend,
        results=[WebSearchResult(**r.__dict__) for r in resp.results],
        duration_ms=resp.duration_ms,
        cost_usd=resp.cost_usd,
        cached=resp.cached,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/run", response_model=WebSearchResponse)
async def run_search(
    body: WebSearchRequest,
    request: Request,
    user: User = Depends(get_current_user),
) -> WebSearchResponse:
    """Run a search across the chain (sequential by default)."""
    chain = _build_chain(body.backends, body)
    started = time.perf_counter()
    try:
        resp = await chain.run(body.query, top_n=body.top_n, recency=body.recency)
    except Exception as e:  # pragma: no cover
        logger.exception("web_search.run failed for user=%s", getattr(user, "id", "?"))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"web search failed: {e!s}",
        ) from e
    duration_ms = int((time.perf_counter() - started) * 1000)
    # Override the chain's own measurement with the wall-clock time the API
    # actually spent (includes auth + body parsing).
    if resp.results:
        resp.duration_ms = max(resp.duration_ms, duration_ms)
    return _to_response(resp)


@router.get("/backends", response_model=BackendsList)
async def list_backends(
    user: User = Depends(get_current_user),
) -> BackendsList:
    """List every backend with its id, label, and whether it has an API key."""
    all_backends = default_backends_from_env()
    configured: list[BackendStatus] = []
    available: list[BackendStatus] = []
    default_chain_ids = [b.id for b in DEFAULT_CHAIN]
    for b in all_backends:
        has_key = bool(b.api_key)
        bs = BackendStatus(
            id=b.id,
            label=b.label,
            requires_api_key=b.requires_api_key,
            has_key=has_key,
            available=has_key or not b.requires_api_key,
        )
        available.append(bs)
        if b.id in default_chain_ids:
            configured.append(bs)
    return BackendsList(
        default_chain=default_chain_ids,
        configured=configured,
        all=available,
    )


@router.post("/{backend_id}/run", response_model=WebSearchResponse)
async def run_single_backend(
    body: WebSearchRequest,
    request: Request,
    backend_id: str = Path(..., description="Backend id, e.g. 'exa', 'brave', 'duckduckgo'"),
    user: User = Depends(get_current_user),
) -> WebSearchResponse:
    """Run a single backend directly (debug / fallback). Admin or loopback only."""
    if not _is_admin_or_loopback(request, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="single-backend run requires admin or loopback caller",
        )
    chain = _build_chain([backend_id], body)
    started = time.perf_counter()
    try:
        resp = await chain.run(body.query, top_n=body.top_n, recency=body.recency)
    except Exception as e:  # pragma: no cover
        logger.exception("web_search single backend %s failed", backend_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"backend {backend_id} failed: {e!s}",
        ) from e
    resp.duration_ms = int((time.perf_counter() - started) * 1000)
    return _to_response(resp)


@router.get("/health")
async def health() -> dict[str, Any]:
    """Quick health check (no auth). Returns whether the chain is built and
    how many backends have API keys configured."""
    all_backends = default_backends_from_env()
    have_keys = sum(1 for b in all_backends if b.api_key or not b.requires_api_key)
    return {
        "ok": True,
        "backends_total": len(all_backends),
        "backends_available": have_keys,
        "default_chain_length": len(DEFAULT_CHAIN),
        "env": os.getenv("ENVIRONMENT", "development"),
    }
