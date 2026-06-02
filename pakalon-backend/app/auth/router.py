"""Auth router: PKCE / provider discovery."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .providers import (
    PROVIDER_REGISTRY, build_authorize_url, exchange_code, refresh_token,
    list_providers, get_provider,
)
from .pkce import random_state

router = APIRouter(prefix="/auth", tags=["auth-providers"])


class AuthorizeRequest(BaseModel):
    provider: str
    redirect_uri: str
    state: str | None = None
    client_id: str | None = None
    extra: dict[str, str] | None = None
    with_pkce: bool | None = None


class AuthorizeOut(BaseModel):
    url: str
    state: str
    code_verifier: str | None = None


class ExchangeRequest(BaseModel):
    provider: str
    code: str
    redirect_uri: str
    code_verifier: str | None = None
    client_id: str | None = None
    client_secret: str | None = None


class RefreshRequest(BaseModel):
    provider: str
    refresh_token: str
    client_id: str | None = None
    client_secret: str | None = None


@router.get("/providers")
async def providers() -> list[dict[str, Any]]:
    return list_providers()


@router.post("/authorize")
async def authorize(body: AuthorizeRequest) -> AuthorizeOut:
    try:
        url, state, pkce = build_authorize_url(
            body.provider,
            redirect_uri=body.redirect_uri,
            state=body.state or random_state(),
            client_id=body.client_id,
            extra=body.extra,
            with_pkce=body.with_pkce,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown provider")
    return AuthorizeOut(
        url=url, state=state,
        code_verifier=pkce.code_verifier if pkce else None,
    )


@router.post("/exchange")
async def exchange(body: ExchangeRequest) -> dict[str, Any]:
    try:
        return await exchange_code(
            body.provider, body.code,
            redirect_uri=body.redirect_uri,
            code_verifier=body.code_verifier,
            client_id=body.client_id,
            client_secret=body.client_secret,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"exchange failed: {e}")


@router.post("/refresh")
async def refresh(body: RefreshRequest) -> dict[str, Any]:
    try:
        return await refresh_token(
            body.provider, body.refresh_token,
            client_id=body.client_id, client_secret=body.client_secret,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"refresh failed: {e}")
