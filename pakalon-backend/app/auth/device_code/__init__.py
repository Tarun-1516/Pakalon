"""Device-code auth enhancements (PKCE + per-provider code generation)."""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Any

from app.auth.pkce import generate_pkce, PKCE


@dataclass(slots=True)
class DeviceCodeRequest:
    provider: str
    client_id: str = ""
    scope: str = ""


@dataclass(slots=True)
class DeviceCodeResponse:
    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str = ""
    expires_in: int = 600
    interval: int = 5
    pkce: PKCE | None = None


def generate_user_code(length: int = 6) -> str:
    """Generate a human-friendly device code (digits, easy to read)."""
    alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"  # no I/O/0/1
    return "".join(secrets.choice(alphabet) for _ in range(length))


async def start_device_flow(
    provider: str,
    *,
    scope: str = "",
    client_id: str = "",
) -> DeviceCodeResponse:
    """Issue a device code for a provider.

    For providers that natively support device-code (GitHub, Google),
    this would forward to them. For others, we generate an internal
    code and the web UI bridges it.
    """
    user_code = generate_user_code(6)
    device_code = secrets.token_urlsafe(32)
    pkce = generate_pkce() if provider in {"anthropic", "codex", "openai", "google"} else None
    return DeviceCodeResponse(
        device_code=device_code,
        user_code=user_code,
        verification_uri=f"https://pakalon.com/auth/device",
        verification_uri_complete=f"https://pakalon.com/auth/device?code={user_code}",
        expires_in=600,
        interval=5,
        pkce=pkce,
    )
