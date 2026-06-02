/**
 * Phase 4 TDD screenshot directory writer.
 *
 * The Phase 4 testing agent drives a headless Chrome via the
 * ChromeDevTools tool. Every screenshot and video capture is dropped
 * into `.pakalon-agents/ai-agents/phase-4/tdd/`. This module provides
 * the helper API the agent calls to:
 *   1. Bootstrap the directory.
 *   2. Generate a per-test name like `auth-login--2026-06-02T11-30.png`.
 *   3. List the artifacts so the test report can link to them.
 */
import * as fs from "fs/promises";
import * as path from "path";
import logger from "@/utils/logger.js";

const TDD_ROOT = "phase-4/tdd";

export interface TddFileRecord {
  name: string;
  path: string;
  bytes: number;
  ts: string;
}

export async function ensureTddDir(projectDir: string): Promise<string> {
  const dir = path.join(projectDir, ".pakalon-agents", "ai-agents", TDD_ROOT);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Build a screenshot filename with timestamp + optional test name. */
export function tddFilename(testName: string, kind: "png" | "webm" | "json" = "png"): string {
  const safe = testName.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${safe}--${ts}.${kind}`;
}

/** Save a buffer into the TDD dir. Returns the absolute path. */
export async function writeTddArtifact(
  projectDir: string,
  testName: string,
  data: Buffer,
  kind: "png" | "webm" | "json" = "png",
): Promise<string> {
  const dir = await ensureTddDir(projectDir);
  const file = path.join(dir, tddFilename(testName, kind));
  await fs.writeFile(file, data);
  logger.info({ file, bytes: data.length, test: testName }, "TDD artifact written");
  return file;
}

/** Save a JSON object as a TDD artifact. */
export async function writeTddJson(projectDir: string, testName: string, payload: unknown): Promise<string> {
  const buf = Buffer.from(JSON.stringify(payload, null, 2), "utf-8");
  return writeTddArtifact(projectDir, testName, buf, "json");
}

/** List all TDD artifacts, sorted by mtime (oldest first). */
export async function listTddArtifacts(projectDir: string): Promise<TddFileRecord[]> {
  const dir = path.join(projectDir, ".pakalon-agents", "ai-agents", TDD_ROOT);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: TddFileRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      out.push({ name: entry.name, path: path.join(dir, entry.name), bytes: stat.size, ts: stat.mtime.toISOString() });
    }
    return out.sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    return [];
  }
}

/** Build a Markdown index of every TDD artifact for inclusion in the Phase 4 report. */
export async function buildTddIndex(projectDir: string): Promise<string> {
  const files = await listTddArtifacts(projectDir);
  const lines = ["# Phase 4 — TDD artifacts", ""];
  if (files.length === 0) {
    lines.push("_No artifacts yet._");
    return lines.join("\n");
  }
  for (const f of files) {
    const rel = path.relative(projectDir, f.path);
    lines.push(`- ${f.ts} — [${f.name}](${rel}) (${f.bytes} bytes)`);
  }
  return lines.join("\n");
}
