"""DAP: Debug Adapter Protocol client.

Lets the agent attach to debug adapters (Python debugpy, Node, Go, etc.)
over the DAP wire protocol. Pure stdlib JSON-over-socket implementation.
"""
from __future__ import annotations

from .protocol import DAPClient, DAPMessage, DapEvent
from .manager import DAPManager
from .ops import (
    DAPOps, Breakpoint, StackFrame, Scope, Variable, Thread,
)

__all__ = [
    "DAPClient", "DAPMessage", "DapEvent", "DAPManager",
    "DAPOps", "Breakpoint", "StackFrame", "Scope", "Variable", "Thread",
]
