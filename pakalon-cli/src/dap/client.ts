/**
 * DAP (Debug Adapter Protocol) client.
 *
 * Implements the Microsoft DAP (https://microsoft.github.io/debug-adapter-protocol/)
 * over a stdio transport. The CLI spawns an adapter binary (e.g. `debugpy`,
 * `lldb-dap`, `delve`, `vscode-js-debug`), sends Content-Length framed
 * messages, and consumes events / responses.
 *
 * Adapters supported out of the box:
 *   - `debugpy` (Python)        — `python -m debugpy.adapter`
 *   - `lldb-dap` (C/C++/Rust)    — `lldb-dap`
 *   - `delve` (Go)               — `dlv dap`
 *   - `jsdb` (Node, vscode-js-debug)
 *   - `mock` (built-in mock for tests)
 *
 * Higher-level helpers (setBreakpoint, continue, stepOver, evaluate,
 * threads, stackTrace, scopes, variables) wrap the request/response dance
 * and return typed objects. The `DebugSession` class is the main public
 * surface.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { redactSensitive } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// DAP types (the ones we care about)
// ─────────────────────────────────────────────────────────────────────────────

export interface DapSource {
  name?: string;
  path?: string;
  sourceReference?: number;
}

export interface DapSourceBreakpoint {
  id?: number;
  verified: boolean;
  line: number;
  column?: number;
  source?: DapSource;
  message?: string;
}

export interface DapBreakpoint {
  id: number;
  source?: DapSource;
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface DapThread {
  id: number;
  name: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
  presentationHint?:
    | "arguments"
    | "locals"
    | "globals"
    | "registers"
    | "evaluate"
    | "class"
    | "instance"
    | "protected";
  namedVariables?: number;
  indexedVariables?: number;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
}

export interface DapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsLogPoints?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsExceptionFilterOptions?: boolean;
  supportsEvaluateForHovers?: boolean;
  exceptionBreakpointFilters?: Array<{ filter: string; label: string; description?: string }>;
  supportsStepBack?: boolean;
  supportsTerminateRequest?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter registry
// ─────────────────────────────────────────────────────────────────────────────

export type DapAdapterId = "debugpy" | "lldb-dap" | "delve" | "jsdb" | "mock";

export interface DapAdapterLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface DapAdapter {
  id: DapAdapterId;
  label: string;
  buildLaunch(opts: { port?: number }): DapAdapterLaunch;
}

export const DapAdapters: Record<DapAdapterId, DapAdapter> = {
  debugpy: {
    id: "debugpy",
    label: "Python (debugpy)",
    buildLaunch: () => ({
      command: "python",
      args: ["-m", "debugpy.adapter"],
    }),
  },
  "lldb-dap": {
    id: "lldb-dap",
    label: "C/C++/Rust (lldb-dap)",
    buildLaunch: () => ({ command: "lldb-dap", args: [] }),
  },
  delve: {
    id: "delve",
    label: "Go (delve)",
    buildLaunch: () => ({ command: "dlv", args: ["dap"] }),
  },
  jsdb: {
    id: "jsdb",
    label: "Node.js (vscode-js-debug)",
    buildLaunch: () => ({
      command: "node",
      args: [
        "${PAKALON_VSCODE_JS_DEBUG:-/usr/lib/node_modules/vscode-js-debug/out/src/dapDebugServer.js}",
      ],
    }),
  },
  mock: {
    id: "mock",
    label: "Mock DAP adapter (for tests)",
    buildLaunch: () => ({ command: "node", args: [] }),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Debug session
// ─────────────────────────────────────────────────────────────────────────────

export interface DebugSessionOptions {
  adapter: DapAdapterId | DapAdapter;
  /** Launch config passed to the adapter via `launch` request. */
  launchConfig: Record<string, unknown>;
  /** Optional override for the binary path. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Timeout for the `initialize` request (ms, default 10000). */
  initializeTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
  startedAt: number;
  timeoutMs?: number;
  timeoutHandle?: NodeJS.Timeout;
}

export class DapError extends Error {
  readonly command: string;
  readonly body?: Record<string, unknown>;
  constructor(message: string, command: string, body?: Record<string, unknown>) {
    super(redactSensitive(message));
    this.name = "DapError";
    this.command = command;
    this.body = body;
  }
}

export class DebugSession extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private nextSeq = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private caps: DapCapabilities = {};
  private adapter: DapAdapterLaunch;
  private closed = false;
  private threads: DapThread[] = [];
  /** Local cache of breakpoint ids (line-keyed). */
  private breakpointsByLine = new Map<string, DapSourceBreakpoint[]>();

  constructor(private readonly opts: DebugSessionOptions) {
    super();
    const a =
      typeof opts.adapter === "string"
        ? DapAdapters[opts.adapter]
        : opts.adapter;
    if (!a) {
      throw new DapError(`Unknown adapter: ${String(opts.adapter)}`, "constructor");
    }
    this.adapter = {
      ...a.buildLaunch({}),
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    };
  }

  /** Spawn the adapter and perform the `initialize` handshake. */
  async start(): Promise<DapCapabilities> {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.adapter.command, this.adapter.args, {
          cwd: this.adapter.cwd,
          env: this.adapter.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        reject(
          new DapError(
            `Failed to spawn adapter: ${(e as Error).message}`,
            "spawn",
          ),
        );
        return;
      }

      this.proc.on("error", (e) => {
        const err = new DapError(`Adapter error: ${e.message}`, "process_error");
        this.failAll(err);
        this.emit("error", err);
      });

      this.proc.on("close", (code, signal) => {
        this.closed = true;
        const err = new DapError(
          `Adapter closed (code=${code} signal=${signal})`,
          "closed",
        );
        this.failAll(err);
        this.emit("close", { code, signal });
      });

      this.proc.stderr?.on("data", (chunk) => {
        this.emit("adapter-stderr", chunk.toString("utf-8"));
      });

      this.proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));

      this.send("initialize", {
        clientID: "pakalon",
        clientName: "Pakalon CLI",
        adapterID: typeof this.opts.adapter === "string" ? this.opts.adapter : this.opts.adapter.id,
        locale: "en-US",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: true,
        supportsProgressReporting: true,
        supportsMemoryReferences: false,
        supportsArgsCanBeInterpretedByShell: false,
      })
        .then((r) => {
          this.caps = (r as { capabilities?: DapCapabilities })?.capabilities ?? {};
          // The adapter must send an `initialized` event before we send `launch`/`attach`.
          const initTimeoutMs = this.opts.initializeTimeoutMs ?? 10_000;
          const timer = setTimeout(() => {
            reject(
              new DapError(
                "Adapter did not send 'initialized' event in time",
                "initialize_timeout",
              ),
            );
          }, initTimeoutMs);
          this.once("initialized", () => {
            clearTimeout(timer);
            resolve(this.caps);
          });
        })
        .catch((e) => reject(e));
    });
  }

  /** Send a `launch` (or `attach`) request. */
  async launch(): Promise<void> {
    await this.send("launch", this.opts.launchConfig);
  }

  /** Send a `configurationDone` request (if the adapter supports it). */
  async configurationDone(): Promise<void> {
    if (this.caps.supportsConfigurationDoneRequest !== false) {
      await this.send("configurationDone", {});
    }
  }

  /** Set breakpoints for a file. Returns the assigned (verified) breakpoints. */
  async setBreakpoints(
    source: DapSource,
    breakpoints: Array<{ line: number; column?: number; condition?: string; hitCondition?: string; logMessage?: string }>,
  ): Promise<DapSourceBreakpoint[]> {
    const res = (await this.send("setBreakpoints", {
      source,
      breakpoints: breakpoints.map((b) => ({
        line: b.line,
        ...(b.column != null ? { column: b.column } : {}),
        ...(b.condition ? { condition: b.condition } : {}),
        ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}),
        ...(b.logMessage ? { logMessage: b.logMessage } : {}),
      })),
      sourceModified: false,
    })) as { breakpoints: DapSourceBreakpoint[] };
    const list = res.breakpoints ?? [];
    const key = source.path ?? source.name ?? "<unknown>";
    this.breakpointsByLine.set(key, list);
    return list;
  }

  /** Send `continue` for a thread. */
  async continue(threadId: number): Promise<{ allThreadsContinued?: boolean }> {
    return (await this.send("continue", { threadId })) as {
      allThreadsContinued?: boolean;
    };
  }

  async next(threadId: number): Promise<void> {
    await this.send("next", { threadId });
  }

  async stepIn(threadId: number): Promise<void> {
    await this.send("stepIn", { threadId });
  }

  async stepOut(threadId: number): Promise<void> {
    await this.send("stepOut", { threadId });
  }

  async pause(threadId: number): Promise<void> {
    await this.send("pause", { threadId });
  }

  async terminate(): Promise<void> {
    try {
      if (!this.closed) await this.send("terminate", { restart: false });
    } catch {
      // ignore — adapter may have already closed
    }
  }

  async disconnect(terminateDebuggee = true): Promise<void> {
    try {
      if (!this.closed)
        await this.send("disconnect", { terminateDebuggee, restart: false });
    } catch {
      // ignore
    }
    this.kill();
  }

  async threads(): Promise<DapThread[]> {
    const res = (await this.send("threads", {})) as { threads: DapThread[] };
    this.threads = res.threads ?? [];
    return this.threads;
  }

  async stackTrace(threadId: number, startFrame = 0, levels = 20): Promise<DapStackFrame[]> {
    const res = (await this.send("stackTrace", {
      threadId,
      startFrame,
      levels,
    })) as { stackFrames: DapStackFrame[] };
    return res.stackFrames ?? [];
  }

  async scopes(frameId: number): Promise<DapScope[]> {
    const res = (await this.send("scopes", { frameId })) as {
      scopes: DapScope[];
    };
    return res.scopes ?? [];
  }

  async variables(variablesReference: number): Promise<DapVariable[]> {
    const res = (await this.send("variables", {
      variablesReference,
    })) as { variables: DapVariable[] };
    return res.variables ?? [];
  }

  async evaluate(expression: string, frameId?: number, context?: "watch" | "repl" | "hover" | "clipboard"): Promise<{ result: string; type?: string; variablesReference: number }> {
    return (await this.send("evaluate", {
      expression,
      ...(frameId != null ? { frameId } : {}),
      context: context ?? "repl",
    })) as { result: string; type?: string; variablesReference: number };
  }

  /** Run a `sendRequest` with default timeout (10s). */
  private send(command: string, args: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new DapError("Session is closed", command));
        return;
      }
      const seq = this.nextSeq++;
      const msg = {
        seq,
        type: "request",
        command,
        arguments: args,
      };
      const pending: PendingRequest = {
        resolve,
        reject,
        method: command,
        startedAt: Date.now(),
        timeoutMs,
      };
      pending.timeoutHandle = setTimeout(() => {
        this.pending.delete(seq);
        reject(
          new DapError(
            `Request '${command}' timed out after ${timeoutMs}ms`,
            command,
          ),
        );
      }, timeoutMs);
      this.pending.set(seq, pending);
      try {
        this.writeMessage(msg);
      } catch (e) {
        clearTimeout(pending.timeoutHandle);
        this.pending.delete(seq);
        reject(e);
        return;
      }
    });
  }

  private writeMessage(msg: object): void {
    if (!this.proc?.stdin) {
      throw new DapError("Adapter stdin is not writable", "send");
    }
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    this.proc.stdin.write(header, "utf-8");
    this.proc.stdin.write(body, "utf-8");
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("ascii");
      const m = /^Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Garbage; skip ahead
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length).toString("utf-8");
      this.buffer = this.buffer.slice(bodyStart + length);
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        this.emit("parse-error", e);
        continue;
      }
      this.handleMessage(parsed);
    }
  }

  private handleMessage(msg: any): void {
    if (msg.type === "response") {
      const pending = this.pending.get(msg.request_seq);
      if (!pending) {
        // Late response — ignore
        return;
      }
      this.pending.delete(msg.request_seq);
      clearTimeout(pending.timeoutHandle);
      if (!msg.success) {
        pending.reject(
          new DapError(
            `DAP request '${pending.method}' failed: ${msg.message ?? "no message"}`,
            pending.method,
            msg.body,
          ),
        );
        return;
      }
      pending.resolve(msg.body ?? {});
      return;
    }
    if (msg.type === "event") {
      this.handleEvent(msg);
      return;
    }
  }

  private handleEvent(msg: { event: string; body?: any }): void {
    switch (msg.event) {
      case "initialized":
        this.emit("initialized");
        break;
      case "stopped":
        this.emit("stopped", msg.body);
        break;
      case "continued":
        this.emit("continued", msg.body);
        break;
      case "thread":
        if (msg.body?.reason === "started") {
          this.threads.push({
            id: msg.body.threadId,
            name: msg.body.name ?? "thread",
          });
        } else if (msg.body?.reason === "exited") {
          this.threads = this.threads.filter((t) => t.id !== msg.body.threadId);
        }
        this.emit("thread", msg.body);
        break;
      case "output":
        this.emit("output", msg.body);
        break;
      case "breakpoint":
        this.emit("breakpoint", msg.body);
        break;
      case "process":
        this.emit("process", msg.body);
        break;
      case "capabilities":
        this.caps = { ...this.caps, ...(msg.body ?? {}) };
        this.emit("capabilities", this.caps);
        break;
      case "terminated":
        this.emit("terminated", msg.body);
        break;
      case "exited":
        this.emit("exited", msg.body);
        break;
      default:
        this.emit("event", msg);
    }
  }

  private failAll(err: Error): void {
    for (const [seq, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(err);
      this.pending.delete(seq);
    }
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  // ─── typed event helpers ─────────────────────────────────────────────────

  on(event: "initialized", listener: () => void): this;
  on(event: "stopped", listener: (body: { reason: string; threadId?: number; allThreadsStopped?: boolean; description?: string; text?: string; hitBreakpointIds?: number[] }) => void): this;
  on(event: "continued", listener: (body: { threadId: number; allThreadsContinued?: boolean }) => void): this;
  on(event: "output", listener: (body: { category?: string; output: string; variablesReference?: number; source?: DapSource; line?: number; column?: number; data?: any }) => void): this;
  on(event: "breakpoint", listener: (body: { reason: "changed" | "new" | "removed"; breakpoint: DapBreakpoint }) => void): this;
  on(event: "thread", listener: (body: { reason: string; threadId: number }) => void): this;
  on(event: "process", listener: (body: { name: string; systemProcessId?: number; isLocalProcess?: boolean; startMethod?: "launch" | "attach" | "attachForSuspendedLaunch" }) => void): this;
  on(event: "terminated", listener: (body?: { restart?: unknown }) => void): this;
  on(event: "exited", listener: (body: { exitCode: number }) => void): this;
  on(event: "capabilities", listener: (caps: DapCapabilities) => void): this;
  on(event: "adapter-stderr", listener: (text: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  // @ts-expect-error – EventEmitter overload
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: run-to-breakpoint helper
// ─────────────────────────────────────────────────────────────────────────────

export interface DebugSessionHandle {
  session: DebugSession;
  /** Resolves with the stack frame at the breakpoint hit. */
  waitForStop: (timeoutMs?: number) => Promise<{ threadId: number; frame: DapStackFrame }>;
  /** Send `continue` and wait for the next stop. */
  resume: () => void;
}

/** Build a launch config for the Python `debugpy` adapter. */
export function buildDebugpyLaunch(opts: {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** "launch" (default) or "attach". */
  mode?: "launch" | "attach";
  /** Listen port for attach mode. */
  port?: number;
  /** Stop at the first line of the program. */
  stopOnEntry?: boolean;
  justMyCode?: boolean;
  showReturnValue?: boolean;
}): Record<string, unknown> {
  if (opts.mode === "attach") {
    return {
      type: "python",
      request: "attach",
      connect: { host: "127.0.0.1", port: opts.port ?? 5678 },
      justMyCode: opts.justMyCode ?? true,
      showReturnValue: opts.showReturnValue ?? false,
    };
  }
  return {
    type: "python",
    request: "launch",
    program: opts.program,
    args: opts.args ?? [],
    cwd: opts.cwd,
    env: opts.env ?? {},
    justMyCode: opts.justMyCode ?? true,
    showReturnValue: opts.showReturnValue ?? false,
    stopOnEntry: opts.stopOnEntry ?? false,
    console: "integratedTerminal",
  };
}

/** Build a launch config for the `lldb-dap` adapter (C/C++/Rust). */
export function buildLldbLaunch(opts: {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
}): Record<string, unknown> {
  return {
    type: "lldb",
    request: "launch",
    program: opts.program,
    args: opts.args ?? [],
    cwd: opts.cwd,
    env: opts.env ?? {},
    stopOnEntry: opts.stopOnEntry ?? false,
  };
}

/** Build a launch config for the `delve` adapter (Go). */
export function buildDelveLaunch(opts: {
  program: string;
  mode?: "debug" | "test" | "exec";
  cwd?: string;
  args?: string[];
  stopOnEntry?: boolean;
}): Record<string, unknown> {
  return {
    type: "go",
    request: "launch",
    mode: opts.mode ?? "debug",
    program: opts.program,
    args: opts.args ?? [],
    cwd: opts.cwd,
    stopOnEntry: opts.stopOnEntry ?? false,
  };
}

let _requestCounter = 0;
export function __internalRequestId(): number {
  return ++_requestCounter;
}

export const __unused_randomUUID = randomUUID; // keep import live
