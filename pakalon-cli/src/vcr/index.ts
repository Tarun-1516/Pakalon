/**
 * vcr/index.ts — record/replay HTTP interactions for hermetic tests, demos,
 * and offline mode.
 *
 * The shape mirrors vcr.js / polly-js: each "cassette" is a JSON file of
 * recorded request/response pairs. We install a global `fetch` patch that
 * consults the active mode (off | record | replay) and either forwards to
 * the real network, captures the result, or serves a recorded response.
 *
 * Default cassette directory: `~/.config/pakalon/vcr/`.
 */
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VcrMode = "off" | "record" | "replay" | "fallback" | "strict";

export interface VcrInstallOpts {
  mode: VcrMode;
  /** Cassette name. Required for record/replay. */
  name?: string;
  /** Override the cassette directory. */
  dir?: string;
  /** Headers to include in the match key. Default: none. */
  matchHeaders?: string[];
  /** "exact" | "ignore" | "if-match-any:<id1,id2>" — default "ignore". */
  matchBody?: "exact" | "ignore" | string;
  /** Optional matcher for the URL (regex string). */
  matchUrl?: string;
  /** When true, every cassette record also runs the real call (sanity check). */
  sanitizeCheck?: boolean;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string; // base64 if binary
  bodyEncoding?: "utf8" | "base64";
  startedAt: number;
}

export interface RecordedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "utf8" | "base64";
  durationMs: number;
  /** True if the response was synthesized by VCR (e.g. test stub). */
  synthetic?: boolean;
}

export interface CassetteEntry {
  id: string;
  description?: string;
  request: RecordedRequest;
  response: RecordedResponse;
  recordedAt: number;
}

export interface Cassette {
  version: 1;
  name: string;
  recordedAt: number;
  updatedAt: number;
  requestCount: number;
  imports: string[]; // referenced cassettes
  entries: CassetteEntry[];
}

export type VcrError =
  | { kind: "miss"; url: string; method: string }
  | { kind: "io"; message: string }
  | { kind: "mode"; message: string };

export type VcrResult<T> = { ok: true; value: T } | { ok: false; error: VcrError };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  mode: VcrMode;
  name: string;
  dir: string;
  matchHeaders: string[];
  matchBody: string;
  matchUrl: string | null;
  /** Cassette currently being recorded. */
  activeRecord: Cassette | null;
  /** Cassette currently being replayed (key → entry). */
  activeReplay: Map<string, CassetteEntry> | null;
  /** Original fetch + Response + Request, for restoration on uninstall. */
  pristine: { fetch: typeof globalThis.fetch; Response: typeof Response; Request: typeof Request } | null;
  /** Id of the in-progress record() (so stop() can flush). */
  inflight: Set<string>;
}

let STATE: State | null = null;

// ---------------------------------------------------------------------------
// Cassette I/O
// ---------------------------------------------------------------------------

function defaultDir(): string {
  const base = process.env["PAKALON_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "pakalon");
  return path.join(base, "vcr");
}

export function cassettePath(name: string, dir = STATE?.dir ?? defaultDir()): string {
  return path.join(dir, `${name}.json`);
}

export function listCassettes(dir = STATE?.dir ?? defaultDir()): string[] {
  try {
    if (!fsSync.existsSync(dir)) return [];
    return fsSync
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".imports.json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

export async function loadCassette(name: string, dir = STATE?.dir ?? defaultDir()): Promise<Cassette | null> {
  try {
    const raw = await fs.readFile(cassettePath(name, dir), "utf-8");
    return JSON.parse(raw) as Cassette;
  } catch {
    return null;
  }
}

export async function saveCassette(c: Cassette, dir = STATE?.dir ?? defaultDir()): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(cassettePath(c.name, dir), JSON.stringify(c, null, 2), "utf-8");
}

export async function deleteCassette(name: string, dir = STATE?.dir ?? defaultDir()): Promise<boolean> {
  try {
    await fs.unlink(cassettePath(name, dir));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function makeKey(req: { method: string; url: string; headers: Record<string, string>; body?: string }): string {
  const m = req.method.toUpperCase();
  const u = STATE?.matchUrl ? req.url.match(new RegExp(STATE.matchUrl))?.[0] ?? req.url : req.url;
  const h = STATE?.matchHeaders ?? [];
  const sortedHeaders = [...Object.entries(req.headers)]
    .filter(([k]) => h.includes(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  let bodyPart = "";
  const mb = STATE?.matchBody ?? "ignore";
  if (mb === "exact") bodyPart = req.body ?? "";
  else if (mb.startsWith("if-match-any:")) {
    const allowed = mb.slice("if-match-any:".length).split(",");
    bodyPart = allowed.includes(req.body ?? "") ? (req.body ?? "") : "<other>";
  }
  return [m, u, sortedHeaders, bodyPart].join("\n");
}

function findEntry(replay: Map<string, CassetteEntry>, key: string, method: string, url: string): CassetteEntry | undefined {
  const exact = replay.get(key);
  if (exact) return exact;
  // Fallback: scan for method+url match.
  for (const e of replay.values()) {
    if (e.request.method === method && e.request.url === url) return e;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function encodeBody(body: BodyInit | null | undefined): { value: string; encoding: "utf8" | "base64" } {
  if (body == null) return { value: "", encoding: "utf8" };
  if (typeof body === "string") return { value: body, encoding: "utf8" };
  if (body instanceof URLSearchParams) return { value: body.toString(), encoding: "utf8" };
  if (body instanceof FormData) {
    const obj: Record<string, string> = {};
    body.forEach((v, k) => { obj[k] = typeof v === "string" ? v : "[binary]"; });
    return { value: JSON.stringify(obj), encoding: "utf8" };
  }
  if (body instanceof ArrayBuffer) {
    return { value: Buffer.from(body).toString("base64"), encoding: "base64" };
  }
  if (ArrayBuffer.isView(body)) {
    return { value: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64"), encoding: "base64" };
  }
  if (body instanceof Blob) {
    return { value: "[blob]", encoding: "utf8" };
  }
  if (body instanceof ReadableStream) {
    return { value: "[stream]", encoding: "utf8" };
  }
  return { value: String(body), encoding: "utf8" };
}

function decodeBody(value: string, encoding: "utf8" | "base64"): Uint8Array {
  if (!value) return new Uint8Array(0);
  if (encoding === "base64") return Uint8Array.from(Buffer.from(value, "base64"));
  return new TextEncoder().encode(value);
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function objectToHeaders(h: Record<string, string>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) out.set(k, v);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install the VCR `fetch` patch. Idempotent — calling again with different
 * options replaces the active mode.
 */
export function installVcr(opts: VcrInstallOpts): void {
  uninstallVcr();
  STATE = {
    mode: opts.mode,
    name: opts.name ?? "",
    dir: opts.dir ?? defaultDir(),
    matchHeaders: (opts.matchHeaders ?? []).map((s) => s.toLowerCase()),
    matchBody: opts.matchBody ?? "ignore",
    matchUrl: opts.matchUrl ?? null,
    activeRecord: null,
    activeReplay: null,
    pristine: {
      fetch: globalThis.fetch,
      Response: globalThis.Response,
      Request: globalThis.Request,
    },
    inflight: new Set(),
  };

  if (opts.mode === "replay" || opts.mode === "strict" || opts.mode === "fallback") {
    void (async () => {
      const c = await loadCassette(opts.name!, STATE!.dir);
      if (!c) {
        if (opts.mode === "replay" || opts.mode === "strict") {
          throw new Error(`vcr: cassette not found: ${opts.name}`);
        }
        STATE!.activeReplay = new Map();
        return;
      }
      const m = new Map<string, CassetteEntry>();
      for (const e of c.entries) {
        const k = makeKey({ method: e.request.method, url: e.request.url, headers: e.request.headers, body: e.request.body });
        if (!m.has(k)) m.set(k, e);
      }
      STATE!.activeReplay = m;
    })();
  }

  // Patch fetch
  const patched: typeof globalThis.fetch = async function vcrFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!STATE || STATE.mode === "off") {
      return STATE!.pristine!.fetch(input as RequestInfo, init);
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    // Skip non-http(s) schemes (file://, node:, data:, blob:, etc.)
    if (!/^https?:/i.test(url)) {
      return STATE.pristine!.fetch(input as RequestInfo, init);
    }

    const headers = {
      ...(input instanceof Request ? headersToObject(input.headers) : {}),
      ...(init?.headers ? headersToObject(init.headers) : {}),
    };
    const body = init?.body ?? (input instanceof Request ? input.body : undefined);
    const encoded = encodeBody(body as BodyInit | null | undefined);
    const key = makeKey({ method, url, headers, body: encoded.encoding === "utf8" ? encoded.value : undefined });

    // ── REPLAY ─────────────────────────────────────────────────────────
    if (STATE.mode === "replay" || STATE.mode === "strict" || STATE.mode === "fallback") {
      // Wait for the cassette to load if still loading.
      while (STATE.activeReplay === null) await new Promise((r) => setTimeout(r, 1));
      const entry = findEntry(STATE.activeReplay, key, method, url);
      if (entry) {
        const bodyBytes = decodeBody(entry.response.body, entry.response.bodyEncoding);
        return new Response(bodyBytes, {
          status: entry.response.status,
          statusText: entry.response.statusText,
          headers: objectToHeaders(entry.response.headers),
        });
      }
      if (STATE.mode === "strict") {
        throw new Error(`vcr strict: no recorded response for ${method} ${url}`);
      }
      // fallback: continue to real fetch and (if also recording) capture.
    }

    // ── REAL (with optional recording) ────────────────────────────────
    const startedAt = Date.now();
    const res = await STATE.pristine!.fetch(input as RequestInfo, init);
    const durationMs = Date.now() - startedAt;
    if (STATE.mode === "record" || STATE.mode === "fallback") {
      try {
        const resClone = res.clone();
        const buf = new Uint8Array(await resClone.arrayBuffer());
        const enc = looksBinary(headers) ? "base64" : "utf8";
        const bodyOut = enc === "base64" ? Buffer.from(buf).toString("base64") : new TextDecoder("utf-8").decode(buf);
        if (!STATE.activeRecord) {
          STATE.activeRecord = {
            version: 1,
            name: STATE.name || "unnamed",
            recordedAt: Date.now(),
            updatedAt: Date.now(),
            requestCount: 0,
            imports: [],
            entries: [],
          };
        }
        const entry: CassetteEntry = {
          id: randomUUID(),
          request: { method, url, headers, body: encoded.value, bodyEncoding: encoded.encoding, startedAt },
          response: {
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(res.headers.entries()),
            body: bodyOut,
            bodyEncoding: enc,
            durationMs,
          },
          recordedAt: Date.now(),
        };
        STATE.activeRecord.entries.push(entry);
        STATE.activeRecord.requestCount = STATE.activeRecord.entries.length;
        STATE.activeRecord.updatedAt = Date.now();
      } catch {
        // Best-effort: don't break the call if recording fails.
      }
    }
    return res;
  } as typeof globalThis.fetch;

  globalThis.fetch = patched;
}

export function uninstallVcr(): void {
  if (STATE?.pristine) {
    try { globalThis.fetch = STATE.pristine.fetch; } catch { /* noop */ }
  }
  STATE = null;
}

/** Run `fn` while recording to cassette `name`. Returns a context with `.stop()`. */
export function record(name: string, fn: () => Promise<unknown>): VcrRecordContext {
  if (!STATE) {
    installVcr({ mode: "record", name });
  } else {
    STATE.mode = "record";
    STATE.name = name;
  }
  if (STATE) STATE.activeRecord = {
    version: 1,
    name,
    recordedAt: Date.now(),
    updatedAt: Date.now(),
    requestCount: 0,
    imports: [],
    entries: [],
  };
  const id = randomUUID();
  if (STATE) STATE.inflight.add(id);
  const ctx: VcrRecordContext = {
    name,
    async stop() {
      if (STATE && STATE.activeRecord) {
        await saveCassette(STATE.activeRecord, STATE.dir);
        STATE.activeRecord = null;
      }
      STATE?.inflight.delete(id);
    },
  };
  return ctx;
}

export interface VcrRecordContext {
  name: string;
  stop(): Promise<void>;
}

/** Convenience: run `fn` while replaying cassette `name`. */
export async function replay<T>(name: string, fn: () => Promise<T>, opts: { mode?: "replay" | "fallback" | "strict"; dir?: string } = {}): Promise<T> {
  installVcr({ mode: opts.mode ?? "replay", name, dir: opts.dir });
  try {
    return await fn();
  } finally {
    uninstallVcr();
  }
}

/** Reject every non-replayed network call. Throws. */
export function disableNetwork(): void {
  installVcr({ mode: "strict", name: "_disabled" });
  // When no cassette is loaded, the loader will throw — catch eagerly:
  // actually, we set activeReplay = empty map so any call goes through
  // strict-miss.
  if (STATE) {
    STATE.activeReplay = new Map();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function looksBinary(headers: Record<string, string>): boolean {
  const ct = headers["content-type"] ?? "";
  return /^(image|audio|video|application\/octet-stream|application\/pdf|font\/)/i.test(ct);
}
