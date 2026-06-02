"""High-level DAP operations.

This module wraps the raw ``DAPClient`` from :mod:`app.dap.protocol`
with typed methods for every Debug Adapter Protocol request the
agent needs.  The 27 ops covered:

  Lifecycle
    1.  initialize
    2.  launch
    3.  attach
    4.  disconnect
    5.  terminate
    6.  configurationDone

  Breakpoints
    7.  setBreakpoints
    8.  setFunctionBreakpoints
    9.  setExceptionBreakpoints
    10. dataBreakpointInfo
    11. setDataBreakpoints

  Execution
    12. continue
    13. next
    14. stepIn
    15. stepOut
    16. pause
    17. stepBack

  Threads & state
    18. threads
    19. stackTrace
    20. scopes
    21. variables
    22. setVariable
    23. evaluate

  Source
    24. source
    25. gotoTargets
    26. completions

  Misc
    27. exceptionInfo

The wrapper is additive — the low-level ``DAPClient.request`` API
in :mod:`app.dap.protocol` continues to work unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .protocol import DAPClient


@dataclass(slots=True)
class Breakpoint:
    line: int
    column: Optional[int] = None
    condition: Optional[str] = None
    hitCondition: Optional[str] = None
    logMessage: Optional[str] = None


@dataclass(slots=True)
class StackFrame:
    id: int
    name: str
    line: int
    column: int
    source: Optional[dict[str, Any]] = None


@dataclass(slots=True)
class Scope:
    name: str
    variablesReference: int
    expensive: bool = False
    presentationHint: Optional[str] = None
    namedVariables: Optional[int] = None
    indexedVariables: Optional[int] = None


@dataclass(slots=True)
class Variable:
    name: str
    value: str
    type: Optional[str] = None
    variablesReference: int = 0
    evaluateName: Optional[str] = None


@dataclass(slots=True)
class Thread:
    id: int
    name: str


@dataclass(slots=True)
class DAPOps:
    """Typed wrappers around the 27 DAP requests."""

    client: DAPClient

    # ── Lifecycle (1-6) ─────────────────────────────────────────────────────

    async def initialize(self, *, client_id: str = "pakalon",
                         adapter_id: str = "",
                         locale: str = "en-US",
                         lines_start_at_1: bool = True,
                         columns_start_at_1: bool = True) -> dict[str, Any]:
        return await self.client.request("initialize", {
            "clientID": client_id,
            "adapterID": adapter_id,
            "locale": locale,
            "linesStartAt1": lines_start_at_1,
            "columnsStartAt1": columns_start_at_1,
        })

    async def launch(self, **kwargs: Any) -> dict[str, Any]:
        return await self.client.request("launch", kwargs)

    async def attach(self, **kwargs: Any) -> dict[str, Any]:
        return await self.client.request("attach", kwargs)

    async def disconnect(self, *, terminate_debuggee: bool = True,
                         restart: bool = False) -> dict[str, Any]:
        return await self.client.request("disconnect", {
            "terminateDebuggee": terminate_debuggee, "restart": restart,
        })

    async def terminate(self, *, restart: bool = False) -> dict[str, Any]:
        return await self.client.request("terminate", {"restart": restart})

    async def configuration_done(self) -> dict[str, Any]:
        return await self.client.request("configurationDone", {})

    # ── Breakpoints (7-11) ──────────────────────────────────────────────────

    async def set_breakpoints(self, source_path: str,
                              breakpoints: list[Breakpoint],
                              *, source_modified: bool = False) -> list[dict[str, Any]]:
        body = await self.client.request("setBreakpoints", {
            "source": {"path": source_path},
            "sourceModified": source_modified,
            "breakpoints": [
                {k: v for k, v in {
                    "line": bp.line, "column": bp.column,
                    "condition": bp.condition,
                    "hitCondition": bp.hitCondition,
                    "logMessage": bp.logMessage,
                }.items() if v is not None}
                for bp in breakpoints
            ],
        })
        return body.get("breakpoints", [])

    async def set_function_breakpoints(self, functions: list[dict[str, str]]) -> list[dict[str, Any]]:
        body = await self.client.request("setFunctionBreakpoints", {"breakpoints": functions})
        return body.get("breakpoints", [])

    async def set_exception_breakpoints(self, filters: list[str]) -> dict[str, Any]:
        return await self.client.request("setExceptionBreakpoints", {"filters": filters})

    async def data_breakpoint_info(self, name: str, *, variables_reference: int = 0,
                                    frame_id: Optional[int] = None) -> dict[str, Any]:
        args: dict[str, Any] = {"name": name, "variablesReference": variables_reference}
        if frame_id is not None:
            args["frameId"] = frame_id
        return await self.client.request("dataBreakpointInfo", args)

    async def set_data_breakpoints(self, breakpoints: list[dict[str, Any]]) -> list[dict[str, Any]]:
        body = await self.client.request("setDataBreakpoints", {"breakpoints": breakpoints})
        return body.get("breakpoints", [])

    # ── Execution (12-17) ──────────────────────────────────────────────────

    async def continue_(self, thread_id: int, *,
                          single_thread: bool = False) -> dict[str, Any]:
        return await self.client.request("continue", {
            "threadId": thread_id, "singleThread": single_thread,
        })

    async def next(self, thread_id: int, *, granularity: str = "statement") -> dict[str, Any]:
        return await self.client.request("next", {
            "threadId": thread_id, "granularity": granularity,
        })

    async def step_in(self, thread_id: int, *, target_id: Optional[int] = None) -> dict[str, Any]:
        args: dict[str, Any] = {"threadId": thread_id}
        if target_id is not None:
            args["targetId"] = target_id
        return await self.client.request("stepIn", args)

    async def step_out(self, thread_id: int) -> dict[str, Any]:
        return await self.client.request("stepOut", {"threadId": thread_id})

    async def pause(self, thread_id: int) -> dict[str, Any]:
        return await self.client.request("pause", {"threadId": thread_id})

    async def step_back(self, thread_id: int) -> dict[str, Any]:
        return await self.client.request("stepBack", {"threadId": thread_id})

    # ── Threads & state (18-23) ────────────────────────────────────────────

    async def threads(self) -> list[Thread]:
        body = await self.client.request("threads", {})
        return [Thread(id=t["id"], name=t["name"]) for t in body.get("threads", [])]

    async def stack_trace(self, thread_id: int, *,
                           start_frame: int = 0, levels: int = 20) -> list[StackFrame]:
        body = await self.client.request("stackTrace", {
            "threadId": thread_id, "startFrame": start_frame, "levels": levels,
        })
        return [
            StackFrame(id=f["id"], name=f["name"], line=f.get("line", 0),
                       column=f.get("column", 0), source=f.get("source"))
            for f in body.get("stackFrames", [])
        ]

    async def scopes(self, frame_id: int) -> list[Scope]:
        body = await self.client.request("scopes", {"frameId": frame_id})
        return [
            Scope(name=s["name"], variablesReference=s["variablesReference"],
                  expensive=s.get("expensive", False),
                  presentationHint=s.get("presentationHint"),
                  namedVariables=s.get("namedVariables"),
                  indexedVariables=s.get("indexedVariables"))
            for s in body.get("scopes", [])
        ]

    async def variables(self, variables_reference: int, *,
                        filter_: Optional[str] = None,
                        start: int = 0, count: int = 100) -> list[Variable]:
        args: dict[str, Any] = {
            "variablesReference": variables_reference,
            "start": start, "count": count,
        }
        if filter_:
            args["filter"] = filter_
        body = await self.client.request("variables", args)
        return [
            Variable(name=v["name"], value=v["value"], type=v.get("type"),
                     variablesReference=v.get("variablesReference", 0),
                     evaluateName=v.get("evaluateName"))
            for v in body.get("variables", [])
        ]

    async def set_variable(self, variables_reference: int, name: str, value: str,
                           *, format_hex: bool = False) -> dict[str, Any]:
        return await self.client.request("setVariable", {
            "variablesReference": variables_reference,
            "name": name, "value": value,
            "format": {"hex": format_hex},
        })

    async def evaluate(self, expression: str, *, frame_id: Optional[int] = None,
                        context: str = "repl", format_hex: bool = False) -> dict[str, Any]:
        args: dict[str, Any] = {
            "expression": expression, "context": context,
            "format": {"hex": format_hex},
        }
        if frame_id is not None:
            args["frameId"] = frame_id
        return await self.client.request("evaluate", args)

    # ── Source (24-26) ─────────────────────────────────────────────────────

    async def source(self, source_reference: int, *,
                      format_source: bool = False) -> dict[str, Any]:
        return await self.client.request("source", {
            "sourceReference": source_reference,
            "formatSource": format_source,
        })

    async def goto_targets(self, source_path: str, line: int, column: int) -> list[dict[str, Any]]:
        body = await self.client.request("gotoTargets", {
            "source": {"path": source_path}, "line": line, "column": column,
        })
        return body.get("targets", [])

    async def completions(self, text: str, column: int, line: int, *,
                          frame_id: Optional[int] = None) -> list[dict[str, Any]]:
        args: dict[str, Any] = {"text": text, "column": column, "line": line}
        if frame_id is not None:
            args["frameId"] = frame_id
        body = await self.client.request("completions", args)
        return body.get("targets", [])

    # ── Misc (27) ──────────────────────────────────────────────────────────

    async def exception_info(self, thread_id: int) -> dict[str, Any]:
        return await self.client.request("exceptionInfo", {"threadId": thread_id})
