"""Device-code router (PKCE-aware)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import start_device_flow

router = APIRouter(prefix="/auth/device", tags=["auth-device"])


class StartRequest(BaseModel):
    provider: str
    scope: str = ""
    client_id: str = ""


class StartResponse(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int
    interval: int
    code_verifier: str | None = None
    code_challenge: str | None = None
    code_challenge_method: str | None = None


@router.post("/start")
async def start(body: StartRequest) -> StartResponse:
    try:
        r = await start_device_flow(
            body.provider, scope=body.scope, client_id=body.client_id
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return StartResponse(
        device_code=r.device_code,
        user_code=r.user_code,
        verification_uri=r.verification_uri,
        verification_uri_complete=r.verification_uri_complete,
        expires_in=r.expires_in,
        interval=r.interval,
        code_verifier=r.pkce.code_verifier if r.pkce else None,
        code_challenge=r.pkce.code_challenge if r.pkce else None,
        code_challenge_method=r.pkce.code_challenge_method if r.pkce else None,
    )
