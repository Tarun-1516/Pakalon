/**
 * omp commit — atomic commit with auto-splits.
 *
 * Rather than committing everything as one giant blob, omp commit:
 *   1. Detects the change set: `git status --porcelain`.
 *   2. Groups related files into "logical units" (heuristics):
 *      a. `feat|fix|chore|docs|test|...(<scope>):` from a hint file
 *      b. Same directory tree
 *      c. Same source file extension
 *      d. Same git "intent" (added vs modified vs deleted)
 *   3. For each group, writes a commit:
 *      - subject <= 72 chars
 *      - body explains the "why"
 *      - footer has `Refs:`, `Tests:`, `Risks:` lines if known
 *   4. Returns a summary (one Commit per group).
 *
 * The user can preview with `omp commit --dry-run` and re-order groups.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { redactSensitive } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ChangeType = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "intent";

export interface ChangeEntry {
  /** Absolute path on disk. */
  path: string;
  /** Change type. */
  type: ChangeType;
  /** Old path (only for renamed/copied). */
  oldPath?: string;
  /** Number of insertions (if computed). */
  additions?: number;
  /** Number of deletions (if computed). */
  deletions?: number;
}

export interface CommitGroup {
  /** Subject (one line). */
  subject: string;
  /** Optional body (multi-line). */
  body?: string;
  /** Conventional-commit type. */
  type?: string;
  /** Conventional-commit scope. */
  scope?: string;
  /** Files in this group. */
  files: ChangeEntry[];
  /** Footer lines (e.g. `Refs: #123`). */
  footers?: Record<string, string>;
}

export interface CommitSummary {
  /** The commit SHA, if applied. */
  sha?: string;
  /** Subject. */
  subject: string;
  /** Body. */
  body?: string;
  /** Files. */
  files: ChangeEntry[];
}

export interface OmpCommitOptions {
  repoRoot: string;
  /** Force a single commit (skip auto-split). */
  single?: boolean;
  /** Custom groups (skips auto-grouping). */
  groups?: CommitGroup[];
  /** Run `git add` before committing (default true). */
  stage?: boolean;
  /** Sign the commit (--gpg-sign). */
  sign?: boolean;
  /** Allow empty commit. */
  allowEmpty?: boolean;
  /** No-verify hook bypass. */
  noVerify?: boolean;
  /** Push after commit. */
  push?: boolean | { remote: string; branch: string };
  /** Conventional-commit types (default: feat, fix, docs, style, refactor, test, chore, perf, build, ci). */
  conventionalTypes?: string[];
  /** Custom subject template (Mustache-like: `{{type}}{{#scope}}({{scope}}){{/scope}}: {{subject}}`). */
  subjectTemplate?: string;
  /** Custom footer (added to every group). */
  extraFooters?: Record<string, string>;
  /** When set, run `git commit` for each group, but don't actually push or change the working tree. */
  dryRun?: boolean;
  /** PR / issue hints (added as `Refs:`). */
  refs?: string[];
  /** Override the committer name/email. */
  author?: { name: string; email: string };
}

export class OmpCommitError extends Error {
  readonly code: string;
  readonly status: number;
  readonly gitOutput?: string;
  constructor(message: string, code: string, status = 1, gitOutput?: string) {
    super(redactSensitive(message));
    this.name = "OmpCommitError";
    this.code = code;
    this.status = status;
    this.gitOutput = gitOutput;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: run git
// ─────────────────────────────────────────────────────────────────────────────

function runGit(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; env?: Record<string, string>; input?: string } = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, options.timeoutMs);
    }
    proc.stdout.on("data", (c) => stdoutChunks.push(c));
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
        status: code ?? 0,
      });
    });
    if (options.input != null) {
      proc.stdin.write(options.input);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff parsing
// ─────────────────────────────────────────────────────────────────────────────

export async function getStatus(repoRoot: string): Promise<ChangeEntry[]> {
  // `git status --porcelain=v2 -z` returns NUL-separated records; much easier
  // to parse.
  const res = await runGit(
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    repoRoot,
    { timeoutMs: 10_000 },
  );
  if (res.status !== 0) {
    throw new OmpCommitError(
      `git status failed: ${res.stderr}`,
      "status_failed",
      res.status,
      res.stdout + res.stderr,
    );
  }
  const out: ChangeEntry[] = [];
  // v2 + -z emits `\0` between path and the rest of the line. We split on
  // `\0`, then process the records one at a time.
  const records = res.stdout.split("\0").filter(Boolean);
  for (const r of records) {
    // 1 "XY" + "sub" + "mH" + "mI" + "mW" + "hH" + path
    if (r[0] === "1") {
      const xy = r.slice(2, 4);
      const rest = r.slice(4);
      const tab = rest.indexOf(" ");
      const path = tab === -1 ? rest : rest.slice(tab + 1);
      out.push({
        path: join(repoRoot, path),
        type: mapXyToType(xy),
      });
    } else if (r[0] === "2") {
      // renamed/copied
      const xy = r.slice(2, 4);
      const rest = r.slice(4);
      const spaceIdx = rest.indexOf(" ");
      const oldPath = spaceIdx === -1 ? "" : rest.slice(0, spaceIdx);
      const path = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
      out.push({
        path: join(repoRoot, path),
        oldPath: join(repoRoot, oldPath),
        type: xy[0] === "R" ? "renamed" : "copied",
      });
    } else if (r[0] === "?") {
      // untracked
      out.push({ path: join(repoRoot, r.slice(2)), type: "untracked" });
    } else if (r[0] === "u") {
      // unmerged (conflict)
      out.push({ path: join(repoRoot, r.slice(2)), type: "intent" });
    }
  }
  return out;
}

function mapXyToType(xy: string): ChangeType {
  const X = xy[0];
  const Y = xy[1];
  if (X === "A" || Y === "A") return "added";
  if (X === "D" || Y === "D") return "deleted";
  if (X === "M" || Y === "M") return "modified";
  if (X === "R" || Y === "R") return "renamed";
  if (X === "C" || Y === "C") return "copied";
  return "modified";
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TYPES = [
  "feat", "fix", "perf", "refactor",
  "docs", "test", "build", "ci", "style", "chore",
];

const TYPE_HINTS: Record<string, RegExp[]> = {
  feat: [/\b(?:feat|feature|add|implement|introduce)\b/i],
  fix: [/\b(?:fix|bug|patch|hotfix|regression)\b/i],
  perf: [/\b(?:perf|optimi[sz]e|speed|faster)\b/i],
  refactor: [/\b(?:refactor|restructure|reorgani[sz]e|rewrite)\b/i],
  docs: [/\b(?:doc|readme|comment|jsdoc)\b/i, /\.(md|mdx|rst|adoc|tex)$/i],
  test: [/\btest\b/i, /\.(test|spec)\.[a-z]+$/i, /(^|\/)__tests__\//],
  build: [/\bbuild\b/i, /(^|\/)(Makefile|Cargo\.toml|package\.json|pyproject\.toml|go\.mod|CMakeLists\.txt)$/],
  ci: [/\bci\b|\.github\//, /\.circleci\//, /^\.gitlab-ci/],
  style: [/\bstyle\b|\bformat\b|\blint\b/i, /\.(css|scss|sass|less|html|vue|svelte)$/i],
  chore: [/\bchore\b|\bdeps?\b|\bbump\b/i],
};

function detectType(
  file: ChangeEntry,
  hint?: string,
  types: string[] = DEFAULT_TYPES,
): string {
  if (hint) {
    for (const t of types) {
      const patterns = TYPE_HINTS[t];
      if (patterns && patterns.some((p) => p.test(hint))) return t;
    }
  }
  // File-based detection
  for (const t of types) {
    const patterns = TYPE_HINTS[t];
    if (patterns && patterns.some((p) => p.test(file.path))) return t;
  }
  return "chore";
}

function detectScope(file: ChangeEntry): string | undefined {
  // Use the top-level directory under the repo root.
  const parts = file.path.replace(/\\/g, "/").split("/");
  // Try to skip a leading "src/" or "packages/<name>/"
  const skipIdx = parts.findIndex((p) => p === "src");
  if (skipIdx >= 0 && parts[skipIdx + 1]) return parts[skipIdx + 1];
  const packagesIdx = parts.findIndex((p) => p === "packages");
  if (packagesIdx >= 0 && parts[packagesIdx + 1]) return parts[packagesIdx + 1];
  if (parts.length >= 2) return parts[parts.length - 2];
  return undefined;
}

const DEFAULT_SUBJECT_TEMPLATE = `{{type}}{{#scope}}({{scope}}){{/scope}}: {{subject}}`;

function renderSubject(
  template: string,
  vars: { type: string; scope?: string; subject: string },
): string {
  return template
    .replace(/\{\{type\}\}/g, vars.type)
    .replace(/\{\{#scope\}\}\(([^)]*)\)\{\{\/scope\}\}/g, vars.scope ? `($1)` : "")
    .replace(/\{\{#scope\}\}(.+?)\{\{\/scope\}\}/g, vars.scope ? "$1" : "")
    .replace(/\{\{scope\}\}/g, vars.scope ?? "")
    .replace(/\{\{subject\}\}/g, vars.subject);
}

function truncate(s: string, max = 72): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function groupChanges(changes: ChangeEntry[]): CommitGroup[] {
  if (!changes.length) return [];
  // Group by (type, scope, intent)
  const buckets = new Map<string, ChangeEntry[]>();
  for (const c of changes) {
    const t = detectType(c);
    const s = detectScope(c) ?? "";
    const intent = c.type === "added" || c.type === "untracked" ? "add" :
                   c.type === "deleted" ? "del" :
                   c.type === "renamed" || c.type === "copied" ? "move" : "mod";
    const key = `${t}::${s}::${intent}`;
    const list = buckets.get(key) ?? [];
    list.push(c);
    buckets.set(key, list);
  }
  // Convert to CommitGroup[]
  const groups: CommitGroup[] = [];
  for (const [key, files] of buckets) {
    const [t, s] = key.split("::");
    const scope = s || undefined;
    const firstName = files[0].path.split(/[\\/]/).pop() ?? "files";
    const subject = renderSubject(DEFAULT_SUBJECT_TEMPLATE, {
      type: t,
      ...(scope ? { scope } : {}),
      subject: humanizeSummary(firstName, files.length),
    });
    groups.push({
      type: t,
      ...(scope ? { scope } : {}),
      subject: truncate(subject),
      files,
    });
  }
  // Stable order: feat → fix → perf → refactor → docs → test → build → ci → style → chore
  const order = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "style", "chore"];
  groups.sort((a, b) => {
    const ai = order.indexOf(a.type ?? "chore");
    const bi = order.indexOf(b.type ?? "chore");
    if (ai !== bi) return ai - bi;
    return a.subject.localeCompare(b.subject);
  });
  return groups;
}

function humanizeSummary(first: string, total: number): string {
  const stem = first.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  const capitalized = stem.charAt(0).toUpperCase() + stem.slice(1);
  if (total === 1) return `${capitalized}`;
  return `${capitalized} (+${total - 1} more)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

export async function ompCommit(opts: OmpCommitOptions): Promise<CommitSummary[]> {
  const changes = opts.groups ? opts.groups.flatMap((g) => g.files) : await getStatus(opts.repoRoot);
  if (!changes.length) {
    throw new OmpCommitError("No changes to commit", "empty", 0);
  }
  const groups =
    opts.groups ??
    (opts.single
      ? [
          {
            subject: "chore: apply working tree changes",
            type: "chore",
            files: changes,
          },
        ]
      : groupChanges(changes));
  if (opts.stage !== false) {
    // Stage the file list (use `git add -A` to pick up deletes/renames; safer
    // than `git add <path>` because the working tree may have moved files).
    const stageRes = await runGit(["add", "-A", "--", "."], opts.repoRoot, { timeoutMs: 30_000 });
    if (stageRes.status !== 0) {
      throw new OmpCommitError(
        `git add -A failed: ${stageRes.stderr}`,
        "stage_failed",
        stageRes.status,
        stageRes.stdout + stageRes.stderr,
      );
    }
  }
  const summaries: CommitSummary[] = [];
  for (const g of groups) {
    if (!g.files.length) continue;
    // Build the commit message
    const footers: string[] = [];
    for (const [k, v] of Object.entries(g.footers ?? {})) footers.push(`${k}: ${v}`);
    for (const [k, v] of Object.entries(opts.extraFooters ?? {})) footers.push(`${k}: ${v}`);
    if (opts.refs?.length) footers.push(`Refs: ${opts.refs.join(", ")}`);
    const messageParts: string[] = [g.subject];
    if (g.body) messageParts.push("", g.body);
    if (footers.length) {
      messageParts.push("");
      for (const f of footers) messageParts.push(f);
    }
    const message = messageParts.join("\n");
    if (opts.dryRun) {
      summaries.push({
        subject: g.subject,
        ...(g.body ? { body: g.body } : {}),
        files: g.files,
      });
      continue;
    }
    // Reset the index to only the files in this group, then commit.
    const reset = await runGit(
      ["reset", "--quiet", "HEAD", "--", ...g.files.map((f) => toRel(opts.repoRoot, f.path))],
      opts.repoRoot,
      { timeoutMs: 10_000 },
    );
    if (reset.status !== 0 && !reset.stderr.includes("did not match any files")) {
      throw new OmpCommitError(
        `git reset failed: ${reset.stderr}`,
        "reset_failed",
        reset.status,
        reset.stdout + reset.stderr,
      );
    }
    const addArgs = ["add", "--", ...g.files.map((f) => toRel(opts.repoRoot, f.path))];
    const addRes = await runGit(addArgs, opts.repoRoot, { timeoutMs: 10_000 });
    if (addRes.status !== 0) {
      throw new OmpCommitError(
        `git add failed: ${addRes.stderr}`,
        "stage_failed",
        addRes.status,
        addRes.stdout + addRes.stderr,
      );
    }
    // Commit
    const commitArgs = ["commit", "-F", "-"];
    if (opts.sign) commitArgs.push("--gpg-sign");
    if (opts.allowEmpty) commitArgs.push("--allow-empty");
    if (opts.noVerify) commitArgs.push("--no-verify");
    if (opts.author) {
      commitArgs.push(`--author=${opts.author.name} <${opts.author.email}>`);
    }
    const commitRes = await runGit(commitArgs, opts.repoRoot, {
      input: message,
      timeoutMs: 30_000,
    });
    if (commitRes.status !== 0) {
      throw new OmpCommitError(
        `git commit failed: ${commitRes.stderr}`,
        "commit_failed",
        commitRes.status,
        commitRes.stdout + commitRes.stderr,
      );
    }
    const shaRes = await runGit(
      ["rev-parse", "HEAD"],
      opts.repoRoot,
      { timeoutMs: 5_000 },
    );
    const sha = shaRes.stdout.trim();
    summaries.push({
      sha,
      subject: g.subject,
      ...(g.body ? { body: g.body } : {}),
      files: g.files,
    });
  }
  // Push
  if (opts.push) {
    const target = typeof opts.push === "object" ? opts.push : undefined;
    const pushArgs = ["push"];
    if (target?.remote) pushArgs.push(target.remote);
    if (target?.branch) pushArgs.push(target.branch);
    else pushArgs.push("HEAD");
    const pushRes = await runGit(pushArgs, opts.repoRoot, { timeoutMs: 60_000 });
    if (pushRes.status !== 0) {
      throw new OmpCommitError(
        `git push failed: ${pushRes.stderr}`,
        "push_failed",
        pushRes.status,
        pushRes.stdout + pushRes.stderr,
      );
    }
  }
  return summaries;
}

function toRel(root: string, abs: string): string {
  return abs.startsWith(root + "/") || abs.startsWith(root + "\\")
    ? abs.slice(root.length + 1).replace(/\\/g, "/")
    : abs;
}
