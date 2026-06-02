"""PKCE (RFC 7636) helper for OAuth 2.1 public clients."""
from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass


@dataclass(slots=True)
class PKCE:
    code_verifier: str
    code_challenge: str
    code_challenge_method: str = "S256"

    def to_dict(self) -> dict:
        return {
            "code_verifier": self.code_verifier,
            "code_challenge": self.code_challenge,
            "code_challenge_method": self.code_challenge_method,
        }


def generate_pkce() -> PKCE:
    """Generate a (verifier, S256 challenge) PKCE pair."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode("ascii").rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).decode("ascii").rstrip("=")
    return PKCE(code_verifier=verifier, code_challenge=challenge)


def random_state() -> str:
    return secrets.token_urlsafe(24)
