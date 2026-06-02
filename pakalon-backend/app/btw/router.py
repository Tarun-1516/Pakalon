"""Btw router."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .service import BtwService, get_service, BtwSeverity

router = APIRouter(prefix="/btw", tags=["btw"])


def service() -> BtwService:
    return get_service()


class PushRequest(BaseModel):
    severity: BtwSeverity
    title: str
    body: str
    session_id: str = ""


@router.post("/push")
async def push(body: PushRequest) -> dict[str, Any]:
    n = await service().push(
        body.severity, body.title, body.body, session_id=body.session_id,
    )
    return n.to_dict()


@router.get("/recent")
async def recent(session_id: str = "", n: int = 50) -> list[dict[str, Any]]:
    return [x.to_dict() for x in service().recent(session_id, n=n)]


@router.get("/stream")
async def stream(session_id: str = ""):
    q = service().subscribe(session_id)

    async def gen():
        try:
            while True:
                try:
                    n = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(n.to_dict())}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            service().unsubscribe(session_id, q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
