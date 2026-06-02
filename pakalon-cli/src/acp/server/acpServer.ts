/**
 * ACP (Agent Client Protocol) server: lets external editors (Zed,
 * JetBrains, VS Code ACP extensions) drive Pakalon as an in-process
 * coding agent over JSON-RPC 2.0 on stdio.
 *
 * Complements `acp/client.ts` (which Pakalon uses to talk TO other
 * ACP agents).  This file is the OTHER side: a server that accepts
 * ACP connections.
 */
import * as readline from "node:readline";
import { Writable, Readable } from "node:stream";

export interface AcpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}
export interface AcpResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export interface AcpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface AcpServerOptions {
  defaultProvider?: string;
  defaultModel?: string;
  env?: NodeJS.ProcessEnv;
}

type Handler = (params: any, ctx: AcpCtx) => Promise<unknown> | unknown;
export interface AcpCtx {
  sessionId?: string;
  provider: string;
  model: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export class AcpServer {
  private handlers = new Map<string, Handler>();
  private sessions = new Map<string, AcpCtx>();
  private nextId = 1;
  private listeners: Array<(n: AcpNotification) => void> = [];

  constructor(private opts: AcpServerOptions = {}) {}

  register(method: string, handler: Handler): void { this.handlers.set(method, handler); }

  /** Subscribe to server-pushed notifications (session/update, etc.). */
  onNotification(fn: (n: AcpNotification) => void): void { this.listeners.push(fn); }

  private defaultCtx(): AcpCtx {
    return {
      provider: this.opts.defaultProvider ?? process.env.PAKALON_PROVIDER ?? "openrouter",
      model: this.opts.defaultModel ?? process.env.PAKALON_MODEL ?? "anthropic/claude-3.5-sonnet",
      cwd: process.cwd(),
      env: this.opts.env ?? process.env,
    };
  }

  async handleRequest(req: AcpRequest): Promise<AcpResponse> {
    const h = this.handlers.get(req.method);
    if (!h) {
      return { jsonrpc: "2.0", id: req.id,
               error: { code: -32601, message: `method not found: ${req.method}` } };
    }
    try {
      const ctx = this.sessions.get(String(req.params?.sessionId ?? "")) ?? this.defaultCtx();
      const result = await h(req.params ?? {}, ctx);
      return { jsonrpc: "2.0", id: req.id, result };
    } catch (e: any) {
      return { jsonrpc: "2.0", id: req.id,
               error: { code: -32000, message: e?.message ?? String(e) } };
    }
  }

  /** Send a server-initiated notification. */
  notify(method: string, params?: unknown): void {
    const n: AcpNotification = { jsonrpc: "2.0", method, params };
    for (const fn of this.listeners) try { fn(n); } catch {}
    this.writeMessage(n);
  }

  /** Drive the server from arbitrary I/O streams. */
  async serve(stdin: Readable = process.stdin, stdout: Writable = process.stdout): Promise<void> {
    this.writeMessage = (m) => stdout.write(JSON.stringify(m) + "\n");
    const rl = readline.createInterface({ input: stdin, terminal: false });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as AcpRequest;
        const res = await this.handleRequest(msg);
        if (res.id !== undefined) this.writeMessage(res);
      } catch (e: any) {
        this.writeMessage({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: e?.message ?? "parse error" } });
      }
    }
  }

  private writeMessage!: (m: AcpResponse | AcpNotification) => void;
}

// ─── Built-in handlers ────────────────────────────────────────────────────

export function registerDefaults(s: AcpServer): void {
  s.register("initialize", async (params: any) => {
    return {
      protocolVersion: 1,
      serverInfo: { name: "pakalon", version: "0.1.0" },
      capabilities: { tools: { listChanged: false } },
      ...(params?.clientInfo ?? {}),
    };
  });

  s.register("authenticate", async (params: any) => { return { ok: true, method: params?.method ?? "none" }; });

  s.register("new_session", async (params: any, ctx) => {
    const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    s["sessions"].set(id, { ...ctx, sessionId: id,
                            provider: params?.provider ?? ctx.provider,
                            model: params?.model ?? ctx.model });
    return { sessionId: id, model: params?.model ?? ctx.model };
  });

  s.register("load_session", async (params: any, ctx) => {
    s["sessions"].set(params.sessionId, { ...ctx, sessionId: params.sessionId });
    return { ok: true };
  });

  s.register("set_session_config", async (params: any) => {
    const s2 = s["sessions"].get(params.sessionId);
    if (!s2) throw new Error("unknown session");
    if (params.provider) s2.provider = params.provider;
    if (params.model) s2.model = params.model;
    return { ok: true };
  });

  s.register("cancel", async (params: any) => {
    // Real impl would signal an AbortController; the client uses sessionId to find it.
    s.notify("session/cancelled", { sessionId: params.sessionId });
    return { ok: true };
  });

  s.register("prompt", async (params: any, ctx) => {
    // Real impl streams tokens from ctx.provider.  Here we ack and notify.
    s.notify("session/update", { sessionId: ctx.sessionId, kind: "user_message", text: params?.text });
    s.notify("session/update", { sessionId: ctx.sessionId, kind: "assistant_done", text: "(stub reply)" });
    return { stopReason: "end_turn" };
  });
}

/** Convenience: start the server with default handlers on stdio. */
export async function startAcpServer(opts: AcpServerOptions = {}): Promise<AcpServer> {
  const s = new AcpServer(opts);
  registerDefaults(s);
  await s.serve();
  return s;
}
