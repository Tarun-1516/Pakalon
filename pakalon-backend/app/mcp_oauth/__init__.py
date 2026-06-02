"""MCP OAuth: OAuth 2.1 flows specifically shaped for MCP server auth.

Implements the subset of the MCP OAuth spec needed by clients and
resource servers to:
- Discover protected resource metadata
- Register dynamic clients
- Exchange codes with PKCE
- Refresh tokens
"""
from __future__ import annotations

from .service import MCPOAuthService, MCPOAuthConfig, MCPOAuthClient

__all__ = ["MCPOAuthService", "MCPOAuthConfig", "MCPOAuthClient"]
