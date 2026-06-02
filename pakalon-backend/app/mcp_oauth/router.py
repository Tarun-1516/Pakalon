"""MCP OAuth router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .service import MCPOAuthService, MCPOAuthConfig

router = APIRouter(prefix="/mcp-oauth", tags=["mcp-oauth"])
_svc = MCPOAuthService()


class DiscoverRequest(BaseModel):
    authorization_server: str
    resource: str
    client_id: str = ""
    client_secret: str = ""
    scopes: list[str] = Field(default_factory=list)


class RegisterRequest(BaseModel):
    authorization_server: str
    resource: str
    redirect_uris: list[str]
    scopes: list[str] = Field(default_factory=list)


class AuthorizeRequest(BaseModel):
    authorization_server: str
    resource: str
    client_id: str
    client_secret: str = ""
    scopes: list[str] = Field(default_factory=list)
    redirect_uri: str


class ExchangeRequest(BaseModel):
    authorization_server: str
    resource: str
    client_id: str
    client_secret: str = ""
    code: str
    code_verifier: str
    redirect_uri: str


class RefreshRequest(BaseModel):
    authorization_server: str
    resource: str
    client_id: str
    client_secret: str = ""
    refresh_token: str


def _config_from(body) -> MCPOAuthConfig:
    return MCPOAuthConfig(
        authorization_server=body.authorization_server,
        resource=body.resource,
        client_id=body.client_id,
        client_secret=body.client_secret,
        scopes=body.scopes,
    )


@router.post("/discover")
async def discover(body: DiscoverRequest) -> dict[str, Any]:
    try:
        return await _svc.discover(_config_from(body))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"discover failed: {e}")


@router.post("/register")
async def register(body: RegisterRequest) -> dict[str, Any]:
    client = await _svc.register_client(
        _config_from(body), body.redirect_uris,
    )
    return {
        "client_id": client.client_id,
        "client_secret": client.client_secret,
        "redirect_uris": client.redirect_uris,
    }


@router.post("/authorize")
async def authorize(body: AuthorizeRequest) -> dict[str, str]:
    cfg = _config_from(body)
    client = _svc._clients.get(body.client_id)
    if not client:
        # synthetic client record
        client = _svc._clients.setdefault(
            body.client_id,
            type("C", (), {"client_id": body.client_id, "client_secret": body.client_secret, "redirect_uris": [body.redirect_uri]})(),
        )
    url, state, verifier = _svc.build_authorize(
        cfg, client, body.redirect_uri, scopes=body.scopes,
    )
    return {"url": url, "state": state, "code_verifier": verifier}


@router.post("/exchange")
async def exchange(body: ExchangeRequest) -> dict[str, Any]:
    cfg = _config_from(body)
    client = _svc._clients.get(body.client_id)
    if not client:
        raise HTTPException(status_code=404, detail="unknown client")
    try:
        return await _svc.exchange(cfg, client, body.code, body.code_verifier, body.redirect_uri)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/refresh")
async def refresh(body: RefreshRequest) -> dict[str, Any]:
    cfg = _config_from(body)
    client = _svc._clients.get(body.client_id)
    if not client:
        raise HTTPException(status_code=404, detail="unknown client")
    try:
        return await _svc.refresh(cfg, client, body.refresh_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
