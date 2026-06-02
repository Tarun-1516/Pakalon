"""Provider router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .catalog import list_providers as _list, list_models as _list_models
from .catalog import get_provider, get_model

router = APIRouter(prefix="/providers", tags=["providers"])


class ProviderSummary(BaseModel):
    id: str
    name: str
    base_url: str
    api_style: str
    api_key_env: str


class ModelSummary(BaseModel):
    id: str
    name: str
    context: int
    capabilities: list[str]


@router.get("")
async def providers() -> list[dict[str, Any]]:
    return _list()


@router.get("/{provider_id}")
async def provider_detail(provider_id: str) -> dict[str, Any]:
    p = get_provider(provider_id)
    if not p:
        raise HTTPException(status_code=404, detail="unknown provider")
    return {
        "id": p.id,
        "name": p.name,
        "base_url": p.base_url,
        "api_style": p.api_style,
        "api_key_env": p.api_key_env,
        "models": [
            {
                "id": m.id, "name": m.name, "context": m.context,
                "capabilities": [c.name for c in m.capabilities.__class__ if c in m.capabilities],
            }
            for m in p.models
        ],
    }


@router.get("/{provider_id}/models/{model_id}")
async def model_detail(provider_id: str, model_id: str) -> dict[str, Any]:
    m = get_model(provider_id, model_id)
    if not m:
        raise HTTPException(status_code=404, detail="unknown model")
    return {
        "id": m.id, "name": m.name, "context": m.context,
        "capabilities": [c.name for c in m.capabilities.__class__ if c in m.capabilities],
    }


@router.get("/models/all")
async def all_models(provider: str | None = None) -> list[dict[str, Any]]:
    out = _list_models(provider=provider)
    return [
        {
            "provider": m["provider"],
            "id": m["id"], "name": m["name"],
            "context": m["context"],
            "capabilities": [c.name for c in m["capabilities"].__class__ if c in m["capabilities"]],
        }
        for m in out
    ]
