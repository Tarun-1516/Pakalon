/**
 * /heap-dump — write a V8 heap snapshot to disk.
 *
 * Mirrors `kill -USR2` in the reference CLI. Useful for debugging
 * memory leaks in the agent loop.
 */
import * as v8 from "v8";
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

export interface HeapDumpOptions {
  projectDir: string;
  /** Filename override. Default: heap-snap-<ISO>.heapsnapshot */
  filename?: string;
}

export interface HeapDumpResult {
  file: string;
  bytes: number;
}

export async function writeHeapDump(opts: HeapDumpOptions): Promise<HeapDumpResult> {
  const dir = path.join(opts.projectDir, ".pakalon", "diagnostics");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, opts.filename ?? `heap-snap-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`);
  const snapshot = v8.writeHeapSnapshot(file);
  const stat = await fs.promises.stat(snapshot);
  logger.info({ file: snapshot, bytes: stat.size }, "Heap dump written");
  return { file: snapshot, bytes: stat.size };
}
