/**
 * Eval-kernel client — talks to the FastAPI backend's `/eval/*` endpoints.
 *
 * The eval kernel is a code-execution sandbox with tool dispatch, a small
 * structured output DSL, and per-test assertions. The CLI submits a "case"
 * (a piece of code + assertions + inputs) and the kernel returns the
 * result with per-assertion pass/fail + diffs.
 *
 * Use cases:
 *   • Verifying that a generated function satisfies a contract.
 *   • Running a small piece of code with budget + timeout + tracing.
 *   • Comparing two outputs structurally (e.g. JSON diff).
 *   • Property-based tests (random inputs).
 */
import { redactSensitive, sanitizeUnicode } from "@/utils/safe-string.js";
import { backendFetch } from "@/util/backend.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EvalLanguage = "python" | "javascript" | "typescript" | "bash" | "ruby" | "go" | "rust";

export type AssertionOp =
  | "eq" // strict equal
  | "ne"
  | "lt" | "lte" | "gt" | "gte"
  | "deep_eq" // structural deep equality
  | "contains"
  | "starts_with" | "ends_with"
  | "matches" // regex
  | "json_path" // assert JSONPath equals expected
  | "len_eq" | "len_gt" | "len_lt"
  | "is_true" | "is_false" | "is_none" | "is_not_none"
  | "throws" // expect a regex match in stderr
  | "stdout_contains"
  | "exit_eq"
  | "custom"; // pass a JS/Python expression that returns boolean

export interface Assertion {
  op: AssertionOp;
  /** Path to the value under test (e.g. "result.user.id"). */
  path?: string;
  /** Expected value. */
  expected?: unknown;
  /** Custom-expression source (used when op === "custom"). */
  expression?: string;
  /** Optional message to include on failure. */
  message?: string;
}

export interface EvalCase {
  id?: string;
  name: string;
  language: EvalLanguage;
  /** Source code to execute. */
  source: string;
  /** Standard input. */
  stdin?: string;
  /** Extra files. */
  files?: Record<string, string>;
  /** Env vars. */
  env?: Record<string, string>;
  /** Wall-clock budget (ms, default 10_000). */
  timeout_ms?: number;
  /** Memory cap (MB, default 256). */
  memory_mb?: number;
  /** CPU cap (ms, default 10_000). */
  cpu_ms?: number;
  /** Hard assertions to run on the case's result. */
  assertions?: Assertion[];
  /** A label that groups cases (e.g. "phase-1:auth"). */
  suite?: string;
  /** Extra tags. */
  tags?: string[];
}

export interface EvalAssertionResult {
  op: AssertionOp;
  path?: string;
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  message?: string;
}

export interface EvalResult {
  case_id: string;
  name: string;
  language: EvalLanguage;
  exit_code: number;
  status: "passed" | "failed" | "error" | "timeout" | "cancelled";
  duration_ms: number;
  stdout: string;
  stderr: string;
  /** The "result" the assertions are checked against (parsed from stdout, if JSON). */
  result?: unknown;
  assertions: EvalAssertionResult[];
  passed: number;
  failed: number;
  error?: { type: string; message: string; stack?: string };
  cost?: { cpu_ms: number; memory_kb: number; wall_ms: number };
  /** Coverage report (if collected). */
  coverage?: {
    lines_covered: number;
    lines_total: number;
    pct: number;
    per_file?: Record<string, { covered: number; total: number }>;
  };
}

export interface EvalSuite {
  name: string;
  cases: EvalCase[];
  /** Default timeout for each case. */
  default_timeout_ms?: number;
  /** Whether to run cases in parallel. */
  parallel?: boolean;
  /** Max parallelism. */
  max_concurrency?: number;
}

export interface EvalSuiteReport {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  duration_ms: number;
  cases: EvalResult[];
  /** Token cost (if the case used an LLM to generate code). */
  llm_cost_usd?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error
// ─────────────────────────────────────────────────────────────────────────────

export class EvalError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "eval_error") {
    super(redactSensitive(message));
    this.name = "EvalError";
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await backendFetch(path, init);
  if (res && typeof res === "object" && "error" in (res as Record<string, unknown>)) {
    const errObj = (res as { error?: string; status?: number }).error ?? "unknown";
    const status = (res as { status?: number }).status ?? 500;
    throw new EvalError(String(errObj), status);
  }
  return res as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Run a single case. */
export async function runCase(c: EvalCase): Promise<EvalResult> {
  return call<EvalResult>("/eval/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sanitizeUnicode(c)),
  });
}

/** Run a suite (batched in one request; server may parallelize). */
export async function runSuite(suite: EvalSuite): Promise<EvalSuiteReport> {
  return call<EvalSuiteReport>("/eval/run-suite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sanitizeUnicode(suite)),
  });
}

/** Run many cases (separately batched; useful for ad-hoc). */
export async function runMany(cases: EvalCase[]): Promise<EvalResult[]> {
  return call<EvalResult[]>("/eval/run-many", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sanitizeUnicode({ cases })),
  });
}

/** Cancel a running case. */
export async function cancel(caseId: string): Promise<{ cancelled: boolean }> {
  return call<{ cancelled: boolean }>(`/eval/cancel/${encodeURIComponent(caseId)}`, {
    method: "POST",
  });
}

/** Inspect a previous result by id. */
export async function get(caseId: string): Promise<EvalResult | undefined> {
  return call<EvalResult | undefined>(`/eval/result/${encodeURIComponent(caseId)}`);
}

/** Search past results by suite / tags / pass-fail. */
export async function search(
  opts: {
    suite?: string;
    tag?: string;
    status?: EvalResult["status"];
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ results: EvalResult[]; next_cursor?: string }> {
  const params = new URLSearchParams();
  if (opts.suite) params.set("suite", opts.suite);
  if (opts.tag) params.set("tag", opts.tag);
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  return call<{ results: EvalResult[]; next_cursor?: string }>(
    `/eval/results?${params.toString()}`,
  );
}

/** Compare two outputs structurally. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao).sort();
  const kb = Object.keys(bo).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual(ao[ka[i]], bo[ka[i]])) return false;
  }
  return true;
}

/** Convenience: a single-line case that just asserts `result == expected`. */
export function assertEq(
  result: unknown,
  expected: unknown,
  message?: string,
): Assertion {
  return { op: "deep_eq", expected, message };
}

/** Convenience: a single-line case that asserts no exception was raised. */
export function assertNoError(): Assertion {
  return { op: "custom", expression: "result.error === undefined" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: DSL used by the server to evaluate assertions
// ─────────────────────────────────────────────────────────────────────────────

export const __assertionOps: AssertionOp[] = [
  "eq", "ne", "lt", "lte", "gt", "gte",
  "deep_eq", "contains", "starts_with", "ends_with",
  "matches", "json_path",
  "len_eq", "len_gt", "len_lt",
  "is_true", "is_false", "is_none", "is_not_none",
  "throws", "stdout_contains", "exit_eq", "custom",
];
