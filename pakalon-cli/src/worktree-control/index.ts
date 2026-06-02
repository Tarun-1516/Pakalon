/**
 * worktree-control — Git worktree manager used by the agent loop.
 *
 * Each agent phase runs in its own worktree (`.pakalon/wt/<phase>/<branch>`)
 * so that edits in one phase don't disturb another. This module wraps
 * `simple-git` (or `child_process.spawn("git", …)`) with a typed API:
 *
 *   - add / list / remove / prune
 *   - lock / unlock / move
 *   - repair (recreate a worktree whose branch was deleted)
 *   - status (per-worktree: dirty? ahead/behind? lock-held?)
 *   - collect (run `git fetch --all` + cleanup dead worktrees)
 */
import { spawn } from "node:child_process";
import { mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSensitive } from "@/utils/safe-string.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WorktreeEntry {
  /** Absolute path on disk. */
  path: string;
  /** Commit SHA checked out at HEAD. */
  head: string;
  /** Branch checked out, or "(detached)". */
  branch: string;
  /** Whether this is the main worktree. */
  isMain: boolean;
  /** Whether the worktree is locked. */
  locked: boolean;
  /** Lock reason (if any). */
  lockReason?: string;
  /** Whether the worktree's branch is gone (prunable). */
  prunable?: { reason: string };
  /** Dirty (uncommitted changes) — derived via `git status`. */
  dirty?: boolean;
  /** Ahead/behind upstream — derived via `git rev-list`. */
  ahead?: number;
  behind?: number;
}

export interface WorktreeAddOptions {
  /** Branch to check out. Created from `startPoint` if it doesn't exist. */
  branch: string;
  /** Path (absolute). */
  path: string;
  /** Base ref for the new branch (e.g. "main", commit sha). */
  startPoint?: string;
  /** "true" to create a new branch, "false" to check out an existing one. */
  createBranch?: boolean;
  /** Whether to force (drops local changes). */
  force?: boolean;
  /** Whether to detach HEAD. */
  detach?: boolean;
  /** Lock the new worktree with a reason. */
  lock?: boolean;
  lockReason?: string;
}

export interface WorktreeListOptions {
  /** Include porcelain format with extra fields. */
  porcelain?: boolean;
}

export interface WorktreeStatusOptions {
  /** Per-worktree: also compute dirty + ahead/behind. */
  includeStatus?: boolean;
}

export class WorktreeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly gitOutput?: string;
  constructor(message: string, code: string, status = 1, gitOutput?: string) {
    super(redactSensitive(message));
    this.name = "WorktreeError";
    this.code = code;
    this.status = status;
    this.gitOutput = gitOutput;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: run `git` and capture stdout/stderr
// ─────────────────────────────────────────────────────────────────────────────

interface GitRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runGit(
  args: string[],
  cwd: string,
  options: { input?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
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
    if (killed) {
      reject(new WorktreeError("git command timed out", "timeout", 124));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing `git worktree list --porcelain`
// ─────────────────────────────────────────────────────────────────────────────

export function parsePorcelainList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> = {};
  for (const line of output.split(/\r?\n/)) {
    if (line === "") {
      if (cur.path) entries.push(cur as WorktreeEntry);
      cur = {};
      continue;
    }
    if (line.startsWith("worktree ")) {
      cur.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      cur.branch = "(detached)";
    } else if (line === "locked") {
      cur.locked = true;
    } else if (line.startsWith("locked ")) {
      cur.locked = true;
      cur.lockReason = line.slice("locked ".length);
    } else if (line.startsWith("prunable ")) {
      cur.prunable = { reason: line.slice("prunable ".length) };
    } else if (line === "bare") {
      // main + bare — treat as main
      cur.isMain = true;
    } else if (line === "main") {
      cur.isMain = true;
    }
  }
  if (cur.path) entries.push(cur as WorktreeEntry);
  // First entry is the main worktree.
  if (entries.length) entries[0].isMain = true;
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export class WorktreeController {
  constructor(private readonly repoRoot: string) {}

  /** Add a new worktree. */
  async add(opts: WorktreeAddOptions): Promise<WorktreeEntry> {
    if (!isAbsolute(opts.path)) {
      throw new WorktreeError(
        `Worktree path must be absolute, got ${opts.path}`,
        "invalid_path",
      );
    }
    await mkdir(dirname(opts.path), { recursive: true });
    const args = ["worktree", "add", "--track"];
    if (opts.force) args.push("--force");
    if (opts.detach) args.push("--detach");
    if (opts.createBranch === false) args.push("--no-track");
    args.push(opts.path, opts.branch);
    if (opts.startPoint) args.push(opts.startPoint);
    const res = await runGit(args, this.repoRoot, { timeoutMs: 30_000 });
    if (res.status !== 0) {
      throw new WorktreeError(
        `git worktree add failed: ${res.stderr || res.stdout}`,
        "add_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
    if (opts.lock) {
      await this.lock(opts.path, opts.lockReason);
    }
    const list = await this.list();
    return (
      list.find((w) => w.path === opts.path) ?? {
        path: opts.path,
        head: "",
        branch: opts.branch,
        isMain: false,
        locked: !!opts.lock,
        lockReason: opts.lockReason,
      }
    );
  }

  /** List all worktrees. */
  async list(opts: WorktreeListOptions = {}): Promise<WorktreeEntry[]> {
    const args = ["worktree", "list", "--porcelain"];
    if (opts.porcelain !== false) args.push("--porcelain");
    const res = await runGit(args, this.repoRoot, { timeoutMs: 10_000 });
    if (res.status !== 0) {
      throw new WorktreeError(
        `git worktree list failed: ${res.stderr || res.stdout}`,
        "list_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
    return parsePorcelainList(res.stdout);
  }

  /** List worktrees, enriched with dirty + ahead/behind info. */
  async status(opts: WorktreeStatusOptions = {}): Promise<WorktreeEntry[]> {
    const list = await this.list();
    if (!opts.includeStatus) return list;
    for (const w of list) {
      if (!existsSync(w.path)) continue;
      try {
        const dirty = await runGit(
          ["status", "--porcelain"],
          w.path,
          { timeoutMs: 5_000 },
        );
        w.dirty = dirty.stdout.trim().length > 0;
        if (w.branch && w.branch !== "(detached)") {
          const branch = w.branch.replace(/^refs\/heads\//, "");
          const rev = await runGit(
            [
              "rev-list",
              "--left-right",
              "--count",
              `${branch}...@{u}`,
            ],
            w.path,
            { timeoutMs: 5_000 },
          );
          if (rev.status === 0) {
            const [ahead, behind] = rev.stdout
              .trim()
              .split(/\s+/)
              .map((n) => parseInt(n, 10));
            w.ahead = Number.isFinite(ahead) ? ahead : 0;
            w.behind = Number.isFinite(behind) ? behind : 0;
          }
        }
      } catch {
        // best-effort
      }
    }
    return list;
  }

  /** Remove a worktree. */
  async remove(path: string, force = false): Promise<void> {
    if (!isAbsolute(path)) {
      throw new WorktreeError(`Path must be absolute: ${path}`, "invalid_path");
    }
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    const res = await runGit(args, this.repoRoot, { timeoutMs: 30_000 });
    if (res.status !== 0) {
      throw new WorktreeError(
        `git worktree remove failed: ${res.stderr || res.stdout}`,
        "remove_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
  }

  /** Prune dead worktree metadata. */
  async prune(): Promise<{ pruned: string[] }> {
    const before = await this.list();
    const res = await runGit(
      ["worktree", "prune", "--verbose"],
      this.repoRoot,
      { timeoutMs: 30_000 },
    );
    if (res.status !== 0) {
      throw new WorktreeError(
        `git worktree prune failed: ${res.stderr || res.stdout}`,
        "prune_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
    const after = await this.list();
    const prunedPaths = before
      .filter((b) => !after.some((a) => a.path === b.path))
      .map((w) => w.path);
    return { pruned: prunedPaths };
  }

  /** Lock a worktree. */
  async lock(path: string, reason?: string): Promise<void> {
    const args = ["worktree", "lock", "--reason", reason ?? "pakalon-agent"];
    if (reason) args.push("--reason", reason);
    args.push(path);
    const res = await runGit(args, this.repoRoot, { timeoutMs: 10_000 });
    if (res.status !== 0) {
      throw new WorktreeError(
        `git worktree lock failed: ${res.stderr || res.stdout}`,
        "lock_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
  }

  /** Unlock a worktree. */
  async unlock(path: string): Promise<void> {
    const res = await runGit(
      ["worktree", "unlock", path],
      this.repoRoot,
      { timeoutMs: 10_000 },
    );
    if (res.status !== 0) {
      throw new WorktreeError(
        `git worktree unlock failed: ${res.stderr || res.stdout}`,
        "unlock_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
  }

  /** Move a worktree to a new path. */
  async move(from: string, to: string): Promise<void> {
    const res = await runGit(
      ["worktree", "move", from, to],
      this.repoRoot,
      { timeoutMs: 30_000 },
    );
    if (res.status !== 0) {
      throw new WorktreeError(
        `git worktree move failed: ${res.stderr || res.stdout}`,
        "move_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
  }

  /** Repair a worktree whose branch was deleted. Re-creates the branch from
   *  a start point. */
  async repair(path: string, opts: { newBranch?: string; startPoint?: string } = {}): Promise<WorktreeEntry> {
    const w = (await this.list()).find((x) => x.path === path);
    if (!w) {
      throw new WorktreeError(`Worktree not found: ${path}`, "not_found");
    }
    const newBranch = opts.newBranch ?? w.branch;
    const startPoint = opts.startPoint ?? "HEAD";
    const res = await runGit(
      ["branch", newBranch, startPoint],
      this.repoRoot,
      { timeoutMs: 10_000 },
    );
    if (res.status !== 0) {
      throw new WorktreeError(
        `git branch ${newBranch} ${startPoint} failed: ${res.stderr || res.stdout}`,
        "branch_failed",
        res.status,
        res.stdout + res.stderr,
      );
    }
    const reset = await runGit(
      ["reset", "--hard", newBranch],
      path,
      { timeoutMs: 10_000 },
    );
    if (reset.status !== 0) {
      throw new WorktreeError(
        `git reset --hard failed: ${reset.stderr || reset.stdout}`,
        "reset_failed",
        reset.status,
        reset.stdout + reset.stderr,
      );
    }
    return (await this.list()).find((x) => x.path === path)!;
  }

  /** Allocate a fresh worktree path under `.pakalon/wt/<phase>/<branch>`. */
  async allocate(opts: {
    phase: string;
    branch: string;
    startPoint?: string;
    lock?: boolean;
  }): Promise<WorktreeEntry> {
    const safeBranch = opts.branch
      .replace(/[^A-Za-z0-9._/-]/g, "-")
      .replace(/^-+|-+$/g, "");
    const id = `${randomUUID().slice(0, 8)}-${basename(safeBranch)}`;
    const path = resolve(
      this.repoRoot,
      ".pakalon",
      "wt",
      opts.phase,
      id,
    );
    return this.add({
      branch: opts.branch,
      path,
      startPoint: opts.startPoint,
      createBranch: true,
      ...(opts.lock ? { lock: true, lockReason: `pakalon:phase=${opts.phase}` } : {}),
    });
  }

  /** Fetch all remotes, prune dead remotes, prune dead worktrees. */
  async collect(): Promise<{ remotesFetched: string[]; pruned: string[] }> {
    const remotes = (
      await runGit(["remote"], this.repoRoot, { timeoutMs: 5_000 })
    ).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const fetched: string[] = [];
    for (const r of remotes) {
      const res = await runGit(
        ["fetch", "--prune", "--tags", r],
        this.repoRoot,
        { timeoutMs: 60_000 },
      );
      if (res.status === 0) fetched.push(r);
    }
    const { pruned } = await this.prune();
    return { remotesFetched: fetched, pruned };
  }

  /** Write a marker file inside a worktree's `.git` so the agent knows
   *  this worktree is owned by pakalon (and is safe to nuke on cleanup). */
  async markOwned(path: string, meta: { phase: string; branch: string; sessionId?: string }): Promise<void> {
    const gitDir = join(path, ".git");
    let useFile = gitDir;
    if (existsSync(gitDir)) {
      const statR = await stat(gitDir);
      if (statR.isFile()) {
        // Worktree's `.git` is a file pointing to a real gitdir.
        const text = await readFile(gitDir, "utf-8");
        const m = /^gitdir:\s*(.+)$/m.exec(text);
        if (m) useFile = join(path, m[1].trim());
      }
    }
    const marker = join(useFile, "pakalon-owner.json");
    await writeFile(
      marker,
      JSON.stringify({ ...meta, ts: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  }

  /** Best-effort cleanup of all `.pakalon/wt/**` worktrees for a given phase. */
  async cleanupPhase(phase: string): Promise<{ removed: string[]; pruned: string[] }> {
    const wtRoot = join(this.repoRoot, ".pakalon", "wt", phase);
    const removed: string[] = [];
    if (!existsSync(wtRoot)) {
      const { pruned } = await this.prune();
      return { removed, pruned };
    }
    const all = await this.list();
    for (const w of all) {
      if (w.path.startsWith(wtRoot)) {
        try {
          await this.remove(w.path, true);
          removed.push(w.path);
        } catch {
          // ignore — may already be gone
        }
      }
    }
    // Also rm the dir on disk in case git missed it.
    try {
      await rm(wtRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const { pruned } = await this.prune();
    return { removed, pruned };
  }
}
