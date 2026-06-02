/**
 * agent-sdk/acp.ts — high-level SDK wrapper over the ACP client.
 *
 * `D:\pakalon\pakalon-cli\src\acp\client.ts` exposes the raw JSON-RPC-over-stdio
 * surface (sessions/new, sessions/prompt, streaming updates, etc.). This SDK
 * adds a typed, ergonomic API for embedding pakalon-cli in editors (Zed,
 * JetBrains, VSCode), bots, CI runners, and tests.
 *
 * The SDK is intentionally side-effect free at construction; `connect()` is
 * what spawns the underlying ACP server (or attaches to an existing stdio
 * socket via `{ spawn: false }`).
 */
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AcpMode = "chat" | "plan" | "edit" | "agent" | "yolo";

export type AcpRole = "user" | "assistant" | "system" | "tool";

export interface AcpSessionInfo {
  id: string;
  cwd: string;
  model?: string;
  mode: AcpMode;
  createdAt: number;
}

export interface AcpMessage {
  role: AcpRole;
  content: string;
  /** Tool calls (when role=assistant). */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  /** Tool results (when role=tool). */
  toolResults?: Array<{ callId: string; name: string; result: unknown; error?: string }>;
}

export type AcpUpdate =
  | { kind: "message"; message: AcpMessage }
  | { kind: "tool_call"; callId: string; name: string; args: unknown }
  | { kind: "tool_result"; callId: string; name: string; result: unknown; error?: string }
  | { kind: "permission_request"; callId: string; name: string; reason: string }
  | { kind: "session_update"; session: Partial<AcpSessionInfo> }
  | { kind: "error"; message: string; code?: string };

export interface AcpConnectOpts {
  /** Path to the pakalon CLI entry. Defaults to "pakalon". */
  bin?: string;
  /** Extra CLI args, e.g. ["--verbose"]. */
  args?: string[];
  /** Environment overrides. */
  env?: NodeJS.ProcessEnv;
  /** Spawn the process (default true). Set false when connecting to an existing socket. */
  spawn?: boolean;
  /** If `spawn: false`, the pre-spawned child process to wrap. */
  child?: ChildProcess;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Connection abort signal. */
  signal?: AbortSignal;
}

export interface CreateSessionOpts {
  cwd?: string;
  model?: string;
  mode?: AcpMode;
  /** Re-use an existing session id instead of creating a new one. */
  sessionId?: string;
}

export interface PromptOpts {
  /** Streaming callback. */
  onUpdate?: (u: AcpUpdate) => void;
  signal?: AbortSignal;
}

export interface ListModelsResult {
  models: Array<{ id: string; label: string; provider: string }>;
}

export interface ListModesResult {
  modes: Array<{ id: AcpMode; label: string; description: string }>;
}

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

/** Narrow runtime import: we use the existing `AcpClient` from `acp/client.ts`. */
interface RawClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  sessionNew(opts: { cwd: string; model?: string; mode: string }): Promise<{ sessionId: string }>;
  sessionLoad(opts: { sessionId: string }): Promise<{ sessionId: string }>;
  sessionPrompt(opts: { sessionId: string; text: string }, onUpdate?: (msg: unknown) => void): Promise<void>;
  sessionCancel(opts: { sessionId: string }): Promise<void>;
  setMode(opts: { sessionId: string; mode: string }): Promise<void>;
  setModel(opts: { sessionId: string; modelId: string }): Promise<void>;
  listModels(): Promise<ListModelsResult>;
  listModes(): Promise<ListModesResult>;
  isRunning(): boolean;
}

export class PakalonAcpClient extends EventEmitter {
  private readonly opts: Required<Omit<AcpConnectOpts, "child" | "signal" | "env">> & {
    env: NodeJS.ProcessEnv;
    child?: ChildProcess;
  };
  private raw: RawClient | null = null;
  private connected = false;
  private currentSession: AcpSessionInfo | null = null;

  constructor(opts: AcpConnectOpts = {}) {
    super();
    this.opts = {
      bin: opts.bin ?? "pakalon",
      args: opts.args ?? [],
      env: opts.env ?? process.env,
      spawn: opts.spawn ?? true,
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      child: opts.child,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;
    const { AcpClient } = await import("../acp/client.js");
    const cliBin = path.resolve(this.opts.bin);
    const child = this.opts.spawn
      ? spawn(cliBin, [...this.opts.args, "acp", "--stdio"], {
          env: this.opts.env,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : this.opts.child;
    if (!child) throw new Error("no child process available; set spawn:true or provide child");
    this.raw = new AcpClient({ child }) as unknown as RawClient;
    await this.raw.start();
    this.connected = true;
    this.emit("ready");
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.raw) return;
    try {
      if (this.currentSession) {
        await this.safeCall(() => this.raw!.sessionCancel({ sessionId: this.currentSession!.id }));
      }
    } catch { /* ignore */ }
    try { await this.raw.stop(); } catch { /* ignore */ }
    this.connected = false;
    this.emit("disconnect");
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Sessions ───────────────────────────────────────────────────────────

  async createSession(opts: CreateSessionOpts = {}): Promise<AcpSessionInfo> {
    this.assertConnected();
    const res = await this.withTimeout(
      this.raw!.sessionNew({
        cwd: opts.cwd ?? process.cwd(),
        model: opts.model,
        mode: opts.mode ?? "chat",
      }),
      this.opts.requestTimeoutMs,
    );
    const info: AcpSessionInfo = {
      id: res.sessionId,
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model,
      mode: opts.mode ?? "chat",
      createdAt: Date.now(),
    };
    this.currentSession = info;
    this.emit("session", info);
    return info;
  }

  async loadSession(sessionId: string): Promise<AcpSessionInfo> {
    this.assertConnected();
    const res = await this.withTimeout(
      this.raw!.sessionLoad({ sessionId }),
      this.opts.requestTimeoutMs,
    );
    const info: AcpSessionInfo = {
      id: res.sessionId,
      cwd: process.cwd(),
      mode: "chat",
      createdAt: Date.now(),
    };
    this.currentSession = info;
    this.emit("session", info);
    return info;
  }

  get currentSessionId(): string | null {
    return this.currentSession?.id ?? null;
  }

  // ─── Prompting ──────────────────────────────────────────────────────────

  /**
   * Send a one-shot prompt. The reply is delivered as a single
   * `{ kind: 'message', message: { role: 'assistant', content } }` update
   * once the stream completes.
   */
  async prompt(text: string, opts: PromptOpts = {}): Promise<AcpMessage> {
    this.assertConnected();
    if (!this.currentSession) {
      await this.createSession();
    }
    const session = this.currentSession!;
    const collected: AcpMessage[] = [];
    const onUpdate = (raw: unknown) => {
      const u = normaliseUpdate(raw);
      this.emitUpdate(u);
      if (opts.onUpdate) opts.onUpdate(u);
      if (u.kind === "message" && u.message.role === "assistant") {
        collected.push(u.message);
      }
    };
    await this.withTimeout(
      this.raw!.sessionPrompt({ sessionId: session.id, text }, onUpdate),
      this.opts.requestTimeoutMs,
      opts.signal,
    );
    return mergeAssistant(collected, text);
  }

  /**
   * Stream a prompt. `onUpdate` is called for every update; the resolved
   * promise resolves when the stream completes.
   */
  async streamPrompt(text: string, opts: PromptOpts): Promise<void> {
    this.assertConnected();
    if (!this.currentSession) {
      await this.createSession();
    }
    const session = this.currentSession!;
    await this.withTimeout(
      this.raw!.sessionPrompt({ sessionId: session.id, text }, (raw) => {
        const u = normaliseUpdate(raw);
        this.emitUpdate(u);
        if (opts.onUpdate) opts.onUpdate(u);
      }),
      this.opts.requestTimeoutMs,
      opts.signal,
    );
  }

  async cancel(): Promise<void> {
    this.assertConnected();
    if (!this.currentSession) return;
    await this.raw!.sessionCancel({ sessionId: this.currentSession.id });
  }

  // ─── Mode / Model ──────────────────────────────────────────────────────

  async setMode(mode: AcpMode): Promise<void> {
    this.assertConnected();
    if (!this.currentSession) return;
    await this.raw!.setMode({ sessionId: this.currentSession.id, mode });
    if (this.currentSession) this.currentSession.mode = mode;
    this.emit("session_update", { mode });
  }

  async setModel(modelId: string): Promise<void> {
    this.assertConnected();
    if (!this.currentSession) return;
    await this.raw!.setModel({ sessionId: this.currentSession.id, modelId });
    if (this.currentSession) this.currentSession.model = modelId;
    this.emit("session_update", { model: modelId });
  }

  async listModels(): Promise<ListModelsResult> {
    this.assertConnected();
    return this.withTimeout(this.raw!.listModels(), this.opts.requestTimeoutMs);
  }

  async listModes(): Promise<ListModesResult> {
    this.assertConnected();
    return this.withTimeout(this.raw!.listModes(), this.opts.requestTimeoutMs);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.connected || !this.raw) {
      throw new Error("not connected; call connect() first");
    }
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
      if (signal) {
        if (signal.aborted) { clearTimeout(t); reject(new Error("aborted")); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      p.then(
        (v) => { clearTimeout(t); if (signal) signal.removeEventListener("abort", onAbort); resolve(v); },
        (e) => { clearTimeout(t); if (signal) signal.removeEventListener("abort", onAbort); reject(e); },
      );
    });
  }

  private async safeCall(fn: () => Promise<unknown>): Promise<void> {
    try { await fn(); } catch { /* swallow */ }
  }

  private emitUpdate(u: AcpUpdate): void {
    this.emit(u.kind, u);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseUpdate(raw: unknown): AcpUpdate {
  if (!raw || typeof raw !== "object") {
    return { kind: "error", message: String(raw) };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r["type"] === "string") {
    const t = r["type"] as string;
    if (t === "message") {
      return {
        kind: "message",
        message: {
          role: (r["role"] as AcpRole) ?? "assistant",
          content: (r["content"] as string) ?? "",
        },
      };
    }
    if (t === "tool_call") {
      return {
        kind: "tool_call",
        callId: String(r["callId"] ?? ""),
        name: String(r["name"] ?? ""),
        args: r["args"],
      };
    }
    if (t === "tool_result") {
      return {
        kind: "tool_result",
        callId: String(r["callId"] ?? ""),
        name: String(r["name"] ?? ""),
        result: r["result"],
        error: r["error"] as string | undefined,
      };
    }
    if (t === "permission_request") {
      return {
        kind: "permission_request",
        callId: String(r["callId"] ?? ""),
        name: String(r["name"] ?? ""),
        reason: String(r["reason"] ?? ""),
      };
    }
  }
  return { kind: "error", message: "unknown update shape" };
}

function mergeAssistant(parts: AcpMessage[], promptText: string): AcpMessage {
  if (parts.length === 0) {
    return { role: "assistant", content: "" };
  }
  if (parts.length === 1) return parts[0]!;
  const content = parts.map((p) => p.content).join("");
  return { role: "assistant", content };
}
