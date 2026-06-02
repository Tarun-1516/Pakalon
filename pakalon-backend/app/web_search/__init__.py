"""web_search — 14-backend web search chain and FastAPI router.

Re-exports the chain types and the router so callers can do
``from app.web_search import router`` and ``from app.web_search import
WebSearchChain, SearchResult, SearchResponse, get_chain``.
"""
from .chain import (
    # Common types
    SearchResult,
    SearchResponse,
    SearchError,
    # Protocol
    SearchBackend,
    # Backends
    ExaBackend,
    BraveBackend,
    JinaBackend,
    TavilyBackend,
    ParallelBackend,
    KagiBackend,
    YouBackend,
    PerplexityBackend,
    ExaNeuronBackend,
    OpenAIWebSearchBackend,
    AnthropicWebSearchBackend,
    ValyuBackend,
    CloudflareBackend,
    DuckDuckGoBackend,
    # Chain
    ChainOptions,
    SearchCache,
    WebSearchChain,
    get_chain,
    reset_chain,
    default_backends_from_env,
    DEFAULT_CHAIN,
    # Helpers
    recency_to_start,
    recency_to_days,
)
from .router import router

__all__ = [
    "SearchResult",
    "SearchResponse",
    "SearchError",
    "SearchBackend",
    "ExaBackend",
    "BraveBackend",
    "JinaBackend",
    "TavilyBackend",
    "ParallelBackend",
    "KagiBackend",
    "YouBackend",
    "PerplexityBackend",
    "ExaNeuronBackend",
    "OpenAIWebSearchBackend",
    "AnthropicWebSearchBackend",
    "ValyuBackend",
    "CloudflareBackend",
    "DuckDuckGoBackend",
    "ChainOptions",
    "SearchCache",
    "WebSearchChain",
    "get_chain",
    "reset_chain",
    "default_backends_from_env",
    "DEFAULT_CHAIN",
    "recency_to_start",
    "recency_to_days",
    "router",
]
