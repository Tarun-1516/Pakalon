/**
 * Token usage display for /history.
 *
 * Mirrors the "/usage" view from the reference CLI: a per-session
 * breakdown of prompt / completion / cache / total tokens, plus
 * cost in USD when the model exposes a price.
 */
import * as fs from "fs/promises";
import * as path from "path";
import logger from "@/utils/logger.js";

export interface SessionUsageRow {
  sessionId: string;
  startedAt: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

const HISTORY_DIR = "history";

async function loadSessionUsage(projectDir: string, sessionId: string): Promise<SessionUsageRow | null> {
  const file = path.join(projectDir, ".pakalon", HISTORY_DIR, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as SessionUsageRow;
  } catch {
    return null;
  }
}

export async function listSessionUsage(projectDir: string, limit = 20): Promise<SessionUsageRow[]> {
  const dir = path.join(projectDir, ".pakalon", HISTORY_DIR);
  try {
    const entries = await fs.readdir(dir);
    const ids = entries
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""))
      .sort()
      .reverse()
      .slice(0, limit);
    const rows: SessionUsageRow[] = [];
    for (const id of ids) {
      const r = await loadSessionUsage(projectDir, id);
      if (r) rows.push(r);
    }
    return rows;
  } catch {
    return [];
  }
}

/** Pretty-print a token usage table for the /history command. */
export function renderUsageTable(rows: SessionUsageRow[]): string {
  if (rows.length === 0) return "_No session history found._";
  const header = "| Session | Model | Prompt | Completion | Cache | Total | Cost |";
  const sep = "|---------|-------|--------|------------|-------|-------|------|";
  const body = rows
    .map(
      (r) =>
        `| ${r.sessionId.slice(0, 8)} | ${r.model} | ${r.promptTokens.toLocaleString()} | ${r.completionTokens.toLocaleString()} | ${(r.cacheReadTokens + r.cacheWriteTokens).toLocaleString()} | ${r.totalTokens.toLocaleString()} | $${r.costUsd.toFixed(4)} |`,
    )
    .join("\n");
  return `${header}\n${sep}\n${body}\n`;
}

export async function appendSessionUsage(projectDir: string, row: SessionUsageRow): Promise<void> {
  const dir = path.join(projectDir, ".pakalon", HISTORY_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${row.sessionId}.json`);
  await fs.writeFile(file, JSON.stringify(row, null, 2), "utf-8");
  logger.debug({ sessionId: row.sessionId, total: row.totalTokens }, "Session usage recorded");
}
