"""Internal URLs router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .service import InternalUrlService

router = APIRouter(prefix="/internal-urls", tags=["internal-urls"])

_svc = InternalUrlService()


def get_service() -> InternalUrlService:
    return _svc


class BuildRequest(BaseModel):
    workspace: str
    path: str
    scheme: str = "local"  # local | secure
    ttl_seconds: int = 3600
    meta: dict[str, Any] = Field(default_factory=dict)


class ResolveRequest(BaseModel):
    url: str


class UrlOut(BaseModel):
    url: str
    workspace: str
    path: str
    meta: dict[str, Any] = {}


@router.post("/build")
async def build_url(
    body: BuildRequest, svc: InternalUrlService = Depends(get_service)
) -> UrlOut:
    url = svc.build(
        body.workspace, body.path, scheme=body.scheme,
        ttl_seconds=body.ttl_seconds, **body.meta,
    )
    return UrlOut(url=url, workspace=body.workspace, path=body.path, meta=body.meta)


@router.post("/resolve")
async def resolve_url(
    body: ResolveRequest, svc: InternalUrlService = Depends(get_service)
) -> UrlOut:
    parsed = svc.resolve(body.url)
    if not parsed:
        raise HTTPException(status_code=400, detail="invalid or untrusted URL")
    return UrlOut(url=body.url, workspace=parsed.workspace, path=parsed.path, meta=parsed.meta)
