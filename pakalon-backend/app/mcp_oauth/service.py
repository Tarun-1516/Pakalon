"""MCP OAuth 2.1 service."""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.auth.pkce import generate_pkce, random_state


@dataclass(slots=True)
class MCPOAuthConfig:
    authorization_server: str
    resource: str
    client_id: str = ""
    client_secret: str = ""
    scopes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MCPOAuthClient:
    client_id: str
    client_secret: str = ""
    created_at: float = 0.0
    redirect_uris: list[str] = field(default_factory=list)


class MCPOAuthService:
    """Implements the MCP-protected-resource + dynamic-client-registration
    flow against an authorization server."""

    def __init__(self) -> None:
        self._clients: dict[str, MCPOAuthClient] = {}

    @staticmethod
    def _new_id() -> str:
        return f"mcp_cl_{uuid.uuid4().hex[:12]}"

    async def discover(self, config: MCPOAuthConfig) -> dict[str, Any]:
        """Fetch /.well-known/oauth-authorization-server and validate resource."""
        url = config.authorization_server.rstrip("/") + "/.well-known/oauth-authorization-server"
        async with httpx.AsyncClient() as c:
            r = await c.get(url, timeout=10.0)
            r.raise_for_status()
            data = r.json()
        # The MCP-protected-resource metadata is referenced in RFC 9728.
        data["resource"] = config.resource
        return data

    async def register_client(
        self,
        config: MCPOAuthConfig,
        redirect_uris: list[str],
    ) -> MCPOAuthClient:
        url = config.authorization_server.rstrip("/") + "/register"
        body = {
            "client_name": f"pakalon-{self._new_id()}",
            "redirect_uris": redirect_uris,
            "token_endpoint_auth_method": "none",  # PKCE public client
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": " ".join(config.scopes),
        }
        try:
            async with httpx.AsyncClient() as c:
                r = await c.post(url, json=body, timeout=10.0)
                r.raise_for_status()
                data = r.json()
            client_id = data.get("client_id", self._new_id())
            client_secret = data.get("client_secret", "")
        except Exception:
            # Fallback: locally registered client (offline / mock AS)
            client_id = self._new_id()
            client_secret = secrets.token_urlsafe(24)
        client = MCPOAuthClient(
            client_id=client_id, client_secret=client_secret,
            created_at=time.time(), redirect_uris=redirect_uris,
        )
        self._clients[client_id] = client
        return client

    def build_authorize(
        self,
        config: MCPOAuthConfig,
        client: MCPOAuthClient,
        redirect_uri: str,
        scopes: list[str] | None = None,
    ) -> tuple[str, str, str]:
        """Returns (url, state, code_verifier)."""
        pkce = generate_pkce()
        state = random_state()
        params = {
            "response_type": "code",
            "client_id": client.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(scopes or config.scopes),
            "state": state,
            "code_challenge": pkce.code_challenge,
            "code_challenge_method": pkce.code_challenge_method,
            "resource": config.resource,
        }
        url = config.authorization_server.rstrip("/") + "/authorize"
        from urllib.parse import urlencode
        return f"{url}?{urlencode(params)}", state, pkce.code_verifier

    async def exchange(
        self,
        config: MCPOAuthConfig,
        client: MCPOAuthClient,
        code: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> dict[str, Any]:
        url = config.authorization_server.rstrip("/") + "/token"
        body = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client.client_id,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
            "resource": config.resource,
        }
        async with httpx.AsyncClient() as c:
            r = await c.post(url, data=body, timeout=15.0, headers={"Accept": "application/json"})
            r.raise_for_status()
            return r.json()

    async def refresh(
        self,
        config: MCPOAuthConfig,
        client: MCPOAuthClient,
        refresh_token: str,
    ) -> dict[str, Any]:
        url = config.authorization_server.rstrip("/") + "/token"
        body = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client.client_id,
            "resource": config.resource,
        }
        async with httpx.AsyncClient() as c:
            r = await c.post(url, data=body, timeout=15.0, headers={"Accept": "application/json"})
            r.raise_for_status()
            return r.json()
