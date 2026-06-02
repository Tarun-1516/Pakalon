/**
 * Mem0 — primary memory adapter.
 *
 * Promotes mem0 from a sibling of Hindsight to the PRIMARY memory
 * store. Hindsight becomes a SECONDARY layer for vector search and
 * consolidation.
 *
 * The hybrid adapter has been updated to read from this module first.
 */
import logger from "@/utils/logger.js";
import { mem0Store, type MemoryEntry, type MemoryQuery } from "./mem0-adapter.js";
import { hindsightSearch } from "./hindsight.js";

export interface Mem0PrimaryOptions {
  /** If true, writes go to mem0 only. If false, we also index in Hindsight. */
  mem0Only?: boolean;
}

export class Mem0Primary {
  private readonly opts: Mem0PrimaryOptions;
  constructor(opts: Mem0PrimaryOptions = {}) {
    this.opts = { mem0Only: false, ...opts };
  }

  async remember(entry: MemoryEntry): Promise<void> {
    await mem0Store.upsert(entry);
    if (!this.opts.mem0Only) {
      // best-effort index in Hindsight for vector search
      try {
        await hindsightIndex(entry);
      } catch (err) {
        logger.debug({ err }, "mem0-primary: hindsight indexing failed (non-fatal)");
      }
    }
  }

  async recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    const primary = await mem0Store.search(query);
    if (primary.length >= (query.limit ?? 5)) return primary;
    // Backfill from Hindsight vector store
    try {
      const extra = await hindsightSearch(query);
      const seen = new Set(primary.map((e) => e.id));
      for (const e of extra) if (!seen.has(e.id)) primary.push(e);
    } catch (err) {
      logger.debug({ err }, "mem0-primary: hindsight recall failed (non-fatal)");
    }
    return primary.slice(0, query.limit ?? 5);
  }

  async forget(id: string): Promise<boolean> {
    const ok = await mem0Store.delete(id);
    try {
      await hindsightDelete(id);
    } catch {
      // ignore
    }
    return ok;
  }
}

export const mem0Primary = new Mem0Primary();

async function hindsightIndex(_entry: MemoryEntry): Promise<void> {
  // Hindsight's surface API is pluggable; this thin wrapper keeps the
  // rest of the app decoupled from its concrete internals.
  if (typeof (globalThis as any).__hindsightIndex === "function") {
    await (globalThis as any).__hindsightIndex(_entry);
  }
}

async function hindsightDelete(id: string): Promise<void> {
  if (typeof (globalThis as any).__hindsightDelete === "function") {
    await (globalThis as any).__hindsightDelete(id);
  }
}

async function hindsightSearch(query: MemoryQuery): Promise<MemoryEntry[]> {
  if (typeof (globalThis as any).__hindsightSearch === "function") {
    return (globalThis as any).__hindsightSearch(query);
  }
  return [];
}
