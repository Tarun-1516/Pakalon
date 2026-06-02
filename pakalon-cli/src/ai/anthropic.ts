/**
 * First-party Anthropic Messages API client.
 *
 * Implements the full Anthropic Messages API surface used by Pakalon-CLI:
 *  - POST /v1/messages with system / tools / tool_choice
 *  - Server-Sent Events (SSE) streaming with the three event families:
 *      message_start, content_block_*, message_delta, message_stop, ping, error
 *  - Native tool-use blocks (input_schema, tool_use_id, is_input_complete)
 *  - Extended thinking (signature-bearing thinking blocks; budget as int)
 *  - Prompt caching (cache_control: ephemeral on system, tools, messages)
 *  - 1h / 5m cache TTL (cache_control.type = "ephemeral" with ttl override)
 *  - Adaptive thinking: server-side budget based on prompt-complexity signal
 *  - Citations, images, PDFs in user content
 *  - Token usage + cache_read_input_tokens / cache_creation_input_tokens
 *  - AbortSignal + retries with exponential backoff on 429/5xx
 *  - Tool-call-id normalization (calls into ./tool-call-id.js)
 *  - Cache-affinity routing hint (calls into ./cache-affinity.js)
 *  - Interleaved thinking flag (calls into ./interleaved-thinking.js)
 *
 * This is the canonical "anthropic-messages" provider implementation
 * (i.e. NOT a thin wrapper over OpenRouter). OpenRouter is still used as
 * the proxy fallback; this client is used when ANTHROPIC_API_KEY is set
 * and the model id starts with `claude-` and `PAKALON_USE_ANTHROPIC=1`.
 */
import { randomUUID } from "node:crypto";
import {
  normalizeToolCallId,
  isOpenAIToolCallId,
} from "./tool-call-id.js";
import {
  pickCacheAffinityKey,
  getCacheAffinityHint,
} from "./cache-affinity.js";
import {
  isInterleavedThinkingEnabled,
  buildInterleavedThinkingMarker,
} from "./interleaved-thinking.js";
import { redactSensitive, sanitizeUnicode, isEnoent } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

export type CacheTtl = "5m" | "1h";

export interface AnthropicImageSource {
  type: "base64";
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
}

export interface AnthropicPdfSource {
  type: "base64";
  media_type: "application/pdf";
  data: string;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
}

export interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
}

export interface AnthropicDocumentBlock {
  type: "document";
  source: AnthropicPdfSource;
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
}

export type AnthropicUserBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock;

export type AnthropicAssistantBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | {
      type: "thinking";
      thinking: string;
      signature: string;
      cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
    }
  | {
      type: "redacted_thinking";
      data: string;
    };

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
}

export type AnthropicMessageRole = "user" | "assistant";

export interface AnthropicMessage {
  role: AnthropicMessageRole;
  content: string | AnthropicUserBlock[] | AnthropicAssistantBlock[];
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicSystemBlock[];
  tools?: AnthropicToolDef[];
  tool_choice?:
    | { type: "auto" }
    | { type: "any" }
    | { type: "tool"; name: string };
  thinking?: {
    type: "enabled" | "adaptive";
    budget_tokens?: number;
  };
  metadata?: { user_id?: string };
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream: true;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export interface AnthropicStreamEventPing {
  type: "ping";
}

export interface AnthropicStreamEventError {
  type: "error";
  error: { type: string; message: string };
}

export interface AnthropicStreamEventMessageStart {
  type: "message_start";
  message: { id: string; type: "message"; role: "assistant"; model: string; usage: AnthropicUsage };
}

export interface AnthropicStreamEventContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: "" }
    | { type: "thinking"; thinking: "" }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "redacted_thinking"; data: string };
}

export interface AnthropicStreamEventContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "signature_delta"; signature: string };
}

export interface AnthropicStreamEventContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicStreamEventMessageDelta {
  type: "message_delta";
  delta: { stop_reason?: string; stop_sequence?: string };
  usage: { output_tokens: number };
}

export interface AnthropicStreamEventMessageStop {
  type: "message_stop";
}

export type AnthropicStreamEvent =
  | AnthropicStreamEventPing
  | AnthropicStreamEventError
  | AnthropicStreamEventMessageStart
  | AnthropicStreamEventContentBlockStart
  | AnthropicStreamEventContentBlockDelta
  | AnthropicStreamEventContentBlockStop
  | AnthropicStreamEventMessageDelta
  | AnthropicStreamEventMessageStop;

export interface AnthropicCallOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Anthropic API version. Defaults to 2023-06-01. */
  anthropicVersion?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Maximum wall-time per attempt. */
  timeoutMs?: number;
  /** Number of retry attempts on 429/5xx. */
  maxRetries?: number;
  /** Cache TTL applied to every cache_control: ephemeral block. */
  defaultCacheTtl?: CacheTtl;
  /** Effort level maps to thinking budget. */
  effort?: EffortLevel;
  /**
   * When true, enables interleaved thinking. Tool-use and thinking
   * blocks interleave in the same turn. Honours the model-aware policy
   * in `interleaved-thinking.js`.
   */
  interleavedThinking?: boolean;
  /**
   * When true, the model-aware adaptive-thinking policy is applied
   * (sends `thinking: { type: "adaptive" }` instead of a budget).
   */
  adaptiveThinking?: boolean;
}

export interface AnthropicResponseAccumulator {
  id: string;
  model: string;
  text: string;
  thinking: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  usage: AnthropicUsage;
  stopReason: string | null;
}

export interface AnthropicStreamHandlers {
  onEvent?: (event: AnthropicStreamEvent) => void;
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolInputDelta?: (id: string, partialJson: string) => void;
  onToolCallReady?: (call: { id: string; name: string; input: Record<string, unknown> }) => void;
  onUsage?: (usage: AnthropicUsage) => void;
  onError?: (err: Error) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_MAX_DELAY_MS = 8_000;

const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function resolveApiKey(opts: AnthropicCallOptions): string {
  if (opts.apiKey) return opts.apiKey;
  const fromEnv =
    process.env.ANTHROPIC_API_KEY ??
    process.env.ANTHROPIC_AUTH_TOKEN ??
    process.env.CLAUDE_API_KEY;
  if (!fromEnv) {
    throw new AnthropicError(
      "Anthropic API key not set. Provide `apiKey`, or set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_API_KEY.",
      401,
    );
  }
  return fromEnv;
}

function resolveBaseUrl(opts: AnthropicCallOptions): string {
  return (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? ANTHROPIC_DEFAULT_BASE_URL)
    .replace(/\/+$/, "");
}

function resolveAnthropicVersion(opts: AnthropicCallOptions): string {
  return opts.anthropicVersion ?? process.env.ANTHROPIC_VERSION ?? ANTHROPIC_DEFAULT_VERSION;
}

function resolveMaxRetries(opts: AnthropicCallOptions): number {
  if (opts.maxRetries !== undefined) return opts.maxRetries;
  const env = Number(process.env.ANTHROPIC_MAX_RETRIES);
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_MAX_RETRIES;
}

function resolveTimeoutMs(opts: AnthropicCallOptions): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const env = Number(process.env.ANTHROPIC_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS;
}

function resolveDefaultCacheTtl(opts: AnthropicCallOptions): CacheTtl {
  return opts.defaultCacheTtl ?? (process.env.ANTHROPIC_CACHE_TTL === "1h" ? "1h" : "5m");
}

function backoffMs(attempt: number): number {
  // exponential backoff with cap
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Error
// ─────────────────────────────────────────────────────────────────────────────

export class AnthropicError extends Error {
  readonly status: number;
  readonly type: string;
  readonly headers: Record<string, string>;
  constructor(message: string, status = 0, type = "unknown", headers: Record<string, string> = {}) {
    super(message);
    this.name = "AnthropicError";
    this.status = status;
    this.type = type;
    this.headers = headers;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: streamMessages
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamMessagesResult {
  promise: Promise<AnthropicResponseAccumulator>;
  abort: () => void;
}

/**
 * Stream an Anthropic Messages request. Returns a handle with `promise`
 * and `abort`. The promise resolves to the full accumulator.
 */
export function streamMessages(
  request: Omit<AnthropicRequest, "stream">,
  options: AnthropicCallOptions = {},
  handlers: AnthropicStreamHandlers = {},
): StreamMessagesResult {
  const ctrl = new AbortController();
  // Forward user-provided signal
  if (options.signal) {
    if (options.signal.aborted) ctrl.abort();
    else options.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  const promise = runStream(request, { ...options, signal: ctrl.signal }, handlers, ctrl);
  return { promise, abort: () => ctrl.abort() };
}

async function runStream(
  request: Omit<AnthropicRequest, "stream">,
  options: AnthropicCallOptions,
  handlers: AnthropicStreamHandlers,
  ctrl: AbortController,
): Promise<AnthropicResponseAccumulator> {
  const apiKey = resolveApiKey(options);
  const baseUrl = resolveBaseUrl(options);
  const version = resolveAnthropicVersion(options);
  const maxRetries = resolveMaxRetries(options);
  const timeoutMs = resolveTimeoutMs(options);
  const defaultCacheTtl = resolveDefaultCacheTtl(options);

  const body = serializeRequest(request, { defaultCacheTtl, options });
  const url = `${baseUrl}/v1/messages`;

  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= maxRetries) {
    if (ctrl.signal.aborted) {
      throw new AnthropicError("aborted", 0, "aborted");
    }
    try {
      return await runStreamOnce(url, body, {
        apiKey,
        version,
        timeoutMs,
        signal: ctrl.signal,
        handlers,
      });
    } catch (err) {
      lastErr = err;
      if (ctrl.signal.aborted) throw err;
      if (err instanceof AnthropicError) {
        if (!isRetryableStatus(err.status) || attempt === maxRetries) throw err;
      } else if (attempt === maxRetries) {
        throw err;
      }
      await sleep(backoffMs(attempt), ctrl.signal);
      attempt += 1;
    }
  }
  throw lastErr instanceof Error ? lastErr : new AnthropicError("stream failed", 0, "unknown");
}

async function runStreamOnce(
  url: string,
  body: AnthropicRequest,
  ctx: {
    apiKey: string;
    version: string;
    timeoutMs: number;
    signal: AbortSignal;
    handlers: AnthropicStreamHandlers;
  },
): Promise<AnthropicResponseAccumulator> {
  const { apiKey, version, timeoutMs, signal, handlers } = ctx;

  const cacheAffinity = getCacheAffinityHint(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": version,
    "x-api-key": apiKey,
    "user-agent": "pakalon-cli/1.0 (anthropic-messages)",
  };
  if (cacheAffinity) headers["x-pakalon-cache-affinity"] = cacheAffinity;
  if (isInterleavedThinkingEnabled(body)) {
    headers["x-pakalon-interleaved-thinking"] = "1";
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new AnthropicError(
      `Anthropic ${res.status}: ${redactSensitive(text).slice(0, 4096)}`,
      res.status,
      "http_error",
      Object.fromEntries(res.headers.entries()),
    );
  }

  return consumeSse(res.body, signal, handlers);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE consumer
// ─────────────────────────────────────────────────────────────────────────────

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  handlers: AnthropicStreamHandlers,
): Promise<AnthropicResponseAccumulator> {
  const acc: AnthropicResponseAccumulator = {
    id: "",
    model: "",
    text: "",
    thinking: "",
    toolCalls: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    stopReason: null,
  };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const reader = body.getReader();
  let buf = "";
  let eventName = "";
  let dataLines: string[] = [];

  // Track the current block being streamed (so we can route deltas).
  let currentBlock: { type: string; index: number; name?: string; id?: string; inputBuf?: string } | null = null;

  const flushEvent = () => {
    if (!eventName || dataLines.length === 0) {
      eventName = "";
      dataLines = [];
      return;
    }
    const data = dataLines.join("\n");
    eventName = "";
    dataLines = [];
    let evt: AnthropicStreamEvent;
    try {
      evt = JSON.parse(data) as AnthropicStreamEvent;
    } catch {
      // Some proxies inject `: ping` comments. Skip.
      return;
    }
    handlers.onEvent?.(evt);

    switch (evt.type) {
      case "message_start": {
        acc.id = evt.message.id;
        acc.model = evt.message.model;
        acc.usage = { ...evt.message.usage };
        return;
      }
      case "content_block_start": {
        if (evt.content_block.type === "tool_use") {
          currentBlock = {
            type: "tool_use",
            index: evt.index,
            id: evt.content_block.id,
            name: evt.content_block.name,
            inputBuf: "",
          };
        } else if (evt.content_block.type === "text") {
          currentBlock = { type: "text", index: evt.index };
        } else if (evt.content_block.type === "thinking") {
          currentBlock = { type: "thinking", index: evt.index };
        } else if (evt.content_block.type === "redacted_thinking") {
          currentBlock = { type: "redacted_thinking", index: evt.index };
        }
        return;
      }
      case "content_block_delta": {
        if (evt.delta.type === "text_delta") {
          const chunk = sanitizeUnicode(evt.delta.text);
          acc.text += chunk;
          handlers.onTextDelta?.(chunk);
        } else if (evt.delta.type === "thinking_delta") {
          const chunk = sanitizeUnicode(evt.delta.thinking);
          acc.thinking += chunk;
          handlers.onThinkingDelta?.(chunk);
        } else if (evt.delta.type === "input_json_delta" && currentBlock?.type === "tool_use") {
          currentBlock.inputBuf = (currentBlock.inputBuf ?? "") + evt.delta.partial_json;
          handlers.onToolInputDelta?.(currentBlock.id!, evt.delta.partial_json);
        }
        return;
      }
      case "content_block_stop": {
        if (currentBlock?.type === "tool_use") {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = currentBlock.inputBuf ? JSON.parse(currentBlock.inputBuf) : {};
          } catch {
            // Don't throw — the model sometimes sends malformed JSON.
            // Surface as a tool-error result downstream.
            parsed = { _parseError: true, raw: currentBlock.inputBuf };
          }
          const id = normalizeToolCallId(currentBlock.id!);
          const call = { id, name: currentBlock.name!, input: parsed };
          acc.toolCalls.push(call);
          handlers.onToolCallReady?.(call);
        }
        currentBlock = null;
        return;
      }
      case "message_delta": {
        if (evt.delta.stop_reason) acc.stopReason = evt.delta.stop_reason;
        acc.usage.output_tokens = evt.usage.output_tokens;
        return;
      }
      case "message_stop": {
        handlers.onUsage?.(acc.usage);
        return;
      }
      case "error": {
        handlers.onError?.(new AnthropicError(evt.error.message, 0, evt.error.type));
        return;
      }
      case "ping": {
        return;
      }
      default: {
        // Unknown event types are tolerated.
        return;
      }
    }
  };

  try {
    while (true) {
      if (signal.aborted) throw new AnthropicError("aborted", 0, "aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE framing: events are separated by blank lines.
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const rawEvent = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const lines = rawEvent.split("\n");
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
          // Comments (`: ...`) are ignored.
        }
        flushEvent();
        sep = buf.indexOf("\n\n");
      }
    }
    // Process trailing event if any.
    if (buf.trim().length > 0) {
      const lines = buf.split("\n");
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      flushEvent();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return acc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request serialization
// ─────────────────────────────────────────────────────────────────────────────

function serializeRequest(
  request: Omit<AnthropicRequest, "stream">,
  ctx: { defaultCacheTtl: CacheTtl; options: AnthropicCallOptions },
): AnthropicRequest {
  const req: AnthropicRequest = { ...request, stream: true };

  // Apply default cache TTL to blocks that have cache_control without ttl.
  if (req.system) applyDefaultTtl(req.system, ctx.defaultCacheTtl);
  if (req.tools) for (const t of req.tools) applyDefaultTtl(t, ctx.defaultCacheTtl);
  for (const m of req.messages) applyDefaultTtl(m.content, ctx.defaultCacheTtl);

  // Normalize tool_use_id from any openai-style ids inside tool_result blocks.
  for (const m of req.messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_result" && isOpenAIToolCallId(block.tool_use_id)) {
        block.tool_use_id = normalizeToolCallId(block.tool_use_id);
      }
    }
  }

  // Normalize tool choice for empty tool list.
  if ((req.tools?.length ?? 0) === 0) delete req.tool_choice;

  // Cache-affinity routing key (used by load-balancer proxies).
  if (!req.metadata) req.metadata = {};
  req.metadata.user_id = req.metadata.user_id ?? pickCacheAffinityKey();

  // Thinking mode.
  if (ctx.options.adaptiveThinking) {
    req.thinking = { type: "adaptive" };
  } else if (ctx.options.effort && !req.thinking) {
    req.thinking = { type: "enabled", budget_tokens: effortToBudget(ctx.options.effort) };
  }
  // Max tokens must be >= thinking budget.
  if (req.thinking?.type === "enabled") {
    const budget = req.thinking.budget_tokens ?? 0;
    if (req.max_tokens <= budget) {
      req.max_tokens = budget + Math.max(1024, Math.floor(budget * 0.25));
    }
  }

  // Interleaved thinking marker (system-side nudge). Only emit if enabled.
  if (ctx.options.interleavedThinking && req.system) {
    const marker = buildInterleavedThinkingMarker();
    if (typeof req.system === "string") {
      req.system = [{ type: "text", text: req.system }, { type: "text", text: marker }];
    } else {
      req.system = [...req.system, { type: "text", text: marker }];
    }
  }

  return req;
}

function applyDefaultTtl(target: unknown, ttl: CacheTtl): void {
  if (!target) return;
  if (Array.isArray(target)) {
    for (const t of target) applyDefaultTtl(t, ttl);
    return;
  }
  if (typeof target !== "object") return;
  const obj = target as { cache_control?: { type: "ephemeral"; ttl?: CacheTtl } | null };
  if (obj.cache_control && obj.cache_control.type === "ephemeral" && !obj.cache_control.ttl) {
    obj.cache_control.ttl = ttl;
  }
}

function effortToBudget(effort: EffortLevel): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 16384;
    case "max":
      return 65536;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: generateMessages (non-streaming convenience)
// ─────────────────────────────────────────────────────────────────────────────

export async function generateMessages(
  request: Omit<AnthropicRequest, "stream">,
  options: AnthropicCallOptions = {},
): Promise<AnthropicResponseAccumulator> {
  const handle = streamMessages(request, options);
  return handle.promise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: helpers exported for callers (engine.ts, agents/, etc.)
// ─────────────────────────────────────────────────────────────────────────────

export { pickCacheAffinityKey, getCacheAffinityHint } from "./cache-affinity.js";
export { normalizeToolCallId, isOpenAIToolCallId } from "./tool-call-id.js";
export { isInterleavedThinkingEnabled, buildInterleavedThinkingMarker } from "./interleaved-thinking.js";
export { AnthropicError as Error };
export const isAnthropicModelId = (id: string): boolean => /^claude(-|$)/i.test(id);
