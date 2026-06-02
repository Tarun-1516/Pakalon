/**
 * First-party OpenAI Responses API client.
 *
 * Implements the OpenAI Responses API surface used by Pakalon-CLI:
 *  - POST /v1/responses with `instructions` / `input` / `tools` / `tool_choice`
 *  - Server-Sent Events (SSE) streaming:
 *      response.created, response.in_progress, response.output_item.added,
 *      response.content_part.added, response.output_text.delta,
 *      response.function_call_arguments.delta, response.reasoning_summary_text.delta,
 *      response.output_item.done, response.completed, response.error, error
 *  - Prompt cache: pass `prompt_cache_key` and `prompt_cache_retention="24h"|"in-memory"`
 *  - Built-in tools: web_search, file_search, code_interpreter, image_generation
 *  - Computer-use (preview) tool
 *  - Native function-calling: `function_call` items with `arguments` JSON
 *  - Reasoning items with `summary` array (multi-text)
 *  - previous_response_id chaining
 *  - structured outputs (response_format: json_schema)
 *  - parallel_tool_calls toggle
 *  - AbortSignal + retries with exponential backoff on 429/5xx
 *  - Tool-call-id normalization (calls into ./tool-call-id.js)
 *  - Cache-affinity routing hint (calls into ./cache-affinity.js)
 *  - WebSocket transport for codex (response.websocket endpoint), opt-in via `transport:"ws"`
 *
 * This is the canonical "openai-responses" provider implementation
 * (i.e. NOT a thin wrapper over OpenRouter). OpenRouter is still used as
 * the proxy fallback; this client is used when OPENAI_API_KEY is set
 * and the model id starts with `gpt-` or `o` or `codex-` and
 * `PAKALON_USE_OPENAI=1`.
 */
import { randomUUID } from "node:crypto";
import {
  normalizeToolCallId,
  isAnthropicToolCallId,
} from "./tool-call-id.js";
import {
  pickCacheAffinityKey,
  getCacheAffinityHint,
} from "./cache-affinity.js";
import { redactSensitive, sanitizeUnicode, isEnoent } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";
export type CacheRetention = "in-memory" | "24h";

export type ResponseTransport = "sse" | "ws";

export interface OpenAIImageContent {
  type: "input_image";
  detail?: "auto" | "low" | "high";
  image_url: string; // data: URL or https:// URL
}

export interface OpenAIFileContent {
  type: "input_file";
  file_data?: string; // base64 data: URL
  file_id?: string; //  uploaded file id from /v1/files
  filename?: string;
}

export interface OpenAITextContent {
  type: "input_text";
  text: string;
}

export type OpenAIInputContent =
  | OpenAITextContent
  | OpenAIImageContent
  | OpenAIFileContent;

export interface OpenAIInputItem {
  /** Convenience: string => treated as `message` role with text content. */
  role?: "user" | "system" | "assistant" | "developer";
  type?: "message" | "function_call_output" | "reasoning" | "function_call";
  /** Used when `type === "message"`. */
  content?: string | OpenAIInputContent[];
  /** Used when `type === "function_call_output"`. */
  call_id?: string;
  output?: string | Array<{ type: "input_text"; text: string }>;
  /** Used when `type === "function_call"`. */
  name?: string;
  arguments?: string;
  /** For reasoning items. */
  summary?: Array<{ type: "summary_text"; text: string }>;
}

export interface OpenAIFunctionTool {
  type: "function";
  name: string;
  description?: string;
  strict?: boolean;
  parameters: Record<string, unknown>;
}

export interface OpenAIWebSearchTool {
  type: "web_search";
  search_context_size?: "low" | "medium" | "high";
  user_location?: {
    type: "approximate";
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
}

export interface OpenAIFileSearchTool {
  type: "file_search";
  vector_store_ids: string[];
  max_num_results?: number;
  filters?: unknown;
  ranking_options?: { ranker?: string; score_threshold?: number };
}

export interface OpenAICodeInterpreterTool {
  type: "code_interpreter";
  container:
    | string
    | { type: "auto"; file_ids?: string[] };
}

export interface OpenAIComputerUseTool {
  type: "computer_use_preview";
  display_width: number;
  display_height: number;
  environment?: "browser" | "mac" | "windows" | "linux";
}

export type OpenAITool =
  | OpenAIFunctionTool
  | OpenAIWebSearchTool
  | OpenAIFileSearchTool
  | OpenAICodeInterpreterTool
  | OpenAIComputerUseTool;

export interface OpenAIResponseFormat {
  type: "text" | "json_object" | "json_schema";
  json_schema?: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OpenAIResponsesCallOptions {
  apiKey?: string;
  baseUrl?: string; // default https://api.openai.com
  organization?: string;
  project?: string;
  /** Default 60s. */
  timeoutMs?: number;
  /** Default 4. */
  maxRetries?: number;
  signal?: AbortSignal;
  /** "sse" (default) or "ws" (uses the WebSocket transport, codex only). */
  transport?: ResponseTransport;
  /** Override the cache-affinity key for the request. */
  cacheKey?: string;
  /** Extra headers. */
  extraHeaders?: Record<string, string>;
}

export interface OpenAIResponsesRequest {
  model: string; // e.g. "gpt-4.1", "gpt-4o", "o3", "o4-mini", "codex-mini"
  input: string | OpenAIInputItem[];
  /** Top-level system/developer prompt (preferred over per-item system messages). */
  instructions?: string;
  tools?: OpenAITool[];
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; name: string }
    | { type: "allowed_tools"; mode: "auto" | "required"; tools: Array<{ type: "function"; name: string }> };
  parallel_tool_calls?: boolean;
  /** Server-side reasoning effort. */
  reasoning?: { effort?: EffortLevel; summary?: "auto" | "concise" | "detailed" };
  /** Built-in text verbosity. */
  text?: { verbosity?: "low" | "medium" | "high" };
  /** Response shape. */
  response_format?: OpenAIResponseFormat;
  /** Truncation strategy. */
  truncation?: "auto" | "disabled";
  /** Max output tokens. */
  max_output_tokens?: number;
  /** Temperature 0..2. */
  temperature?: number;
  /** Nucleus sampling. */
  top_p?: number;
  /** Frequency / presence penalty. */
  frequency_penalty?: number;
  presence_penalty?: number;
  /** Stop sequences. */
  stop?: string | string[];
  /** Pass-through user id. */
  user?: string;
  /** Chain from a previous response. */
  previous_response_id?: string;
  /** Stable cache key. */
  prompt_cache_key?: string;
  prompt_cache_retention?: CacheRetention;
  /** Safety identifier. */
  safety_identifier?: string;
  metadata?: Record<string, string>;
  /** Emit SSE deltas. */
  stream?: boolean;
  /** Tool-call-id mapping for OpenAI→Anthropic compatibility. */
  toolCallIdMap?: Record<string, string>;
  options?: OpenAIResponsesCallOptions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming accumulator
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIUsageMetrics {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Tokens that hit the prompt cache (1h or 24h retention). */
  cached_tokens: number;
  /** Reasoning tokens (for o-series). */
  reasoning_tokens: number;
}

export interface OpenAITextDelta {
  type: "text";
  text: string;
  item_id: string;
  content_index: number;
}

export interface OpenAIReasoningDelta {
  type: "reasoning_summary";
  text: string;
  item_id: string;
  summary_index: number;
}

export interface OpenAIToolCallDelta {
  type: "tool_call_args";
  call_id: string;
  name?: string;
  arguments: string;
}

export interface OpenAIToolCallDone {
  type: "tool_call_done";
  call_id: string;
  name: string;
  arguments: string;
}

export interface OpenAIImageGenCallProgress {
  type: "image_gen";
  item_id: string;
  /** Base64 PNG. */
  partial_image_b64?: string;
}

export interface OpenAIWebSearchDone {
  type: "web_search_done";
  item_id: string;
  action?: {
    type: "search" | "open_page" | "find_in_page";
    query?: string;
    url?: string;
  };
}

export interface OpenAIFileSearchDone {
  type: "file_search_done";
  item_id: string;
  results?: Array<{
    file_id: string;
    filename: string;
    score: number;
    text?: string;
  }>;
}

export interface OpenAICodeInterpreterDone {
  type: "code_interpreter_done";
  item_id: string;
  /** Container id. */
  container_id?: string;
  /** Outputs (text or images). */
  outputs?: Array<
    | { type: "logs"; logs: string }
    | { type: "image"; url: string }
  >;
}

export interface OpenAIReasoningDone {
  type: "reasoning_done";
  item_id: string;
  summary: string;
}

export interface OpenAIResponseCompleted {
  type: "response_completed";
  response: OpenAIResponse;
}

export type OpenAIStreamEvent =
  | OpenAITextDelta
  | OpenAIReasoningDelta
  | OpenAIToolCallDelta
  | OpenAIToolCallDone
  | OpenAIImageGenCallProgress
  | OpenAIWebSearchDone
  | OpenAIFileSearchDone
  | OpenAICodeInterpreterDone
  | OpenAIReasoningDone
  | OpenAIResponseCompleted
  | { type: "error"; code: string; message: string }
  | { type: "ping" };

export interface OpenAIResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
  output: Array<OpenAIInputItem & { id: string; status?: string }>;
  usage: OpenAIUsageMetrics;
  previous_response_id?: string;
  prompt_cache_key?: string;
  prompt_cache_retention?: CacheRetention;
  /** Convenience: flattened text from all assistant message items. */
  output_text: string;
  /** Convenience: flattened reasoning summaries. */
  reasoning_summary: string;
  error?: { code: string; message: string };
  incomplete_details?: { reason: string };
  metadata?: Record<string, string>;
  tools?: OpenAITool[];
  tool_choice?: OpenAIResponsesRequest["tool_choice"];
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
}

export interface OpenAIResponseAccumulator {
  response: Partial<OpenAIResponse> & {
    output: Array<OpenAIInputItem & { id: string; status?: string }>;
  };
  usage: OpenAIUsageMetrics;
  outputText: string;
  reasoningSummary: string;
  /** Per-call-id arg accumulator. */
  toolCallArgs: Map<string, { name: string; arguments: string }>;
  /** Last event timestamp (ms). */
  lastEventAt: number;
  errors: Array<{ code: string; message: string }>;
}

export function createAccumulator(): OpenAIResponseAccumulator {
  return {
    response: { output: [] },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
    },
    outputText: "",
    reasoningSummary: "",
    toolCallArgs: new Map(),
    lastEventAt: Date.now(),
    errors: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────────────────────────────────────

export class OpenAIResponsesError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    code = "openai_responses_error",
    requestId?: string,
  ) {
    super(redactSensitive(message));
    this.name = "OpenAIResponsesError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_MAX_DELAY_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  // Exponential backoff with jitter
  const exp = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** attempt,
  );
  return exp / 2 + Math.random() * (exp / 2);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 ||
    status === 429 || (status >= 500 && status < 600);
}

export function isOpenAIResponsesModelId(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    m.startsWith("gpt-") ||
    m.startsWith("o") || // o1, o3, o4-mini, o5 (when released)
    m.startsWith("codex-") ||
    m.startsWith("chatgpt-") ||
    m.startsWith("openai/")
  );
}

/** Convert an OpenAI-style "fc_*" / "call_*" id to a normalized form. */
function mapToolCallId(id: string, map?: Record<string, string>): string {
  if (!id) return normalizeToolCallId(id);
  if (map && map[id]) return map[id];
  // OpenAI Responses uses `fc_*` and `call_*` natively, same as our normalizer handles.
  return normalizeToolCallId(id);
}

/** Pull "OpenAI-style" arg accumulator (string). */
function appendArgs(
  buf: { name: string; arguments: string },
  delta: string,
): { name: string; arguments: string } {
  return { name: buf.name, arguments: buf.arguments + delta };
}

function safeJSONParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE parser
// ─────────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataBuf: string[] = [];
  let eventName = "message";

  const abortHandler = () => {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  };
  if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "" || line === "\r") {
          // dispatch
          if (dataBuf.length) {
            yield {
              event: eventName,
              data: dataBuf.join("\n"),
            };
            dataBuf = [];
            eventName = "message";
          }
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let valuePart = colon === -1 ? "" : line.slice(colon + 1);
        if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
        if (field === "event") eventName = valuePart;
        else if (field === "data") dataBuf.push(valuePart);
        else if (field === "id") {
          // per spec, last seen id is not really used here
        }
      }
    }
    // flush any trailing buffer
    if (dataBuf.length) {
      yield { event: eventName, data: dataBuf.join("\n") };
    }
  } finally {
    if (signal) signal.removeEventListener("abort", abortHandler);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream → accumulator
// ─────────────────────────────────────────────────────────────────────────────

async function* streamAccumulator(
  body: ReadableStream<Uint8Array>,
  accumulator: OpenAIResponseAccumulator,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIStreamEvent> {
  for await (const ev of parseSSEStream(body, signal)) {
    if (ev.event === "ping") {
      yield { type: "ping" };
      continue;
    }
    if (ev.event === "error") {
      let parsed: { code?: string; message?: string } = {};
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        parsed = { message: ev.data };
      }
      const errObj = {
        code: parsed.code ?? "stream_error",
        message: parsed.message ?? "Stream error",
      };
      accumulator.errors.push(errObj);
      yield { type: "error", code: errObj.code, message: errObj.message };
      continue;
    }
    let parsed: any = undefined;
    if (ev.data && ev.data !== "[DONE]") {
      parsed = safeJSONParse(ev.data);
    }
    if (!parsed) continue;
    accumulator.lastEventAt = Date.now();
    yield* routeEvent(parsed, accumulator);
  }
}

function* routeEvent(
  parsed: any,
  accumulator: OpenAIResponseAccumulator,
): Generator<OpenAIStreamEvent> {
  const t = parsed.type as string | undefined;
  switch (t) {
    case "response.created":
    case "response.in_progress":
    case "response.queued": {
      const r = parsed.response ?? {};
      accumulator.response = {
        ...accumulator.response,
        id: r.id,
        object: r.object,
        created_at: r.created_at,
        model: r.model,
        status: r.status,
        previous_response_id: r.previous_response_id,
        prompt_cache_key: r.prompt_cache_key,
        prompt_cache_retention: r.prompt_cache_retention,
        metadata: r.metadata,
        tools: r.tools,
        tool_choice: r.tool_choice,
        temperature: r.temperature,
        top_p: r.top_p,
        max_output_tokens: r.max_output_tokens,
      };
      return;
    }
    case "response.output_item.added": {
      const item = parsed.item;
      if (item) {
        accumulator.response.output.push({
          ...item,
          id: item.id ?? randomUUID(),
        });
        if (item.type === "function_call") {
          accumulator.toolCallArgs.set(item.call_id, {
            name: item.name ?? "",
            arguments: item.arguments ?? "",
          });
        }
      }
      return;
    }
    case "response.content_part.added": {
      // No-op: we capture deltas
      return;
    }
    case "response.output_text.delta": {
      const delta: string = parsed.delta ?? "";
      const itemId: string = parsed.item_id;
      const contentIndex: number = parsed.content_index ?? 0;
      accumulator.outputText += delta;
      yield {
        type: "text",
        text: delta,
        item_id: itemId,
        content_index: contentIndex,
      };
      return;
    }
    case "response.function_call_arguments.delta": {
      const callId: string = parsed.call_id ?? parsed.item_id;
      const delta: string = parsed.delta ?? "";
      const prev = accumulator.toolCallArgs.get(callId) ?? {
        name: parsed.name ?? "",
        arguments: "",
      };
      accumulator.toolCallArgs.set(callId, appendArgs(prev, delta));
      yield {
        type: "tool_call_args",
        call_id: callId,
        name: prev.name || parsed.name,
        arguments: delta,
      };
      return;
    }
    case "response.reasoning_summary_text.delta": {
      const itemId: string = parsed.item_id;
      const idx: number = parsed.summary_index ?? 0;
      const delta: string = parsed.delta ?? "";
      accumulator.reasoningSummary += delta;
      yield {
        type: "reasoning_summary",
        text: delta,
        item_id: itemId,
        summary_index: idx,
      };
      return;
    }
    case "response.output_item.done": {
      const item = parsed.item;
      if (!item) return;
      // Replace the placeholder pushed on `.added` with the final one.
      const idx = accumulator.response.output.findIndex(
        (o) => o.id === item.id,
      );
      if (idx >= 0) accumulator.response.output[idx] = item;
      else accumulator.response.output.push(item);

      switch (item.type) {
        case "function_call": {
          const args = accumulator.toolCallArgs.get(item.call_id) ?? {
            name: item.name ?? "",
            arguments: item.arguments ?? "",
          };
          if (item.arguments && !args.arguments) {
            args.arguments = item.arguments;
          }
          if (item.name && !args.name) args.name = item.name;
          accumulator.toolCallArgs.set(item.call_id, args);
          yield {
            type: "tool_call_done",
            call_id: item.call_id,
            name: args.name || item.name || "",
            arguments: args.arguments,
          };
          return;
        }
        case "reasoning": {
          const summary = (item.summary ?? [])
            .map((s: { text?: string }) => s.text ?? "")
            .join("");
          yield {
            type: "reasoning_done",
            item_id: item.id,
            summary,
          };
          return;
        }
        case "web_search_call": {
          yield {
            type: "web_search_done",
            item_id: item.id,
            action: item.action,
          };
          return;
        }
        case "file_search_call": {
          yield {
            type: "file_search_done",
            item_id: item.id,
            results: item.results,
          };
          return;
        }
        case "code_interpreter_call": {
          yield {
            type: "code_interpreter_done",
            item_id: item.id,
            container_id: item.container_id,
            outputs: item.outputs,
          };
          return;
        }
        case "image_generation_call": {
          // The full image is in item.result (base64).
          yield {
            type: "image_gen",
            item_id: item.id,
            partial_image_b64: item.result,
          };
          return;
        }
        default:
          return;
      }
    }
    case "response.completed": {
      const r = parsed.response ?? {};
      const usage: OpenAIUsageMetrics = {
        input_tokens: r.usage?.input_tokens ?? 0,
        output_tokens: r.usage?.output_tokens ?? 0,
        total_tokens:
          r.usage?.total_tokens ??
          (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0),
        cached_tokens:
          r.usage?.input_tokens_details?.cached_tokens ?? 0,
        reasoning_tokens:
          r.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      };
      accumulator.usage = usage;
      accumulator.response = {
        ...accumulator.response,
        ...r,
        output: r.output ?? accumulator.response.output,
        output_text: accumulator.outputText,
        reasoning_summary: accumulator.reasoningSummary,
      };
      // Make sure the final response is reachable as a single object.
      const completed: OpenAIResponse = {
        id: r.id ?? accumulator.response.id ?? randomUUID(),
        object: "response",
        created_at: r.created_at ?? accumulator.response.created_at ?? 0,
        model: r.model ?? accumulator.response.model ?? "",
        status: r.status ?? "completed",
        output: accumulator.response.output,
        usage,
        previous_response_id:
          r.previous_response_id ?? accumulator.response.previous_response_id,
        prompt_cache_key:
          r.prompt_cache_key ?? accumulator.response.prompt_cache_key,
        prompt_cache_retention:
          r.prompt_cache_retention ?? accumulator.response.prompt_cache_retention,
        output_text: accumulator.outputText,
        reasoning_summary: accumulator.reasoningSummary,
        error: r.error,
        incomplete_details: r.incomplete_details,
        metadata: r.metadata,
        tools: r.tools,
        tool_choice: r.tool_choice,
        temperature: r.temperature,
        top_p: r.top_p,
        max_output_tokens: r.max_output_tokens,
      };
      accumulator.response = completed;
      yield { type: "response_completed", response: completed };
      return;
    }
    case "response.incomplete": {
      const r = parsed.response ?? {};
      accumulator.response = {
        ...accumulator.response,
        ...r,
        output: r.output ?? accumulator.response.output,
        output_text: accumulator.outputText,
        reasoning_summary: accumulator.reasoningSummary,
        status: "incomplete",
        incomplete_details: r.incomplete_details,
      };
      return;
    }
    case "response.failed": {
      const r = parsed.response ?? {};
      accumulator.response = {
        ...accumulator.response,
        ...r,
        status: "failed",
        error: r.error,
      };
      accumulator.errors.push(
        r.error ?? { code: "response_failed", message: "Response failed" },
      );
      return;
    }
    default:
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stream an OpenAI Responses request.
 *
 * Yields `OpenAIStreamEvent` for every meaningful SSE event. The accumulator
 * is mutated in place so callers can inspect partial state.
 */
export async function* streamOpenAIResponses(
  req: OpenAIResponsesRequest,
): AsyncGenerator<OpenAIStreamEvent> {
  const opts = req.options ?? {};
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new OpenAIResponsesError(
      "OPENAI_API_KEY is not set. Pass `options.apiKey` or set the env var.",
      401,
      "missing_api_key",
    );
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const transport = opts.transport ?? "sse";

  if (transport === "ws") {
    yield* streamOpenAIResponsesOverWebSocket(req, apiKey, baseUrl, opts);
    return;
  }

  // Build the body
  const body: any = {
    model: req.model,
    input: req.input,
    stream: true,
  };
  if (req.instructions) body.instructions = req.instructions;
  if (req.tools) body.tools = req.tools;
  if (req.tool_choice) body.tool_choice = req.tool_choice;
  if (typeof req.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = req.parallel_tool_calls;
  }
  if (req.reasoning) body.reasoning = req.reasoning;
  if (req.text) body.text = req.text;
  if (req.response_format) body.response_format = req.response_format;
  if (req.truncation) body.truncation = req.truncation;
  if (typeof req.max_output_tokens === "number") {
    body.max_output_tokens = req.max_output_tokens;
  }
  if (typeof req.temperature === "number") body.temperature = req.temperature;
  if (typeof req.top_p === "number") body.top_p = req.top_p;
  if (typeof req.frequency_penalty === "number") {
    body.frequency_penalty = req.frequency_penalty;
  }
  if (typeof req.presence_penalty === "number") {
    body.presence_penalty = req.presence_penalty;
  }
  if (req.stop) body.stop = req.stop;
  if (req.user) body.user = req.user;
  if (req.previous_response_id) {
    body.previous_response_id = req.previous_response_id;
  }
  if (req.prompt_cache_key) body.prompt_cache_key = req.prompt_cache_key;
  if (req.prompt_cache_retention) {
    body.prompt_cache_retention = req.prompt_cache_retention;
  }
  if (req.safety_identifier) body.safety_identifier = req.safety_identifier;
  if (req.metadata) body.metadata = req.metadata;

  const cacheKey = req.prompt_cache_key ?? opts.cacheKey ?? pickCacheAffinityKey();
  if (!req.prompt_cache_key) body.prompt_cache_key = cacheKey;

  // Headers
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    accept: "text/event-stream",
    "x-pakalon-cache-affinity": cacheKey,
    "x-pakalon-tool-call-id-version": "v1",
  };
  if (opts.organization) headers["OpenAI-Organization"] = opts.organization;
  if (opts.project) headers["OpenAI-Project"] = opts.project;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new OpenAIResponsesError("Request aborted", 499, "aborted");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const res = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(sanitizeUnicode(body)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        const reqId = res.headers.get("x-request-id") ?? undefined;
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          lastError = new OpenAIResponsesError(
            `OpenAI ${res.status}: ${errText.slice(0, 500)}`,
            res.status,
            "http_error",
            reqId,
          );
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new OpenAIResponsesError(
          `OpenAI ${res.status}: ${errText.slice(0, 500)}`,
          res.status,
          "http_error",
          reqId,
        );
      }
      if (!res.body) {
        throw new OpenAIResponsesError(
          "OpenAI returned an empty body",
          500,
          "empty_body",
        );
      }
      const accumulator = createAccumulator();
      for await (const ev of streamAccumulator(res.body, accumulator, opts.signal)) {
        yield ev;
      }
      return;
    } catch (e) {
      if (e instanceof OpenAIResponsesError) {
        if (
          isRetryableStatus(e.status) &&
          attempt < maxRetries &&
          !(e instanceof DOMException)
        ) {
          lastError = e;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw e;
      }
      if (isEnoent(e as Error)) {
        throw new OpenAIResponsesError(
          `Local file not found: ${(e as NodeJS.ErrnoException).path ?? ""}`,
          424,
          "missing_file",
        );
      }
      // AbortError
      if ((e as Error).name === "AbortError") {
        throw new OpenAIResponsesError(
          "Request aborted or timed out",
          499,
          "aborted",
        );
      }
      lastError = e;
      if (attempt < maxRetries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw new OpenAIResponsesError(
        (e as Error)?.message ?? "Unknown error",
        599,
        "network_error",
      );
    } finally {
      clearTimeout(timeout);
      if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
    }
  }
  // Should not reach here, but just in case:
  throw lastError instanceof Error
    ? lastError
    : new OpenAIResponsesError("Max retries exhausted", 599, "max_retries");
}

/** Non-streaming variant: collect all deltas, return a complete response. */
export async function generateOpenAIResponses(
  req: OpenAIResponsesRequest,
): Promise<OpenAIResponse> {
  const nonStream = { ...req, stream: true };
  let last: OpenAIResponse | undefined;
  for await (const ev of streamOpenAIResponses(nonStream)) {
    if (ev.type === "response_completed") last = ev.response;
  }
  if (!last) {
    throw new OpenAIResponsesError(
      "Response did not complete",
      500,
      "incomplete",
    );
  }
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket transport (codex / realtime models)
// ─────────────────────────────────────────────────────────────────────────────

async function* streamOpenAIResponsesOverWebSocket(
  req: OpenAIResponsesRequest,
  apiKey: string,
  baseUrl: string,
  opts: OpenAIResponsesCallOptions,
): AsyncGenerator<OpenAIStreamEvent> {
  // Bun supports `WebSocket` from the global scope. For Node compat we
  // import dynamically. We use the `wss://` endpoint at the same host.
  const wsUrl = baseUrl.replace(/^https?/, "wss") + `/v1/responses/ws?model=${encodeURIComponent(req.model)}`;
  const ws = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${apiKey}` },
  } as unknown as string[]);

  // Wait for open
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(new OpenAIResponsesError(
      `WebSocket error: ${(e as ErrorEvent).message ?? "unknown"}`,
      599, "ws_error")), { once: true });
  });

  const queue: OpenAIStreamEvent[] = [];
  let closed = false;
  let closeReason: OpenAIResponsesError | null = null;

  ws.addEventListener("message", (e) => {
    const data = typeof e.data === "string" ? e.data : "";
    if (!data) return;
    const parsed = safeJSONParse<any>(data);
    if (!parsed) return;
    const acc = createAccumulator();
    const events = Array.from(routeEvent(parsed, acc));
    for (const ev of events) queue.push(ev);
  });
  ws.addEventListener("close", (e) => {
    closed = true;
    if (e.code !== 1000) {
      closeReason = new OpenAIResponsesError(
        `WebSocket closed: code=${e.code} reason=${e.reason}`,
        599, "ws_closed");
    }
  });
  ws.addEventListener("error", (e) => {
    closed = true;
    closeReason = new OpenAIResponsesError(
      `WebSocket error: ${(e as ErrorEvent).message ?? "unknown"}`,
      599, "ws_error");
  });

  // Send the request body (drop `stream:true`, that is implicit on WS)
  const { stream: _drop, ...bodyNoStream } = req as any;
  ws.send(JSON.stringify(sanitizeUnicode(bodyNoStream)));

  try {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (closeReason) throw closeReason;
      if (closed) return;
      await sleep(5);
      if (opts.signal?.aborted) {
        ws.close(1000, "client_abort");
        throw new OpenAIResponsesError("Aborted", 499, "aborted");
      }
    }
  } finally {
    try {
      ws.close(1000, "client_done");
    } catch {
      // ignore
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call-id map helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the response and rename every function_call `call_id` so that it
 * matches the corresponding Anthropic-style id (or vice versa).
 */
export function remapToolCallIds(
  response: OpenAIResponse,
  map: Record<string, string>,
): OpenAIResponse {
  return {
    ...response,
    output: response.output.map((item) => {
      if (item.type === "function_call" && item.call_id) {
        const mapped = mapToolCallId(item.call_id, map);
        return { ...item, call_id: mapped };
      }
      if (item.type === "function_call_output" && item.call_id) {
        const mapped = mapToolCallId(item.call_id, map);
        return { ...item, call_id: mapped };
      }
      return item;
    }),
  };
}

export { isAnthropicToolCallId };
