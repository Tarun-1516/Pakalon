"""URL protocol implementations."""
from __future__ import annotations

import hmac
import hashlib
import time
import base64
import json
from dataclasses import dataclass
from typing import Protocol


class UrlProtocol(Protocol):
    name: str
    def parse(self, url: str) -> "ParsedUrl": ...
    def build(self, workspace: str, path: str, **meta) -> str: ...
    def verify(self, url: str) -> "ParsedUrl | None": ...


@dataclass(slots=True)
class ParsedUrl:
    workspace: str
    path: str
    meta: dict


class LocalProtocol:
    """Plain in-cluster URLs: `local://<workspace>/<path>`."""
    name = "local"

    def parse(self, url: str) -> ParsedUrl:
        if not url.startswith("local://"):
            raise ValueError("not a local:// URL")
        rest = url[len("local://"):]
        if "/" not in rest:
            raise ValueError("malformed local URL")
        ws, _, path = rest.partition("/")
        return ParsedUrl(workspace=ws, path="/" + path, meta={})

    def build(self, workspace: str, path: str, **meta) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return f"local://{workspace}{path}"

    def verify(self, url: str) -> ParsedUrl | None:
        try:
            return self.parse(url)
        except Exception:
            return None


class SecureProtocol:
    """HMAC-signed URLs: `secure://<payload>.<sig>/<workspace>/<path>`.

    Payload: base64url(json({ws, path, exp, meta}))
    Sig:     base64url(HMAC_SHA256(payload, secret))[:16]
    """
    name = "secure"

    def __init__(self, secret: str = "pakalon-dev-secret") -> None:
        self.secret = secret.encode("utf-8")

    def _sign(self, payload: bytes) -> str:
        sig = hmac.new(self.secret, payload, hashlib.sha256).digest()[:16]
        return base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")

    def _b64(self, b: bytes) -> str:
        return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")

    def _b64d(self, s: str) -> bytes:
        pad = "=" * (-len(s) % 4)
        return base64.urlsafe_b64decode(s + pad)

    def parse(self, url: str) -> ParsedUrl:
        if not url.startswith("secure://"):
            raise ValueError("not a secure:// URL")
        rest = url[len("secure://"):]
        if "/" not in rest:
            raise ValueError("malformed secure URL")
        head, _, tail = rest.partition("/")
        if "." not in head:
            raise ValueError("missing signature")
        payload_b64, _, sig = head.partition(".")
        payload = self._b64d(payload_b64)
        expected = self._sign(payload)
        if not hmac.compare_digest(expected, sig):
            raise ValueError("bad signature")
        body = json.loads(payload.decode("utf-8"))
        exp = body.get("exp", 0)
        if exp and exp < time.time():
            raise ValueError("expired")
        return ParsedUrl(
            workspace=body["ws"],
            path="/" + tail,
            meta=body.get("meta", {}),
        )

    def build(
        self,
        workspace: str,
        path: str,
        *,
        ttl_seconds: int = 3600,
        **meta,
    ) -> str:
        if not path.startswith("/"):
            path = "/" + path
        body = {
            "ws": workspace,
            "path": path,
            "exp": int(time.time()) + ttl_seconds,
            "meta": meta,
        }
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        payload_b64 = self._b64(payload)
        sig = self._sign(payload)
        return f"secure://{payload_b64}.{sig}{path}"

    def verify(self, url: str) -> ParsedUrl | None:
        try:
            return self.parse(url)
        except Exception:
            return None
