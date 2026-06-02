"""Auth providers and helpers.

This subpackage layers on top of `app/services/oauth_service.py` with:
- PKCE code-verifier / code-challenge generation
- Provider-specific authorization URL builders
- Refresh helpers for Anthropic, Copilot, Codex, GitHub
"""
from .pkce import PKCE, generate_pkce
from .providers import (
    PROVIDER_REGISTRY,
    list_providers,
    get_provider,
    build_authorize_url,
    exchange_code,
    refresh_token,
)

__all__ = [
    "PKCE", "generate_pkce",
    "PROVIDER_REGISTRY", "list_providers", "get_provider",
    "build_authorize_url", "exchange_code", "refresh_token",
]
