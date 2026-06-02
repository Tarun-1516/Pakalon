"""Image model router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import list_image_models, get_image_model

router = APIRouter(prefix="/image-models", tags=["image-models"])


@router.get("")
async def all_models() -> list[dict[str, Any]]:
    return list_image_models()


@router.get("/{model_id}")
async def model_detail(model_id: str) -> dict[str, Any]:
    m = get_image_model(model_id)
    if not m:
        raise HTTPException(status_code=404, detail="unknown model")
    return {
        "id": m.id, "name": m.name, "provider": m.provider,
        "max_resolution": m.max_resolution,
        "cost_per_image": m.cost_per_image,
        "capabilities": [c.name for c in m.capabilities.__class__ if c in m.capabilities],
    }
