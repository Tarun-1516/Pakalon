"""SSH router."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .service import SshService, get_service

router = APIRouter(prefix="/ssh", tags=["ssh"])


def service() -> SshService:
    return get_service()


class ConnectRequest(BaseModel):
    host: str
    user: str
    port: int = 22
    key_filename: str = ""
    password: str = ""


class RunRequest(BaseModel):
    host: str
    user: str
    command: str
    port: int = 22
    timeout: float = 60.0


@router.post("/connect")
async def connect(
    body: ConnectRequest, svc: SshService = Depends(service)
) -> dict[str, Any]:
    try:
        c = await svc.connect(
            body.host, body.user, port=body.port,
            key_filename=body.key_filename, password=body.password,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ssh connect failed: {e}")
    return {"host": c.host, "user": c.user, "port": c.port, "connected": True}


@router.post("/run")
async def run(
    body: RunRequest, svc: SshService = Depends(service)
) -> dict[str, Any]:
    try:
        r = await svc.run(
            body.host, body.user, body.command,
            port=body.port, timeout=body.timeout,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ssh run failed: {e}")
    return {
        "stdout": r.stdout, "stderr": r.stderr,
        "exit_code": r.exit_code, "duration": r.duration,
    }


@router.post("/disconnect")
async def disconnect(
    body: RunRequest, svc: SshService = Depends(service)
) -> dict[str, bool]:
    ok = await svc.disconnect(body.host, body.user, body.port)
    return {"disconnected": ok}


@router.get("/list")
async def list_connections(svc: SshService = Depends(service)) -> list[str]:
    return svc.list()
