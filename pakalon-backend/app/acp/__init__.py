"""ACP: Agent Communication Protocol — JSON-RPC 2.0 over WebSocket.

Provides a real-time protocol for clients (web UI, IDE, mobile) to
spawn sessions, send prompts, stream events, and cancel turns.
"""
from __future__ import annotations

from .protocol import ACPServer, ACPClient, ACPSession, ACPEvent

__all__ = ["ACPServer", "ACPClient", "ACPSession", "ACPEvent"]
