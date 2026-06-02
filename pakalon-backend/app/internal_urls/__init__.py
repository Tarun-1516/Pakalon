"""Internal URLs: scoped, signed URLs that resolve to in-app resources.

Two protocol variants:
- `local://<workspace>/<path>` (no signing, trusted in single-tenant mode)
- `secure://<token>/<workspace>/<path>` (HMAC-signed)
"""
from __future__ import annotations

from .service import InternalUrlService, ParsedUrl
from .protocols import LocalProtocol, SecureProtocol

__all__ = [
    "InternalUrlService",
    "ParsedUrl",
    "LocalProtocol",
    "SecureProtocol",
]
