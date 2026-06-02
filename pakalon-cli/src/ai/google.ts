/**
 * First-party Google Generative AI client.
 *
 * Implements the Gemini API surface used by Pakalon-CLI:
 *  - POST /v1beta/models/{model}:generateContent
 *  - POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 *  - Server-Sent Events streaming of `candidates[].content.parts[]`
 *  - Function calling: `function_declarations` + `functionCall`/`functionResponse`
 *  - Built-in tools: `googleSearch`, `codeExecution`, `urlContext`
 *  - Cached content references (`cachedContent`) and system caches
 *  - Thinking: `generationConfig.thinkingConfig` (budget, includeThoughts)
 *  - System instruction
 *  - Multimodal: text, inlineData, fileData, audio, video, pdf
 *  - Citations & grounding metadata
 *  - Safety settings
 *  - Structured output (responseSchema / responseMimeType)
 *  - AbortSignal + retries with exponential backoff on 429/5xx
 *  - Tool-call-id normalization (calls into ./tool-call-id.js)
 *  - Cache-affinity routing hint (calls into ./cache-affinity.js)
 *
 * Supports both Google AI Studio (apiKey) and Vertex AI endpoints:
 *  - Vertex: set `options.baseUrl=https://${LOCATION}-aiplatform.googleapis.com`
 *    and supply a Bearer token via `options.bearerToken` (NOT apiKey).
 *
 * Used when PAKALON_USE_GOOGLE=1 and the model id starts with `gemini-` or
 * `models/gemini-`.
 */
import { randomUUID } from "node:crypto";
import { normalizeToolCallId } from "./tool-call-id.js";
import {
  pickCacheAffinityKey,
  getCacheAffinityHint,
} from "./cache-affinity.js";
import { redactSensitive, sanitizeUnicode, isEnoent } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface GoogleInlineData {
  mimeType: string; // e.g. "image/png", "audio/mp3"
  data: string; // base64
}

export interface GoogleFileData {
  mimeType: string;
  fileUri: string; // "https://generativelanguage.googleapis.com/..."
}

export interface GoogleVideoMetadata {
  fps?: number;
  startOffset?: string; // e.g. "1.5s"
  endOffset?: string; // e.g. "10s"
}

export interface GooglePart {
  text?: string;
  inlineData?: GoogleInlineData;
  fileData?: GoogleFileData;
  videoMetadata?: GoogleVideoMetadata;
  /** Function call (model → user). */
  functionCall?: { name: string; args: Record<string, unknown> };
  /** Function response (user → model). */
  functionResponse?: { name: string; response: Record<string, unknown> };
  /** Echoed back to model for context. */
  thought?: boolean;
  thoughtSignature?: string; // opaque encrypted reasoning sig
}

export interface GoogleContent {
  role: "user" | "model" | "function" | "system" | "tool";
  parts: GooglePart[];
}

export interface GoogleFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>; // OpenAPI 3.0 schema subset
  /** When true, the function is only available in the supported model. */
  behavior?: "UNSPECIFIED" | "BLOCKING" | "NON_BLOCKING";
}

export interface GoogleTool {
  /** One or more function declarations. */
  functionDeclarations?: GoogleFunctionDeclaration[];
  /** Google Search grounding. */
  googleSearch?: Record<string, never>;
  /** Google Search Retrieval (legacy). */
  googleSearchRetrieval?: {
    dynamicRetrievalConfig?: { mode: "MODE_UNSPECIFIED" | "MODE_DYNAMIC"; dynamicThreshold?: number };
  };
  /** Code execution sandbox. */
  codeExecution?: Record<string, never>;
  /** URL context. */
  urlContext?: Record<string, never>;
  /** Cached content tool. */
  cache?: { cachedContent: string };
}

export interface GoogleToolConfig {
  functionCallingConfig?: {
    mode: "AUTO" | "ANY" | "NONE" | "VALIDATED";
    allowedFunctionNames?: string[];
  };
  retrievalConfig?: {
    latLng?: { latitude: number; longitude: number };
  };
}

export interface GoogleGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  candidateCount?: number;
  stopSequences?: string[];
  responseMimeType?: "text/plain" | "application/json" | "text/x.enum";
  responseSchema?: Record<string, unknown>;
  responseModalities?: ("TEXT" | "IMAGE" | "AUDIO")[];
  audioTimestamp?: boolean;
  seed?: number;
  /** "thinkingConfig" — server-side reasoning. */
  thinkingConfig?: {
    thinkingBudget?: number; // 0 = disabled, -1 = dynamic
    includeThoughts?: boolean;
  };
  /** Speech config. */
  speechConfig?: {
    voiceConfig?: {
      prebuiltVoiceConfig?: { voiceName: string };
    };
  };
  /** Media resolution. */
  mediaResolution?: "MEDIA_RESOLUTION_UNSPECIFIED" | "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
}

export type GoogleHarmCategory =
  | "HARM_CATEGORY_UNSPECIFIED"
  | "HARM_CATEGORY_HARASSMENT"
  | "HARM_CATEGORY_HATE_SPEECH"
  | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
  | "HARM_CATEGORY_DANGEROUS_CONTENT"
  | "HARM_CATEGORY_CIVIC_INTEGRITY";

export type GoogleHarmBlockThreshold =
  | "HARM_BLOCK_THRESHOLD_UNSPECIFIED"
  | "BLOCK_LOW_AND_ABOVE"
  | "BLOCK_MEDIUM_AND_ABOVE"
  | "BLOCK_ONLY_HIGH"
  | "BLOCK_NONE";

export interface GoogleSafetySetting {
  category: GoogleHarmCategory;
  threshold: GoogleHarmBlockThreshold;
}

export interface GoogleSystemInstruction {
  parts: GooglePart[];
}

export interface GoogleCallOptions {
  /** Google AI Studio API key. Mutually exclusive with bearerToken. */
  apiKey?: string;
  /** Vertex AI / corporate endpoint baseUrl. */
  baseUrl?: string;
  /** Bearer token (Vertex). */
  bearerToken?: string;
  /** Timeout, default 60s. */
  timeoutMs?: number;
  /** Max retries, default 4. */
  maxRetries?: number;
  signal?: AbortSignal;
  /** Override the cache-affinity key. */
  cacheKey?: string;
  extraHeaders?: Record<string, string>;
}

export interface GoogleGenerateRequest {
  /** "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro", etc. */
  model: string;
  contents: GoogleContent[];
  systemInstruction?: GoogleSystemInstruction;
  tools?: GoogleTool[];
  toolConfig?: GoogleToolConfig;
  generationConfig?: GoogleGenerationConfig;
  safetySettings?: GoogleSafetySetting[];
  /** Cached content reference. */
  cachedContent?: string;
  /** Pass-through labels. */
  labels?: Record<string, string>;
  options?: GoogleCallOptions;
  stream?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream accumulator
// ─────────────────────────────────────────────────────────────────────────────

export interface GoogleUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

export interface GoogleSafetyRating {
  category: GoogleHarmCategory;
  probability: "NEGLIGIBLE" | "LOW" | "MEDIUM" | "HIGH";
  blocked: boolean;
}

export interface GoogleCitation {
  startIndex?: number;
  endIndex?: number;
  uri?: string;
  title?: string;
  license?: string;
  publicationDate?: string;
}

export interface GoogleGroundingChunk {
  web?: { uri: string; title?: string };
  retrievedContext?: { uri: string; title?: string };
}

export interface GoogleGroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: GoogleGroundingChunk[];
  groundingSupports?: Array<{
    segment?: { startIndex?: number; endIndex?: number; text?: string };
    groundingChunkIndices?: number[];
    confidenceScores?: number[];
  }>;
  retrievalMetadata?: {
    webDynamicRetrievalScore?: number;
  };
  searchEntryPoint?: { renderedContent?: string };
}

export interface GoogleUrlContextMetadata {
  urlMetadata?: Array<{ retrievedUrl: string; urlRetrievalStatus?: string }>;
}

export type GoogleFinishReason =
  | "FINISH_REASON_UNSPECIFIED"
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "LANGUAGE"
  | "OTHER"
  | "BLOCKLIST"
  | "PROHIBITED_CONTENT"
  | "SPII"
  | "MALFORMED_FUNCTION_CALL"
  | "IMAGE_SAFETY"
  | "IMAGE_PROHIBITED_CONTENT"
  | "IMAGE_OTHER"
  | "IMAGE_RECITATION"
  | "TOO_MANY_TOOL_CALLS"
  | "MISSING_THOUGHT_SIGNATURE";

export interface GoogleCandidate {
  content: GoogleContent;
  finishReason?: GoogleFinishReason;
  index?: number;
  safetyRatings?: GoogleSafetyRating[];
  citationMetadata?: { citations?: GoogleCitation[] };
  groundingMetadata?: GoogleGroundingMetadata;
  urlContextMetadata?: GoogleUrlContextMetadata;
  /** Average logprob (only set if `responseLogprobs` requested). */
  avgLogprobs?: number;
  /** Logprobs result (only set if `responseLogprobs` requested). */
  logprobsResult?: any;
}

export interface GoogleResponse {
  candidates: GoogleCandidate[];
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: GoogleSafetyRating[];
  };
  usageMetadata: GoogleUsage;
  modelVersion?: string;
  createTime?: string;
  responseId?: string;
}

export interface GoogleStreamEvent {
  type:
    | "text"
    | "thought"
    | "function_call"
    | "function_response"
    | "inline_data"
    | "citation"
    | "grounding"
    | "url_context"
    | "usage"
    | "finish"
    | "safety"
    | "error"
    | "ping"
    | "completed";
  /** text/thought delta. */
  text?: string;
  /** function call (model → user). */
  functionCall?: { name: string; args: Record<string, unknown> };
  /** citation metadata. */
  citation?: GoogleCitation;
  /** grounding metadata. */
  grounding?: GoogleGroundingMetadata;
  /** url context metadata. */
  urlContext?: GoogleUrlContextMetadata;
  /** usage update. */
  usage?: GoogleUsage;
  /** finish reason (last event per candidate). */
  finishReason?: GoogleFinishReason;
  /** candidate index. */
  candidateIndex?: number;
  /** safety rating. */
  safety?: GoogleSafetyRating;
  /** error. */
  error?: { code: string; message: string };
  /** full response on completion. */
  response?: GoogleResponse;
}

export interface GoogleResponseAccumulator {
  response: Partial<GoogleResponse> & { candidates: GoogleCandidate[] };
  outputText: string;
  reasoningText: string;
  /** Per-candidate function-call accumulator. */
  functionCalls: Map<string, { name: string; args: string }>;
  lastEventAt: number;
  errors: Array<{ code: string; message: string }>;
}

export function createAccumulator(): GoogleResponseAccumulator {
  return {
    response: { candidates: [] },
    outputText: "",
    reasoningText: "",
    functionCalls: new Map(),
    lastEventAt: Date.now(),
    errors: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Error class
// ─────────────────────────────────────────────────────────────────────────────

export class GoogleGenerativeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "google_ai_error") {
    super(redactSensitive(message));
    this.name = "GoogleGenerativeError";
    this.status = status;
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 750;
const RETRY_MAX_DELAY_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  const exp = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 ||
    status === 429 || (status >= 500 && status < 600);
}

export function isGoogleModelId(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    m.startsWith("gemini-") ||
    m.startsWith("models/gemini-") ||
    m.startsWith("google/")
  );
}

function safeJSONParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Stable id for streamed function calls (since Gemini's wire doesn't include one). */
function functionCallId(name: string, index: number): string {
  return normalizeToolCallId(`gcall_${name}_${index}_${randomUUID().slice(0, 8)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE parser
// ─────────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
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
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "" || line === "\r") {
          if (dataBuf.length) {
            yield { event: eventName, data: dataBuf.join("\n") };
            dataBuf = [];
            eventName = "message";
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let valuePart = colon === -1 ? "" : line.slice(colon + 1);
        if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
        if (field === "event") eventName = valuePart;
        else if (field === "data") dataBuf.push(valuePart);
      }
    }
    if (dataBuf.length) yield { event: eventName, data: dataBuf.join("\n") };
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
  accumulator: GoogleResponseAccumulator,
  signal?: AbortSignal,
): AsyncGenerator<GoogleStreamEvent> {
  let candidateIndex = 0;
  for await (const ev of parseSSEStream(body, signal)) {
    if (ev.event === "ping") {
      yield { type: "ping" };
      continue;
    }
    const parsed = safeJSONParse<any>(ev.data);
    if (!parsed) continue;
    accumulator.lastEventAt = Date.now();

    // Each SSE event is a partial response.
    if (parsed.error) {
      accumulator.errors.push(parsed.error);
      yield {
        type: "error",
        error: parsed.error,
      };
      continue;
    }

    // Update accumulator
    if (parsed.modelVersion) accumulator.response.modelVersion = parsed.modelVersion;
    if (parsed.responseId) accumulator.response.responseId = parsed.responseId;
    if (parsed.createTime) accumulator.response.createTime = parsed.createTime;

    if (parsed.candidates) {
      for (const cand of parsed.candidates) {
        const idx = cand.index ?? 0;
        let target = accumulator.response.candidates.find(
          (c) => (c.index ?? 0) === idx,
        );
        if (!target) {
          target = {
            content: { role: "model", parts: [] },
            index: idx,
            safetyRatings: [],
          };
          accumulator.response.candidates.push(target);
        }
        // Append new parts
        if (cand.content?.parts) {
          for (const part of cand.content.parts) {
            target.content.parts.push(part);
            if (typeof part.text === "string") {
              if (part.thought) {
                accumulator.reasoningText += part.text;
                yield {
                  type: "thought",
                  text: part.text,
                  candidateIndex: idx,
                };
              } else {
                accumulator.outputText += part.text;
                yield {
                  type: "text",
                  text: part.text,
                  candidateIndex: idx,
                };
              }
            } else if (part.functionCall) {
              const id = functionCallId(part.functionCall.name, idx);
              const prev = accumulator.functionCalls.get(id) ?? {
                name: part.functionCall.name,
                args: "",
              };
              prev.name = part.functionCall.name;
              prev.args = prev.args + JSON.stringify(part.functionCall.args ?? {});
              accumulator.functionCalls.set(id, prev);
              yield {
                type: "function_call",
                functionCall: part.functionCall,
                candidateIndex: idx,
              };
            } else if (part.functionResponse) {
              yield {
                type: "function_response",
                functionCall: { name: part.functionResponse.name, args: part.functionResponse.response },
                candidateIndex: idx,
              };
            } else if (part.inlineData) {
              yield {
                type: "inline_data",
                candidateIndex: idx,
              };
            }
            if (part.thoughtSignature) {
              // Captured in target.content.parts already
            }
          }
        }
        if (cand.finishReason) {
          target.finishReason = cand.finishReason;
          yield {
            type: "finish",
            finishReason: cand.finishReason,
            candidateIndex: idx,
          };
        }
        if (cand.safetyRatings) {
          target.safetyRatings = cand.safetyRatings;
          for (const r of cand.safetyRatings) {
            yield { type: "safety", safety: r, candidateIndex: idx };
          }
        }
        if (cand.citationMetadata?.citations) {
          target.citationMetadata = cand.citationMetadata;
          for (const cit of cand.citationMetadata.citations) {
            yield { type: "citation", citation: cit, candidateIndex: idx };
          }
        }
        if (cand.groundingMetadata) {
          target.groundingMetadata = cand.groundingMetadata;
          yield {
            type: "grounding",
            grounding: cand.groundingMetadata,
            candidateIndex: idx,
          };
        }
        if (cand.urlContextMetadata) {
          target.urlContextMetadata = cand.urlContextMetadata;
          yield {
            type: "url_context",
            urlContext: cand.urlContextMetadata,
            candidateIndex: idx,
          };
        }
      }
    }
    if (parsed.usageMetadata) {
      accumulator.response.usageMetadata = {
        promptTokenCount: parsed.usageMetadata.promptTokenCount ?? 0,
        candidatesTokenCount: parsed.usageMetadata.candidatesTokenCount ?? 0,
        totalTokenCount: parsed.usageMetadata.totalTokenCount ?? 0,
        cachedContentTokenCount: parsed.usageMetadata.cachedContentTokenCount,
        thoughtsTokenCount: parsed.usageMetadata.thoughtsTokenCount,
        toolUsePromptTokenCount: parsed.usageMetadata.toolUsePromptTokenCount,
      };
      yield { type: "usage", usage: accumulator.response.usageMetadata };
    }
    if (parsed.promptFeedback) {
      accumulator.response.promptFeedback = parsed.promptFeedback;
    }
  }

  // Final response object
  const finalResponse: GoogleResponse = {
    candidates: accumulator.response.candidates,
    usageMetadata: accumulator.response.usageMetadata ?? {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    },
    promptFeedback: accumulator.response.promptFeedback,
    modelVersion: accumulator.response.modelVersion,
    createTime: accumulator.response.createTime,
    responseId: accumulator.response.responseId,
  };
  accumulator.response = finalResponse;
  yield { type: "completed", response: finalResponse };
  candidateIndex = (candidateIndex + 1) >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function* streamGoogleGenerate(
  req: GoogleGenerateRequest,
): AsyncGenerator<GoogleStreamEvent> {
  const opts = req.options ?? {};
  const apiKey = opts.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!opts.bearerToken && !apiKey) {
    throw new GoogleGenerativeError(
      "GOOGLE_API_KEY (or `options.bearerToken` for Vertex) is not set.",
      401,
      "missing_api_key",
    );
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  const { stream: _drop, ...bodyNoStream } = req as any;
  const body: any = bodyNoStream;
  // Drop the `stream` and `options` fields from the request body
  delete body.stream;
  delete body.options;
  // Drop the empty model field if `models/` is not in the URL
  if (body.model && body.model.startsWith("models/")) {
    body.model = body.model.slice("models/".length);
  }

  // Build URL
  const modelName = body.model;
  delete body.model;
  const action = req.stream === false ? "generateContent" : "streamGenerateContent";
  const url =
    `${baseUrl}/v1beta/models/${encodeURIComponent(modelName)}:${action}` +
    (action === "streamGenerateContent" ? "?alt=sse" : "");
  void _drop;

  // Headers
  const cacheKey = opts.cacheKey ?? pickCacheAffinityKey();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: action === "streamGenerateContent" ? "text/event-stream" : "application/json",
    "x-pakalon-cache-affinity": cacheKey,
    "x-pakalon-tool-call-id-version": "v1",
  };
  if (opts.bearerToken) {
    headers.authorization = `Bearer ${opts.bearerToken}`;
  } else if (apiKey) {
    // Both query-string (legacy) and header (newer) auth supported
    headers["x-goog-api-key"] = apiKey;
  }
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new GoogleGenerativeError("Request aborted", 499, "aborted");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(sanitizeUnicode(body)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        if (isRetryableStatus(res.status) && attempt < maxRetries) {
          lastError = new GoogleGenerativeError(
            `Google ${res.status}: ${errText.slice(0, 500)}`,
            res.status,
            "http_error",
          );
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new GoogleGenerativeError(
          `Google ${res.status}: ${errText.slice(0, 500)}`,
          res.status,
          "http_error",
        );
      }
      if (action === "generateContent") {
        // Non-streaming: parse the single response and emit completion
        const json = (await res.json()) as GoogleResponse;
        const acc = createAccumulator();
        acc.response = {
          candidates: json.candidates ?? [],
          usageMetadata: json.usageMetadata ?? {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0,
          },
          promptFeedback: json.promptFeedback,
          modelVersion: json.modelVersion,
          createTime: json.createTime,
          responseId: json.responseId,
        };
        for (const cand of acc.response.candidates) {
          for (const part of cand.content.parts) {
            if (typeof part.text === "string") {
              if (part.thought) {
                acc.reasoningText += part.text;
                yield {
                  type: "thought",
                  text: part.text,
                  candidateIndex: cand.index ?? 0,
                };
              } else {
                acc.outputText += part.text;
                yield {
                  type: "text",
                  text: part.text,
                  candidateIndex: cand.index ?? 0,
                };
              }
            } else if (part.functionCall) {
              yield {
                type: "function_call",
                functionCall: part.functionCall,
                candidateIndex: cand.index ?? 0,
              };
            }
          }
          if (cand.finishReason) {
            yield {
              type: "finish",
              finishReason: cand.finishReason,
              candidateIndex: cand.index ?? 0,
            };
          }
          if (cand.citationMetadata?.citations) {
            for (const cit of cand.citationMetadata.citations) {
              yield {
                type: "citation",
                citation: cit,
                candidateIndex: cand.index ?? 0,
              };
            }
          }
          if (cand.groundingMetadata) {
            yield {
              type: "grounding",
              grounding: cand.groundingMetadata,
              candidateIndex: cand.index ?? 0,
            };
          }
        }
        if (acc.response.usageMetadata) {
          yield { type: "usage", usage: acc.response.usageMetadata };
        }
        yield { type: "completed", response: json };
        return;
      }
      if (!res.body) {
        throw new GoogleGenerativeError(
          "Google returned an empty body",
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
      if (e instanceof GoogleGenerativeError) {
        if (
          isRetryableStatus(e.status) &&
          attempt < maxRetries
        ) {
          lastError = e;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw e;
      }
      if (isEnoent(e as Error)) {
        throw new GoogleGenerativeError(
          `Local file not found: ${(e as NodeJS.ErrnoException).path ?? ""}`,
          424,
          "missing_file",
        );
      }
      if ((e as Error).name === "AbortError") {
        throw new GoogleGenerativeError(
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
      throw new GoogleGenerativeError(
        (e as Error)?.message ?? "Unknown error",
        599,
        "network_error",
      );
    } finally {
      clearTimeout(timeout);
      if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new GoogleGenerativeError("Max retries exhausted", 599, "max_retries");
}

/** Non-streaming: collect all deltas, return the final response. */
export async function generateGoogle(
  req: GoogleGenerateRequest,
): Promise<GoogleResponse> {
  const nonStream = { ...req, stream: false };
  let last: GoogleResponse | undefined;
  for await (const ev of streamGoogleGenerate(nonStream)) {
    if (ev.type === "completed" && ev.response) last = ev.response;
  }
  if (!last) {
    throw new GoogleGenerativeError(
      "Response did not complete",
      500,
      "incomplete",
    );
  }
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vertex AI helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Vertex AI endpoint URL.
 *   https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/publishers/google/models/{MODEL}:generateContent
 */
export function buildVertexUrl(opts: {
  baseUrl: string;
  project: string;
  location: string;
  model: string;
  stream: boolean;
}): string {
  const action = opts.stream ? "streamGenerateContent" : "generateContent";
  return (
    `${opts.baseUrl}/v1/projects/${encodeURIComponent(opts.project)}` +
    `/locations/${encodeURIComponent(opts.location)}` +
    `/publishers/google/models/${encodeURIComponent(opts.model)}` +
    `:${action}` + (opts.stream ? "?alt=sse" : "")
  );
}

/** Drop the `models/` prefix that callers may include. */
export function normalizeModelId(model: string): string {
  if (model.startsWith("models/")) return model.slice("models/".length);
  if (model.startsWith("google/")) return model.slice("google/".length);
  return model;
}

/** Convenience to use the cache-affinity hint. */
export { getCacheAffinityHint, pickCacheAffinityKey };
