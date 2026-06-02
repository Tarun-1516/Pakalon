/**
 * ACP (Agent Client Protocol) client.
 *
 * ACP is a JSON-RPC-over-stdio protocol that lets IDEs (Zed, JetBrains,
 * VSCode, Helix) drive an agent like Pakalon-CLI as a subprocess. The
 * editor sends `initialize`, `authenticate`, `new_session`, `prompt`,
 * `cancel`, etc., and the agent streams back session/update events.
 *
 * This client implements the agent side: it speaks the wire protocol and
 * handles the request/response dance. The host loop (in `agent-runtime.ts`)
 * routes the requests to the rest of the CLI.
 *
 * Reference: https://agentclientprotocol.com/
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { redactSensitive, sanitizeUnicode } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Protocol types (subset that the agent side uses)
// ─────────────────────────────────────────────────────────────────────────────

export interface AcpInitializeRequest {
  protocolVersion: number;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
    meta?: Record<string, unknown>;
  };
  clientInfo?: { name: string; version: string };
  /** Workspace root URI (e.g. `file:///home/user/proj`). */
  workspaceUri?: string;
}

export interface AcpInitializeResponse {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
    meta?: Record<string, unknown>;
  };
  agentInfo?: { name: string; version: string };
  authMethods?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
}

export interface AcpNewSessionRequest {
  cwd: string;
  mcpServers: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  /** "user" | "project" | "system" */
  promptScope?: "user" | "project" | "system";
}

export interface AcpNewSessionResponse {
  sessionId: string;
  /** Modes offered by the agent (e.g. "chat" | "plan" | "edit" | "agent"). */
  modes?: Array<{ id: string; name: string; description?: string }>;
  /** Models offered by the agent. */
  models?: Array<{ id: string; name: string; description?: string }>;
  meta?: Record<string, unknown>;
}

export interface AcpPromptRequest {
  sessionId: string;
  /** List of content blocks. */
  prompt: Array<
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; data: string }
    | { type: "resource"; uri: string; mimeType?: string; text?: string }
    | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string }
  >;
  /** Optional mode override. */
  mode?: string;
  /** Optional model override. */
  model?: string;
  /** Stop sequence list (e.g. for streaming chunks). */
  stopSequences?: string[];
}

export type AcpSessionUpdate =
  | {
      sessionId: string;
      update: "user_message_chunk" | "agent_message_chunk";
      content: { type: "text"; text: string };
    }
  | {
      sessionId: string;
      update: "agent_thought_chunk";
      content: { type: "text"; text: string };
    }
  | {
      sessionId: string;
      update: "tool_call" | "tool_call_update";
      toolCallId: string;
      title: string;
      kind:
        | "read" | "edit" | "delete" | "move" | "search" | "execute" | "think"
        | "fetch" | "switch_mode" | "other";
      status?: "pending" | "in_progress" | "completed" | "failed";
      content?:
        | { type: "diff"; path: string; oldText: string | null; newText: string }
        | { type: "terminal"; terminalId: string }
        | undefined;
      locations?: Array<{ path: string; line?: number }>;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionId: string;
      update: "plan";
      entries: Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority?: "high" | "medium" | "low" }>;
    }
  | {
      sessionId: string;
      update: "available_commands_update";
      commands: Array<{ name: string; description: string; input?: { hint: string } }>;
    }
  | {
      sessionId: string;
      update: "current_mode_update";
      mode: string;
    };

export interface AcpPromptResponse {
  stopReason: "end_turn" | "max_tokens" | "max_tool_calls" | "refusal" | "cancelled" | "error";
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  error?: { code: string; message: string };
}

export interface AcpCancelNotification {
  sessionId: string;
}

export interface AcpLoadSessionRequest {
  cwd: string;
  sessionId: string;
  mcpServers?: AcpNewSessionRequest["mcpServers"];
}

export interface AcpSetModeRequest {
  sessionId: string;
  mode: string;
}

export interface AcpSetModelRequest {
  sessionId: string;
  model: string;
}

export interface AcpAuthenticateRequest {
  methodId: string;
  /** Method-specific credentials. */
  credentials?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client (agent side)
// ─────────────────────────────────────────────────────────────────────────────

export interface AcpClientOptions {
  /** The editor process to talk to. If omitted, caller wires `send` themselves. */
  editorCommand?: string;
  editorArgs?: string[];
  editorCwd?: string;
  /** Per-request default timeout (ms). */
  requestTimeoutMs?: number;
  /** Extra env. */
  env?: Record<string, string>;
}

export class AcpError extends Error {
  readonly code: number;
  readonly method: string;
  constructor(message: string, code: number, method: string) {
    super(redactSensitive(message));
    this.name = "AcpError";
    this.code = code;
    this.method = method;
  }
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  method: string;
  timeoutHandle: NodeJS.Timeout;
}

export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private caps?: AcpInitializeResponse;
  private sessionIds = new Set<string>();
  private requestTimeoutMs: number;

  constructor(private readonly opts: AcpClientOptions = {}) {
    super();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  }

  /** Spawn the editor process and perform the `initialize` handshake. */
  async start(): Promise<AcpInitializeResponse> {
    if (!this.opts.editorCommand) {
      throw new AcpError("editorCommand is required for AcpClient.start", -1, "start");
    }
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(
          this.opts.editorCommand!,
          this.opts.editorArgs ?? [],
          {
            cwd: this.opts.editorCwd,
            env: { ...process.env, ...(this.opts.env ?? {}) },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      } catch (e) {
        reject(new AcpError(`Failed to spawn editor: ${(e as Error).message}`, -1, "spawn"));
        return;
      }
      this.proc.on("error", (e) => {
        const err = new AcpError(`Editor process error: ${e.message}`, -1, "process_error");
        this.failAll(err);
        this.emit("error", err);
      });
      this.proc.on("close", (code, signal) => {
        this.closed = true;
        this.failAll(new AcpError(`Editor closed (code=${code} signal=${signal})`, -1, "closed"));
        this.emit("close", { code, signal });
      });
      this.proc.stderr?.on("data", (chunk) =>
        this.emit("editor-stderr", chunk.toString("utf-8")),
      );
      this.proc.stdout?.on("data", (chunk) => this.onStdout(chunk));
      this.request<AcpInitializeResponse>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "pakalon-cli", version: "1.0.0" },
      })
        .then((r) => {
          this.caps = r;
          resolve(r);
        })
        .catch(reject);
    });
  }

  /** Open a new session. */
  async newSession(req: AcpNewSessionRequest): Promise<AcpNewSessionResponse> {
    const res = await this.request<AcpNewSessionResponse>("session/new", req);
    this.sessionIds.add(res.sessionId);
    return res;
  }

  /** Resume an existing session. */
  async loadSession(req: AcpLoadSessionRequest): Promise<{ sessionId: string; modes?: AcpNewSessionResponse["modes"]; models?: AcpNewSessionResponse["models"] }> {
    const res = await this.request<{ sessionId: string; modes?: AcpNewSessionResponse["modes"]; models?: AcpNewSessionResponse["models"] }>(
      "session/load",
      req,
    );
    this.sessionIds.add(res.sessionId);
    return res;
  }

  /** Send a prompt; stream session/update notifications to listeners. */
  async prompt(
    req: AcpPromptRequest,
    onUpdate?: (u: AcpSessionUpdate) => void,
  ): Promise<AcpPromptResponse> {
    const sub = (u: AcpSessionUpdate) => {
      if (onUpdate) onUpdate(u);
      this.emit("update", u);
    };
    const listener = (msg: any) => {
      if (msg.method === "session/update" && msg.params?.sessionId === req.sessionId) {
        sub(msg.params as AcpSessionUpdate);
      }
    };
    this.on("__raw", listener);
    try {
      return await this.request<AcpPromptResponse>("session/prompt", req);
    } finally {
      this.off("__raw", listener);
    }
  }

  async cancel(n: AcpCancelNotification): Promise<void> {
    await this.notify("session/cancel", n);
  }

  async setMode(req: AcpSetModeRequest): Promise<void> {
    await this.request("session/set_mode", req);
  }

  async setModel(req: AcpSetModelRequest): Promise<void> {
    await this.request("session/set_model", req);
  }

  async authenticate(req: AcpAuthenticateRequest): Promise<{ authenticated: boolean }> {
    return this.request<{ authenticated: boolean }>("authenticate", req);
  }

  /** Send a JSON-RPC request and await the response. */
  private request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new AcpError("Client is closed", -1, method));
        return;
      }
      const id = this.nextId++;
      const t = timeoutMs ?? this.requestTimeoutMs;
      const pending: PendingRequest = {
        resolve: (v) => resolve(v as T),
        reject,
        method,
        timeoutHandle: setTimeout(() => {
          this.pending.delete(id);
          reject(
            new AcpError(
              `Request '${method}' timed out after ${t}ms`,
              -1,
              method,
            ),
          );
        }, t),
      };
      this.pending.set(id, pending);
      try {
        this.writeMessage({
          jsonrpc: "2.0",
          id,
          method,
          params: sanitizeUnicode(params as Record<string, unknown>),
        });
      } catch (e) {
        clearTimeout(pending.timeoutHandle);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) {
      throw new AcpError("Client is closed", -1, method);
    }
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params: sanitizeUnicode(params as Record<string, unknown>),
    });
  }

  private writeMessage(msg: object): void {
    if (!this.proc?.stdin) {
      throw new AcpError("Editor stdin is not writable", -1, "send");
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
      } catch {
        continue;
      }
      this.handleMessage(parsed);
    }
  }

  private handleMessage(msg: any): void {
    // Notification
    if (msg.method && msg.id === undefined) {
      this.emit("__raw", msg);
      this.emit("notification", msg);
      this.emit(`notif:${msg.method}`, msg.params);
      return;
    }
    // Response
    if (msg.id != null) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeoutHandle);
      if (msg.error) {
        pending.reject(
          new AcpError(
            msg.error.message ?? "JSON-RPC error",
            msg.error.code ?? -1,
            pending.method,
          ),
        );
        return;
      }
      pending.resolve(msg.result ?? {});
      return;
    }
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  /** Public access to the capabilities negotiated during `initialize`. */
  get capabilities(): AcpInitializeResponse | undefined {
    return this.caps;
  }

  get openSessionIds(): string[] {
    return Array.from(this.sessionIds);
  }

  // ─── typed event helpers ───────────────────────────────────────────────
  on(event: "update", listener: (u: AcpSessionUpdate) => void): this;
  on(event: "notification", listener: (msg: { method: string; params: unknown }) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  on(event: "editor-stderr", listener: (text: string) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  // @ts-expect-error – overload base
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

export const __unused_randomUUID = randomUUID;
