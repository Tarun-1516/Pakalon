"""Projects router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .service import ProjectService

router = APIRouter(prefix="/projects", tags=["projects"])
_svc = ProjectService()


class CreateRequest(BaseModel):
    name: str
    description: str = ""
    root: str = ""
    owner: str = ""
    tags: list[str] = Field(default_factory=list)


class UpdateRequest(BaseModel):
    description: str | None = None
    root: str | None = None
    tags: list[str] | None = None


@router.post("")
async def create(body: CreateRequest) -> dict[str, Any]:
    p = await _svc.create(
        body.name, description=body.description, root=body.root,
        owner=body.owner, tags=body.tags,
    )
    return p.to_dict()


@router.get("")
async def list_projects(owner: str | None = None) -> list[dict[str, Any]]:
    return [p.to_dict() for p in await _svc.list(owner=owner)]


@router.get("/{pid}")
async def get_project(pid: str) -> dict[str, Any]:
    p = await _svc.get(pid)
    if not p:
        raise HTTPException(status_code=404, detail="not found")
    return p.to_dict()


@router.get("/by-name/{name}")
async def get_by_name(name: str) -> dict[str, Any]:
    p = await _svc.get_by_name(name)
    if not p:
        raise HTTPException(status_code=404, detail="not found")
    return p.to_dict()


@router.patch("/{pid}")
async def update(pid: str, body: UpdateRequest) -> dict[str, Any]:
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    p = await _svc.update(pid, **fields)
    if not p:
        raise HTTPException(status_code=404, detail="not found")
    return p.to_dict()


@router.delete("/{pid}")
async def delete_project(pid: str) -> dict[str, bool]:
    ok = await _svc.delete(pid)
    return {"deleted": ok}
