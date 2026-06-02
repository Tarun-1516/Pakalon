"""Provider-specific OAuth flows.

Supports: anthropic, github, copilot, codex, google, gitlab, bitbucket,
openai (oauth), together, openrouter, vercel, netlify, supabase.
"""
from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

import httpx

from .pkce import PKCE, generate_pkce, random_state


@dataclass(slots=True)
class ProviderConfig:
    name: str
    authorize_url: str
    token_url: str
    client_id: str = ""
    scopes: list[str] = field(default_factory=list)
    use_pkce: bool = True
    extra_authorize_params: dict[str, str] = field(default_factory=dict)
    userinfo_url: str = ""


PROVIDER_REGISTRY: dict[str, ProviderConfig] = {
    "anthropic": ProviderConfig(
        name="anthropic",
        authorize_url="https://console.anthropic.com/oauth/authorize",
        token_url="https://console.anthropic.com/oauth/token",
        client_id="ant_cli_01",
        scopes=["org:create_api_key", "user:profile", "user:inference"],
        use_pkce=True,
        userinfo_url="https://api.anthropic.com/v1/me",
    ),
    "github": ProviderConfig(
        name="github",
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scopes=["read:user", "user:email", "repo"],
        use_pkce=False,
        userinfo_url="https://api.github.com/user",
    ),
    "copilot": ProviderConfig(
        name="copilot",
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scopes=["copilot", "read:user"],
        use_pkce=False,
        userinfo_url="https://api.github.com/user",
    ),
    "codex": ProviderConfig(
        name="codex",
        authorize_url="https://auth.openai.com/oauth/authorize",
        token_url="https://auth.openai.com/oauth/token",
        scopes=["openid", "profile", "email", "offline_access"],
        use_pkce=True,
        userinfo_url="https://api.openai.com/v1/me",
    ),
    "google": ProviderConfig(
        name="google",
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        scopes=["openid", "email", "profile"],
        use_pkce=True,
        userinfo_url="https://www.googleapis.com/oauth2/v3/userinfo",
    ),
    "openai": ProviderConfig(
        name="openai",
        authorize_url="https://auth.openai.com/oauth/authorize",
        token_url="https://auth.openai.com/oauth/token",
        scopes=["openid", "profile", "email", "offline_access"],
        use_pkce=True,
        userinfo_url="https://api.openai.com/v1/me",
    ),
    "openrouter": ProviderConfig(
        name="openrouter",
        authorize_url="https://openrouter.ai/auth",
        token_url="https://openrouter.ai/api/v1/auth/key",
        scopes=[""],
        use_pkce=False,
    ),
    "vercel": ProviderConfig(
        name="vercel",
        authorize_url="https://vercel.com/oauth/authorize",
        token_url="https://api.vercel.com/v2/oauth/access_token",
        scopes=["user:read"],
        use_pkce=True,
    ),
    "netlify": ProviderConfig(
        name="netlify",
        authorize_url="https://app.netlify.com/authorize",
        token_url="https://api.netlify.com/oauth/token",
        scopes=["user"],
        use_pkce=True,
    ),
    "supabase": ProviderConfig(
        name="supabase",
        authorize_url="https://api.supabase.com/v1/oauth/authorize",
        token_url="https://api.supabase.com/v1/oauth/token",
        scopes=["database.read", "database.write"],
        use_pkce=True,
    ),
    "gitlab": ProviderConfig(
        name="gitlab",
        authorize_url="https://gitlab.com/oauth/authorize",
        token_url="https://gitlab.com/oauth/token",
        scopes=["read_user", "read_api", "read_repository"],
        use_pkce=True,
        userinfo_url="https://gitlab.com/api/v4/user",
    ),
    "bitbucket": ProviderConfig(
        name="bitbucket",
        authorize_url="https://bitbucket.org/site/oauth2/authorize",
        token_url="https://bitbucket.org/site/oauth2/access_token",
        scopes=["account", "repository"],
        use_pkce=True,
    ),
    "together": ProviderConfig(
        name="together",
        authorize_url="https://api.together.xyz/oauth/authorize",
        token_url="https://api.together.xyz/oauth/token",
        scopes=["read", "write"],
        use_pkce=True,
    ),
}


def list_providers() -> list[dict[str, Any]]:
    return [
        {
            "name": p.name,
            "authorize_url": p.authorize_url,
            "scopes": p.scopes,
            "use_pkce": p.use_pkce,
        }
        for p in PROVIDER_REGISTRY.values()
    ]


def get_provider(name: str) -> ProviderConfig:
    if name not in PROVIDER_REGISTRY:
        raise KeyError(f"unknown provider: {name}")
    return PROVIDER_REGISTRY[name]


def build_authorize_url(
    name: str,
    *,
    redirect_uri: str,
    state: str | None = None,
    client_id: str | None = None,
    extra: dict[str, str] | None = None,
    with_pkce: bool | None = None,
) -> tuple[str, str, PKCE | None]:
    """Returns (url, state, pkce_or_None)."""
    p = get_provider(name)
    pkce: PKCE | None = None
    if with_pkce or (with_pkce is None and p.use_pkce):
        pkce = generate_pkce()
    state = state or random_state()
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": client_id or p.client_id,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    if p.scopes:
        params["scope"] = " ".join(p.scopes)
    if pkce is not None:
        params["code_challenge"] = pkce.code_challenge
        params["code_challenge_method"] = pkce.code_challenge_method
    for k, v in (extra or {}).items():
        params[k] = v
    for k, v in p.extra_authorize_params.items():
        params.setdefault(k, v)
    return f"{p.authorize_url}?{urlencode(params)}", state, pkce


async def exchange_code(
    name: str,
    code: str,
    *,
    redirect_uri: str,
    code_verifier: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> dict[str, Any]:
    p = get_provider(name)
    data: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id or p.client_id,
    }
    if code_verifier:
        data["code_verifier"] = code_verifier
    if client_secret:
        data["client_secret"] = client_secret
    async with httpx.AsyncClient() as c:
        r = await c.post(
            p.token_url,
            data=data,
            headers={"Accept": "application/json"},
            timeout=15.0,
        )
        r.raise_for_status()
        return r.json()


async def refresh_token(
    name: str,
    refresh: str,
    *,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> dict[str, Any]:
    p = get_provider(name)
    data: dict[str, str] = {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "client_id": client_id or p.client_id,
    }
    if client_secret:
        data["client_secret"] = client_secret
    async with httpx.AsyncClient() as c:
        r = await c.post(
            p.token_url,
            data=data,
            headers={"Accept": "application/json"},
            timeout=15.0,
        )
        r.raise_for_status()
        return r.json()
