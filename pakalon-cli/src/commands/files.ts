/**
 * /files — fast file picker for the current session.
 *
 * Mirrors the reference CLI's `/files` slash command. Reads the
 * recent-files cache (if any) and shows the top 20 most-recently-
 * modified files in the working directory.
 */
import * as fs from "fs/promises";
import * as path from "path";
import logger from "@/utils/logger.js";

export interface FileEntry {
  path: string;
  size: number;
  modified: string;
}

export async function recentFiles(projectDir: string, limit = 20): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > 4) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const stat = await fs.stat(full);
          out.push({ path: path.relative(projectDir, full), size: stat.size, modified: stat.mtime.toISOString() });
        } catch {
          // skip
        }
      }
    }
  }
  await walk(projectDir, 0);
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return out.slice(0, limit);
}

export async function renderFiles(projectDir: string): Promise<string> {
  try {
    const files = await recentFiles(projectDir, 30);
    if (files.length === 0) return "# Files\n\n_No files found._";
    const lines = ["# Recent files", ""];
    for (const f of files) {
      lines.push(`- \`${f.path}\` (${f.size.toLocaleString()} bytes, ${f.modified.slice(0, 19)})`);
    }
    return lines.join("\n");
  } catch (err) {
    logger.warn({ err }, "renderFiles failed");
    return "# Files\n\n_Unable to list files._";
  }
}
