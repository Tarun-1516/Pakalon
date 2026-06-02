/**
 * /review subagent — runs the structured code review flow.
 *
 * The /review subagent:
 *   1. Computes the diff (default: working tree vs HEAD, optionally vs main).
 *   2. Loads the `review.md` prompt template.
 *   3. Streams the review to a chosen model.
 *   4. Parses the model output into a structured `ReviewVerdict`.
 *   5. Persists the verdict to `.pakalon/reviews/<sha>.md`.
 *
 * Public surface:
 *   - `ReviewAgent` class — main entry point.
 *   - `runReview(opts)` — convenience wrapper.
 *   - `parseVerdict(markdown)` — parser for the structured output.
 */
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { renderPrompt } from "@/prompts/loader.js";
import { redactSensitive, sanitizeUnicode } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewVerdictLabel = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type ReviewPriority = "P0" | "P1" | "P2" | "P3";

export interface ReviewFinding {
  priority: ReviewPriority;
  /** "src/foo.ts:42" */
  location?: string;
  /** The file the finding is about. */
  file?: string;
  /** The line number (parsed from `location` if present). */
  line?: number;
  /** Short description. */
  description: string;
}

export interface ReviewTestCoverage {
  covered: string[];
  uncovered: string[];
}

export interface ReviewRisks {
  deployment?: string[];
  rollback?: string[];
  monitoring?: string[];
}

export interface ReviewVerdict {
  label: ReviewVerdictLabel;
  summary: string;
  findings: ReviewFinding[];
  test_coverage?: ReviewTestCoverage;
  risks?: ReviewRisks;
  /** Raw markdown the model produced. */
  raw: string;
}

export interface ReviewOptions {
  repoRoot: string;
  /** The base ref to diff against (default: HEAD). */
  baseRef?: string;
  /** The head ref to diff against (default: working tree). */
  headRef?: string;
  /** Override the model id (default: read from `PAKALON_REVIEW_MODEL` or fall back to `anthropic/claude-sonnet-4-5`). */
  model?: string;
  /** Limit the diff size. */
  maxDiffBytes?: number;
  /** Override the prompt name (default: "review"). */
  promptName?: string;
  /** Custom vars for the prompt. */
  promptVars?: Record<string, unknown>;
  /** Custom model-call function (defaults to AnthropicMessages). */
  callModel?: (opts: { model: string; system: string; user: string; maxTokens?: number }) => Promise<string>;
  /** Where to persist the verdict. Default: `.pakalon/reviews/<sha>.md`. */
  persistDir?: string;
  /** Per-finding message when verdict is REQUEST_CHANGES. */
  failOnPriority?: ReviewPriority;
}

export interface ReviewFileStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface ReviewDiffResult {
  /** The unified diff (may be truncated). */
  diff: string;
  /** Per-file stats. */
  changedFiles: ReviewFileStat[];
  /** Whether the diff was truncated. */
  truncated: boolean;
  /** Total bytes of the un-truncated diff. */
  totalBytes: number;
  /** Base / head refs. */
  baseRef: string;
  headRef: string;
}

export class ReviewError extends Error {
  readonly code: string;
  constructor(message: string, code = "review_error") {
    super(redactSensitive(message));
    this.name = "ReviewError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff computation
// ─────────────────────────────────────────────────────────────────────────────

function runGit(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;
    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        killed = true;
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, options.timeoutMs);
    }
    proc.stdout.on("data", (c) => {
      if (options.maxBytes) {
        let remaining = options.maxBytes;
        for (const ch of stdoutChunks) remaining -= ch.length;
        if (remaining > 0) {
          const slice = c.length > remaining ? c.slice(0, remaining) : c;
          stdoutChunks.push(slice);
        }
      } else {
        stdoutChunks.push(c);
      }
    });
    proc.stderr.on("data", (c) => stderrChunks.push(c));
    proc.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        status: code ?? (killed ? 124 : 0),
      });
    });
  });
}

export async function computeDiff(opts: {
  repoRoot: string;
  baseRef?: string;
  headRef?: string;
  maxDiffBytes?: number;
}): Promise<ReviewDiffResult> {
  const baseRef = opts.baseRef ?? "HEAD";
  const headRef = opts.headRef ?? ""; // empty = working tree
  const maxBytes = opts.maxDiffBytes ?? 256_000;

  // First, get the file stats (cheap).
  const statArgs = ["diff", "--numstat", ...(headRef ? [headRef, baseRef] : [baseRef])];
  const statRes = await runGit(statArgs, opts.repoRoot, { timeoutMs: 10_000 });
  if (statRes.status !== 0) {
    throw new ReviewError(
      `git diff --numstat failed: ${statRes.stderr || statRes.stdout}`,
      "diff_failed",
    );
  }
  const changedFiles: ReviewFileStat[] = statRes.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [addStr, delStr, ...rest] = line.split(/\s+/);
      const path = rest.join(" ");
      return {
        path,
        additions: addStr === "-" ? 0 : parseInt(addStr, 10) || 0,
        deletions: delStr === "-" ? 0 : parseInt(delStr, 10) || 0,
      };
    });

  // Then the actual diff.
  const diffArgs = ["diff", ...(headRef ? [headRef, baseRef] : [baseRef])];
  const diffRes = await runGit(diffArgs, opts.repoRoot, {
    timeoutMs: 30_000,
    maxBytes,
  });
  const truncated = diffRes.stdout.length >= maxBytes;
  // Probe total bytes if truncated
  let totalBytes = diffRes.stdout.length;
  if (truncated) {
    const probe = await runGit(diffArgs, opts.repoRoot, { timeoutMs: 30_000 });
    totalBytes = probe.stdout.length;
  }
  return {
    diff: diffRes.stdout,
    changedFiles,
    truncated,
    totalBytes,
    baseRef,
    headRef,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict parser
// ─────────────────────────────────────────────────────────────────────────────

const HEADING_RE = /^#+\s+(.*)$/;
const VERDICT_RE = /\*\*Verdict:\*\*\s*(APPROVE|REQUEST_CHANGES|COMMENT)/i;
const PRIORITY_RE = /^(P[0-3])\b/;
const LOCATION_RE = /\[?`?([\w./\-_]+\.\w+):?(\d+)?`?\]?/;

export function parseVerdict(markdown: string): ReviewVerdict {
  const lines = markdown.split(/\r?\n/);
  let label: ReviewVerdictLabel = "COMMENT";
  let summary = "";
  const findings: ReviewFinding[] = [];
  let section: "summary" | "p0" | "p1" | "p2" | "p3" | "tests" | "risks" | "other" = "other";
  const testCovered: string[] = [];
  const testUncovered: string[] = [];
  const risks: ReviewRisks = { deployment: [], rollback: [], monitoring: [] };

  for (const raw of lines) {
    const line = raw.trim();
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const title = heading[1].toLowerCase();
      const verdictMatch = VERDICT_RE.exec(heading[1]);
      if (verdictMatch) {
        label = verdictMatch[1].toUpperCase() as ReviewVerdictLabel;
        continue;
      }
      if (title.includes("p0") || title.includes("must fix")) section = "p0";
      else if (title.includes("p1") || title.includes("should fix")) section = "p1";
      else if (title.includes("p2") || title.includes("nit")) section = "p2";
      else if (title.includes("p3") || title.includes("optional")) section = "p3";
      else if (title.includes("test") || title.includes("coverage")) section = "tests";
      else if (title.includes("risk")) section = "risks";
      else if (title.includes("summary")) section = "summary";
      else section = "other";
      continue;
    }
    if (section === "summary" && line && !summary) {
      summary = line;
      continue;
    }
    if (
      (section === "p0" || section === "p1" || section === "p2" || section === "p3") &&
      line.startsWith("-")
    ) {
      const prio = section.toUpperCase() as ReviewPriority;
      const m = LOCATION_RE.exec(line);
      const finding: ReviewFinding = {
        priority: prio,
        description: line.replace(/^-\s+/, "").trim(),
      };
      if (m) {
        finding.file = m[1];
        if (m[2]) finding.line = parseInt(m[2], 10);
        finding.location = m[2] ? `${m[1]}:${m[2]}` : m[1];
      }
      findings.push(finding);
      continue;
    }
    if (section === "tests" && line.startsWith("-")) {
      if (line.toLowerCase().includes("uncovered") || line.toLowerCase().includes("not tested")) {
        testUncovered.push(line.replace(/^-\s+/, ""));
      } else {
        testCovered.push(line.replace(/^-\s+/, ""));
      }
      continue;
    }
    if (section === "risks" && line.startsWith("-")) {
      const lower = line.toLowerCase();
      if (lower.includes("deploy") || lower.includes("release")) {
        risks.deployment = [...(risks.deployment ?? []), line.replace(/^-\s+/, "")];
      } else if (lower.includes("rollback") || lower.includes("revert")) {
        risks.rollback = [...(risks.rollback ?? []), line.replace(/^-\s+/, "")];
      } else if (lower.includes("monitor") || lower.includes("alert")) {
        risks.monitoring = [...(risks.monitoring ?? []), line.replace(/^-\s+/, "")];
      }
      continue;
    }
  }
  return {
    label,
    summary,
    findings,
    test_coverage:
      testCovered.length || testUncovered.length
        ? { covered: testCovered, uncovered: testUncovered }
        : undefined,
    risks: risks.deployment || risks.rollback || risks.monitoring ? risks : undefined,
    raw: markdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict → markdown
// ─────────────────────────────────────────────────────────────────────────────

export function renderVerdict(v: ReviewVerdict): string {
  const lines: string[] = [];
  lines.push(`# Review Verdict: ${v.label}`);
  lines.push("");
  if (v.summary) {
    lines.push("## Summary");
    lines.push(v.summary);
    lines.push("");
  }
  for (const prio of ["P0", "P1", "P2", "P3"] as ReviewPriority[]) {
    const list = v.findings.filter((f) => f.priority === prio);
    if (!list.length) continue;
    const heading =
      prio === "P0" ? "P0 — Must fix" :
      prio === "P1" ? "P1 — Should fix" :
      prio === "P2" ? "P2 — Nit" :
      "P3 — Optional";
    lines.push(`## ${heading}`);
    for (const f of list) {
      const loc = f.location ? `[${f.location}] ` : "";
      lines.push(`- ${loc}${f.description}`);
    }
    lines.push("");
  }
  if (v.test_coverage) {
    lines.push("## Test coverage");
    if (v.test_coverage.covered.length) {
      lines.push("Covered:");
      for (const c of v.test_coverage.covered) lines.push(`- ${c}`);
    }
    if (v.test_coverage.uncovered.length) {
      lines.push("Not covered:");
      for (const c of v.test_coverage.uncovered) lines.push(`- ${c}`);
    }
    lines.push("");
  }
  if (v.risks) {
    lines.push("## Risks");
    if (v.risks.deployment?.length) {
      lines.push("Deployment:");
      for (const c of v.risks.deployment) lines.push(`- ${c}`);
    }
    if (v.risks.rollback?.length) {
      lines.push("Rollback:");
      for (const c of v.risks.rollback) lines.push(`- ${c}`);
    }
    if (v.risks.monitoring?.length) {
      lines.push("Monitoring:");
      for (const c of v.risks.monitoring) lines.push(`- ${c}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export class ReviewAgent {
  constructor(private readonly opts: ReviewOptions) {}

  async run(): Promise<ReviewVerdict> {
    const diff = await computeDiff({
      repoRoot: this.opts.repoRoot,
      ...(this.opts.baseRef ? { baseRef: this.opts.baseRef } : {}),
      ...(this.opts.headRef ? { headRef: this.opts.headRef } : {}),
      ...(this.opts.maxDiffBytes ? { maxDiffBytes: this.opts.maxDiffBytes } : {}),
    });
    const { rendered: promptBody } = await renderPrompt(
      this.opts.promptName ?? "review",
      sanitizeUnicode({
        diff: diff.diff,
        changed_files: diff.changedFiles,
        truncated: diff.truncated,
        total_bytes: diff.totalBytes,
        base_ref: diff.baseRef,
        head_ref: diff.headRef,
        ...(this.opts.promptVars ?? {}),
      }) as Record<string, unknown>,
    );
    const model = this.opts.model ?? process.env.PAKALON_REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5";
    const caller =
      this.opts.callModel ??
      (async (args) => {
        const { streamMessages } = await import("@/ai/anthropic.js");
        let out = "";
        for await (const ev of streamMessages({
          model: model.replace(/^anthropic\//, ""),
          max_tokens: 4096,
          system: args.system,
          messages: [{ role: "user", content: args.user }],
        })) {
          if (ev.type === "text") out += ev.text;
          if (ev.type === "error") throw new ReviewError(ev.message, "model_error");
        }
        return out;
      });
    const out = await caller({
      model,
      system: "You are /review — a strict, concise code-review sub-agent. Output follows the format in the user prompt.",
      user: promptBody,
      maxTokens: 4096,
    });
    const verdict = parseVerdict(out);
    // Persist
    if (this.opts.persistDir || this.opts.repoRoot) {
      const dir = this.opts.persistDir ?? join(this.opts.repoRoot, ".pakalon", "reviews");
      const sha = await this.headSha().catch(() => "HEAD");
      const file = join(dir, `${sha.slice(0, 12)}.md`);
      try {
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        await writeFile(file, renderVerdict(verdict), "utf-8");
      } catch (e) {
        // best-effort
      }
    }
    // Promote label based on `failOnPriority` if provided.
    if (this.opts.failOnPriority) {
      const order: ReviewPriority[] = ["P0", "P1", "P2", "P3"];
      const threshold = order.indexOf(this.opts.failOnPriority);
      const worst = verdict.findings.reduce<ReviewPriority | undefined>(
        (acc, f) => {
          if (!acc) return f.priority;
          return order.indexOf(f.priority) < order.indexOf(acc)
            ? f.priority
            : acc;
        },
        undefined,
      );
      if (worst && order.indexOf(worst) <= threshold && verdict.label === "APPROVE") {
        verdict.label = "REQUEST_CHANGES";
      }
    }
    return verdict;
  }

  private async headSha(): Promise<string> {
    const res = await runGit(
      ["rev-parse", "HEAD"],
      this.opts.repoRoot,
      { timeoutMs: 5_000 },
    );
    return res.stdout.trim();
  }
}

/** Convenience wrapper. */
export async function runReview(opts: ReviewOptions): Promise<ReviewVerdict> {
  return new ReviewAgent(opts).run();
}
