/**
 * Hindsight memory engine — hybrid retrieval + importance decay + mnemopi sync.
 *
 * This is the policy layer that sits on top of `HindsightStore` (raw SQLite
 * + FTS5 + BLOB embeddings). The engine owns:
 *
 *   - retain:        Insert a new memory (or update existing by hash).
 *   - recall:        Hybrid retrieval combining FTS5 (BM25) + vector cosine
 *                    + recency + importance, with configurable weight blend.
 *   - reflect:       Compress a session into a MentalModel.
 *   - consolidate:   Decay importance over time, merge near-duplicates,
 *                    prune stale rows, and surface "superseded by" edges.
 *   - syncMnemopi:   Drain the outbox to a remote mnemopi client (with
 *                    exponential backoff for retries).
 *   - forget:        Mark a memory as forgotten (soft delete + log entry).
 *   - prune:         Hard-delete memories below a threshold.
 *   - snapshot:      Export the entire store as a JSON document (for backup
 *                    or for cross-machine sharing).
 *
 * The engine does NOT depend on a remote embedding provider — it embeds
 * everything locally with TF-IDF. A remote embedder can be wired in later
 * by replacing `TfidfEmbedder` with a swappable implementation.
 */

import { randomUUID, createHash } from "crypto";
import {
  HindsightStore,
  type HindsightStoreOptions,
  type MemoryRow,
  type MemoryKind,
  type MemoryScope,
  type InsertMemoryInput,
  type MentalModelRow,
  type AccessLogRow,
} from "./hindsight-store.js";
import { TfidfEmbedder } from "./hindsight-embeddings.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HindsightEngineOptions extends HindsightStoreOptions {
  userId: string;
  /** Blend weight for vector vs FTS5 in hybrid recall. 0..1, default 0.6. */
  vectorWeight?: number;
  /** Half-life in days for importance decay. Default 30. */
  decayHalfLifeDays?: number;
  /** Default scope if retain() doesn't specify. Default "global". */
  defaultScope?: MemoryScope;
}

export interface RetainArgs {
  content: string;
  tags?: string[];
  scope?: MemoryScope;
  kind?: MemoryKind;
  projectPath?: string;
  sessionId?: string;
  importance?: number;
  confidence?: number;
  links?: string[];
  /** If true, don't deduplicate — always insert a new row. */
  force?: boolean;
}

export interface RecallArgs {
  query: string;
  topK?: number;
  scope?: MemoryScope | MemoryScope[];
  kind?: MemoryKind | MemoryKind[];
  projectPath?: string;
  tags?: string[];
  /** Minimum final score, 0..1. */
  minScore?: number;
  /** Override vector/FTS blend for this call. */
  vectorWeight?: number;
}

export interface RecallHit {
  memory: MemoryRow;
  score: number;          // 0..1
  vectorScore: number;    // cosine
  ftsScore: number;       // 0..1 (lower BM25 → higher ftsScore)
  recencyScore: number;   // 0..1
  importanceScore: number;// 0..1
  reasons: string[];      // human-readable explainer
}

export interface ReflectArgs {
  sessionId: string;
  summary: string;
  keyFindings?: string[];
  projectInsights?: string[];
  messageCount: number;
  durationMs: number;
}

export interface ConsolidateResult {
  scanned: number;
  decayed: number;
  merged: number;
  pruned: number;
  errors: string[];
}

export interface SyncResult {
  attempted: number;
  pushed: number;
  deleted: number;
  failed: number;
  remaining: number;
}

export interface Snapshot {
  version: 1;
  takenAt: string;
  userId: string;
  memories: MemoryRow[];
  links: Array<{ fromId: string; toId: string; type: string; weight: number; createdAt: string }>;
  mentalModels: MentalModelRow[];
  meta: Record<string, string>;
  idf: number[];          // serialized Float32Array
}

// ---------------------------------------------------------------------------
// Mnemopi client interface
// ---------------------------------------------------------------------------

export interface MnemopiClient {
  push(payload: { memoryId: string; userId: string; snapshot: unknown }): Promise<void>;
  delete(payload: { memoryId: string; userId: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const DEFAULT_TOPK = 10;
const DEFAULT_MIN_SCORE = 0.05;

export class HindsightEngine {
  readonly store: HindsightStore;
  readonly userId: string;
  readonly vectorWeight: number;
  readonly decayHalfLifeDays: number;
  readonly defaultScope: MemoryScope;

  /** Optional mnemopi remote client. Wired in via `attachMnemopi`. */
  private mnemopi: MnemopiClient | null = null;

  constructor(opts: HindsightEngineOptions) {
    this.userId = opts.userId;
    this.vectorWeight = clamp(opts.vectorWeight ?? 0.6, 0, 1);
    this.decayHalfLifeDays = Math.max(1, opts.decayHalfLifeDays ?? 30);
    this.defaultScope = opts.defaultScope ?? "global";
    this.store = new HindsightStore(opts);
    this.ensureIdfLoaded();
  }

  // -------------------------------------------------------------------------
  // IDF cache
  // -------------------------------------------------------------------------

  private ensureIdfLoaded(): void {
    const cached = this.store.metaGet("idf.v1");
    if (!cached) return;
    try {
      const arr = JSON.parse(cached) as number[];
      if (Array.isArray(arr) && arr.length === this.store.embedder.dimensions) {
        const t = new TfidfEmbedder();
        // Inject the cached IDF by overriding the default-smoothed values.
        for (let i = 0; i < arr.length; i++) (t as any).idf[i] = arr[i];
        (this.store.embedder as any).idf = (t as any).idf;
      }
    } catch {
      // Ignore — IDF will be rebuilt incrementally.
    }
  }

  private persistIdf(): void {
    const idf = Array.from(this.store.embedder.exportIdf());
    this.store.metaSet("idf.v1", JSON.stringify(idf));
  }

  // -------------------------------------------------------------------------
  // Mnemopi wiring
  // -------------------------------------------------------------------------

  attachMnemopi(client: MnemopiClient): void {
    this.mnemopi = client;
  }

  // -------------------------------------------------------------------------
  // retain
  // -------------------------------------------------------------------------

  retain(args: RetainArgs): MemoryRow {
    if (!args.content || !args.content.trim()) {
      throw new Error("[hindsight] retain(): content is required");
    }

    const id = this.contentHash(args.content, args.projectPath);
    const existing = this.store.getMemory(id);
    if (existing && !args.force) {
      // Bump importance slightly, merge tags, return existing.
      const mergedTags = uniq([
        ...JSON.parse(existing.tags),
        ...(args.tags ?? []),
      ]);
      const updated = this.store.insertMemory({
        id: existing.id,
        userId: this.userId,
        sessionId: args.sessionId ?? existing.sessionId,
        projectPath: args.projectPath ?? existing.projectPath,
        scope: args.scope ?? existing.scope,
        kind: args.kind ?? existing.kind,
        content: existing.content,
        tags: mergedTags,
        links: uniq([
          ...JSON.parse(existing.links),
          ...(args.links ?? []),
        ]),
        importance: clamp01((existing.importance + 0.05) * 0.9 + 0.05),
        confidence: Math.min(1, existing.confidence + 0.05),
        embedding: existing.embedding,
      });
      this.store.logAccess(updated.id, this.userId, "update");
      return updated;
    }

    // New memory — embed content, build row, insert.
    const embedding = this.store.embedder.embed(args.content);
    const row = this.store.insertMemory({
      id,
      userId: this.userId,
      sessionId: args.sessionId ?? null,
      projectPath: args.projectPath ?? null,
      scope: args.scope ?? this.defaultScope,
      kind: args.kind ?? "fact",
      content: args.content,
      tags: args.tags ?? [],
      links: args.links ?? [],
      importance: clamp01(args.importance ?? 0.5),
      confidence: clamp01(args.confidence ?? 0.5),
      embedding,
    });
    this.store.logAccess(row.id, this.userId, "retain");

    // Mnemopi outbox: enqueue async push.
    if (this.mnemopi) {
      this.store.enqueueOutbox(row.id, this.userId, "push", row, 0);
    }
    return row;
  }

  /**
   * Stable content hash so identical memories dedupe across sessions.
   * Uses sha1 over (content + projectPath) — fast + ample collision space
   * for personal-scale memory (10s of thousands of rows, not millions).
   */
  private contentHash(content: string, projectPath?: string | null): string {
    const h = createHash("sha1");
    h.update(content);
    h.update("\0");
    h.update(projectPath ?? "<global>");
    return h.digest("hex").slice(0, 32);
  }

  // -------------------------------------------------------------------------
  // recall (hybrid)
  // -------------------------------------------------------------------------

  recall(args: RecallArgs): RecallHit[] {
    if (!args.query || !args.query.trim()) return [];
    const topK = Math.max(1, args.topK ?? DEFAULT_TOPK);
    const minScore = args.minScore ?? DEFAULT_MIN_SCORE;
    const w = clamp(args.vectorWeight ?? this.vectorWeight, 0, 1);

    // Pre-filter via FTS5 — keeps the candidate set small. We over-fetch
    // by 4x to leave room for vector rescoring and post-filters.
    const ftsCandidates = this.store.ftsSearch(args.query, this.userId, topK * 4);

    // Vector candidates: scan all memories for the user. For a personal
    // store of <50k rows this is fine (256-dim cosine is ~30ns/row).
    const allRows = this.store.listForUser(this.userId, 50_000);

    // Build a candidate union: FTS hits first, then any vector-close rows
    // that FTS missed.
    const byId = new Map<string, MemoryRow>();
    for (const r of ftsCandidates) byId.set(r.id, r);
    const queryVec = this.store.embedder.embed(args.query);
    const overfetchRows = allRows.length;
    for (const r of allRows) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }

    // Score every candidate.
    const hits: RecallHit[] = [];
    for (const r of byId.values()) {
      if (!this.matchesFilters(r, args)) continue;

      const vectorScore = cosine(queryVec, r.embedding);
      const ftsRank = ftsCandidates.find((c) => c.id === r.id);
      const ftsScore = ftsRank ? normalizeBm25(ftsRank.rank) : 0;
      const recencyScore = recencyBoost(r);
      const importanceScore = r.importance;

      const blended = w * vectorScore
        + (1 - w) * ftsScore
        + 0.10 * recencyScore
        + 0.10 * importanceScore;
      if (blended < minScore) continue;

      const reasons: string[] = [];
      if (vectorScore > 0.4) reasons.push(`vector=${vectorScore.toFixed(2)}`);
      if (ftsScore > 0.2) reasons.push(`fts=${ftsScore.toFixed(2)}`);
      if (recencyScore > 0.5) reasons.push("recent");
      if (importanceScore > 0.7) reasons.push("high-importance");
      if (reasons.length === 0) reasons.push("weak-signal");

      hits.push({
        memory: r,
        score: blended,
        vectorScore,
        ftsScore,
        recencyScore,
        importanceScore,
        reasons,
      });
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, topK);

    // Bump access counters for returned rows (best-effort — does not
    // affect ordering on this call).
    for (const h of top) {
      this.store.bumpAccess(h.memory.id);
      this.store.logAccess(h.memory.id, this.userId, "recall", h.score, args.query.slice(0, 200));
    }
    return top;
  }

  private matchesFilters(r: MemoryRow, args: RecallArgs): boolean {
    if (args.scope) {
      const scopes = Array.isArray(args.scope) ? args.scope : [args.scope];
      if (!scopes.includes(r.scope)) return false;
    }
    if (args.kind) {
      const kinds = Array.isArray(args.kind) ? args.kind : [args.kind];
      if (!kinds.includes(r.kind)) return false;
    }
    if (args.projectPath && r.projectPath !== args.projectPath) return false;
    if (args.tags && args.tags.length > 0) {
      const tags = JSON.parse(r.tags) as string[];
      if (!args.tags.every((t) => tags.includes(t))) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // reflect
  // -------------------------------------------------------------------------

  reflect(args: ReflectArgs): MentalModelRow {
    const id = `mm-${this.userId}-${args.sessionId}-${Date.now()}`;
    const row = this.store.upsertMentalModel({
      id,
      userId: this.userId,
      sessionId: args.sessionId,
      summary: args.summary,
      keyFindings: JSON.stringify(args.keyFindings ?? []),
      projectInsights: JSON.stringify(args.projectInsights ?? []),
      messageCount: args.messageCount,
      durationMs: args.durationMs,
      createdAt: new Date().toISOString(),
    });
    return row;
  }

  /**
   * Auto-reflect: distill the most-important memories from a session into
   * a mental model. Uses a single recall against the session summary.
   */
  autoReflect(sessionId: string, sessionSummary: string, messageCount: number, durationMs: number): MentalModelRow {
    const hits = this.recall({ query: sessionSummary, topK: 8 });
    const keyFindings = hits
      .filter((h) => h.memory.kind === "fact" || h.memory.kind === "rule")
      .slice(0, 5)
      .map((h) => h.memory.content);
    const projectInsights = hits
      .filter((h) => h.memory.scope === "project")
      .slice(0, 5)
      .map((h) => h.memory.content);
    return this.reflect({
      sessionId,
      summary: sessionSummary,
      keyFindings,
      projectInsights,
      messageCount,
      durationMs,
    });
  }

  // -------------------------------------------------------------------------
  // consolidate (importance decay + dedup + prune)
  // -------------------------------------------------------------------------

  consolidate(opts: {
    decayFactor?: number;        // 0..1, default derived from half-life
    mergeThreshold?: number;     // cosine, default 0.92
    pruneImportanceBelow?: number; // default 0.05
    now?: Date;
  } = {}): ConsolidateResult {
    const now = opts.now ?? new Date();
    const decayFactor = opts.decayFactor ?? halfLifeToDecay(this.decayHalfLifeDays);
    const mergeThreshold = opts.mergeThreshold ?? 0.92;
    const pruneThreshold = opts.pruneImportanceBelow ?? 0.05;
    const result: ConsolidateResult = { scanned: 0, decayed: 0, merged: 0, pruned: 0, errors: [] };

    const all = this.store.listForUser(this.userId, 100_000);
    result.scanned = all.length;

    // 1. Decay importance for every row by age since last access.
    for (const r of all) {
      try {
        const ref = r.lastAccessedAt ?? r.createdAt;
        const ageDays = (now.getTime() - new Date(ref).getTime()) / 86_400_000;
        const newImportance = Math.max(0, r.importance * Math.pow(decayFactor, ageDays));
        if (Math.abs(newImportance - r.importance) > 1e-6) {
          // Reuse retain to update — same id upserts.
          this.store.insertMemory({
            id: r.id,
            userId: r.userId,
            sessionId: r.sessionId,
            projectPath: r.projectPath,
            scope: r.scope,
            kind: r.kind,
            content: r.content,
            tags: JSON.parse(r.tags),
            links: JSON.parse(r.links),
            importance: newImportance,
            confidence: r.confidence,
            embedding: r.embedding,
          });
          this.store.logAccess(r.id, this.userId, "consolidate", newImportance, "decay");
          result.decayed++;
        }
      } catch (e) {
        result.errors.push(`decay ${r.id}: ${(e as Error).message}`);
      }
    }

    // 2. Merge near-duplicates (cosine >= mergeThreshold). Keep the
    //    highest-importance copy, sum access counts, merge links/tags.
    const sorted = this.store.listForUser(this.userId, 100_000);
    const keep = new Set<string>();
    const skip = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (skip.has(a.id)) continue;
      keep.add(a.id);
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (skip.has(b.id)) continue;
        if (a.kind !== b.kind || a.scope !== b.scope) continue;
        const sim = cosine(a.embedding, b.embedding);
        if (sim >= mergeThreshold) {
          // Keep the more-important one, fold the loser into it.
          const winner = a.importance >= b.importance ? a : b;
          const loser = winner === a ? b : a;
          const mergedTags = uniq([...JSON.parse(winner.tags), ...JSON.parse(loser.tags)]);
          const mergedLinks = uniq([...JSON.parse(winner.links), loser.id, ...JSON.parse(loser.links)]);
          this.store.insertMemory({
            id: winner.id,
            userId: winner.userId,
            sessionId: winner.sessionId,
            projectPath: winner.projectPath,
            scope: winner.scope,
            kind: winner.kind,
            content: winner.content,
            tags: mergedTags,
            links: mergedLinks,
            importance: Math.max(winner.importance, loser.importance) + 0.01,
            confidence: Math.max(winner.confidence, loser.confidence),
            embedding: winner.embedding,
          });
          // Mark the loser for soft-delete via a "supersedes" link.
          this.store.upsertLink(winner.id, loser.id, "supersedes", 1.0);
          this.store.logAccess(loser.id, this.userId, "forget", null, `merged into ${winner.id}`);
          this.store.deleteMemory(loser.id);
          skip.add(loser.id);
          result.merged++;
        }
      }
    }

    // 3. Prune rows below threshold.
    const after = this.store.listForUser(this.userId, 100_000);
    for (const r of after) {
      if (r.importance < pruneThreshold) {
        this.store.logAccess(r.id, this.userId, "forget", null, "below-threshold");
        this.store.deleteMemory(r.id);
        result.pruned++;
      }
    }

    this.store.optimize();
    return result;
  }

  // -------------------------------------------------------------------------
  // forget / prune
  // -------------------------------------------------------------------------

  forget(memoryId: string, reason = "user-requested"): boolean {
    const r = this.store.getMemory(memoryId);
    if (!r) return false;
    this.store.logAccess(memoryId, this.userId, "forget", null, reason);
    if (this.mnemopi) {
      this.store.enqueueOutbox(memoryId, this.userId, "delete", { id: memoryId }, 0);
    }
    return this.store.deleteMemory(memoryId);
  }

  /**
   * Hard-prune all rows below a threshold (one-shot, no decay).
   */
  pruneBelow(threshold: number): number {
    const all = this.store.listForUser(this.userId, 100_000);
    let count = 0;
    for (const r of all) {
      if (r.importance < threshold) {
        this.store.deleteMemory(r.id);
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // syncMnemopi
  // -------------------------------------------------------------------------

  async syncMnemopi(opts: { maxBatch?: number; backoffBaseMs?: number; maxAttempts?: number } = {}): Promise<SyncResult> {
    if (!this.mnemopi) throw new Error("[hindsight] no mnemopi client attached");
    const maxBatch = opts.maxBatch ?? 50;
    const backoffBaseMs = opts.backoffBaseMs ?? 5_000;
    const maxAttempts = opts.maxAttempts ?? 6;

    const result: SyncResult = { attempted: 0, pushed: 0, deleted: 0, failed: 0, remaining: 0 };
    const due = this.store.outboxDue(new Date(), maxBatch);
    result.attempted = due.length;

    for (const row of due) {
      try {
        const payload = JSON.parse(row.payload);
        if (row.op === "push") {
          await this.mnemopi.push(payload);
          result.pushed++;
        } else if (row.op === "delete") {
          await this.mnemopi.delete(payload);
          result.deleted++;
        }
        this.store.outboxDelete(row.id);
      } catch (e) {
        const err = e as Error;
        if (row.attempts + 1 >= maxAttempts) {
          // Give up — leave a final error message but keep the row so a
          // future operator can inspect it.
          this.store.outboxMark(row.id, `giving up: ${err.message}`, new Date(Date.now() + 365 * 86_400_000));
          result.failed++;
        } else {
          const backoff = backoffBaseMs * Math.pow(2, row.attempts);
          this.store.outboxMark(
            row.id,
            err.message,
            new Date(Date.now() + Math.min(backoff, 3_600_000)),
          );
          result.failed++;
        }
      }
    }

    result.remaining = this.store.outboxCount();
    return result;
  }

  // -------------------------------------------------------------------------
  // snapshot / restore
  // -------------------------------------------------------------------------

  snapshot(): Snapshot {
    const memories = this.store.listForUser(this.userId, 100_000);
    const links = memories.flatMap((m) => this.store.linksFor(m.id));
    const mentalModels = this.store.listMentalModels(this.userId, 1000);
    const idf = Array.from(this.store.embedder.exportIdf());
    return {
      version: 1,
      takenAt: new Date().toISOString(),
      userId: this.userId,
      memories,
      links,
      mentalModels,
      meta: { idf: this.store.metaGet("idf.v1") ?? "" },
      idf,
    };
  }

  /**
   * Restore from a snapshot. Existing rows with the same id are overwritten;
   * new rows are inserted. Does NOT delete rows that aren't in the snapshot.
   */
  restore(snap: Snapshot, opts: { wipe?: boolean } = {}): number {
    if (snap.version !== 1) {
      throw new Error(`[hindsight] unsupported snapshot version: ${snap.version}`);
    }
    if (opts.wipe) {
      for (const r of this.store.listForUser(this.userId, 100_000)) {
        this.store.deleteMemory(r.id);
      }
    }
    let count = 0;
    for (const m of snap.memories) {
      this.store.insertMemory({
        id: m.id,
        userId: m.userId,
        sessionId: m.sessionId,
        projectPath: m.projectPath,
        scope: m.scope,
        kind: m.kind,
        content: m.content,
        tags: JSON.parse(m.tags),
        links: JSON.parse(m.links),
        importance: m.importance,
        confidence: m.confidence,
        embedding: m.embedding,
      });
      count++;
    }
    for (const l of snap.links) {
      this.store.upsertLink(l.fromId, l.toId, l.type, l.weight);
    }
    for (const mm of snap.mentalModels) {
      this.store.upsertMentalModel({
        id: mm.id,
        userId: mm.userId,
        sessionId: mm.sessionId,
        summary: mm.summary,
        keyFindings: mm.keyFindings,
        projectInsights: mm.projectInsights,
        messageCount: mm.messageCount,
        durationMs: mm.durationMs,
        createdAt: mm.createdAt,
      });
    }
    if (snap.idf && Array.isArray(snap.idf)) {
      (this.store.embedder as any).idf = new Float32Array(snap.idf);
      this.persistIdf();
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // list (convenience)
  // -------------------------------------------------------------------------

  list(limit = 100, kind?: MemoryKind): MemoryRow[] {
    const all = this.store.listForUser(this.userId, limit);
    return kind ? all.filter((r) => r.kind === kind) : all;
  }

  /** Access-log history for a memory. */
  history(memoryId: string, limit = 20): AccessLogRow[] {
    return this.store.recentAccess(memoryId, limit);
  }

  /** ID for a memory that satisfies the predicate, or null. */
  findId(predicate: (r: MemoryRow) => boolean): string | null {
    for (const r of this.store.listForUser(this.userId, 100_000)) {
      if (predicate(r)) return r.id;
    }
    return null;
  }

  close(): void {
    this.persistIdf();
    this.store.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Recency boost — linear decay from 1.0 (now) to 0.0 (90 days ago).
 */
function recencyBoost(r: MemoryRow, now = new Date()): number {
  const ref = r.lastAccessedAt ?? r.createdAt;
  const ageMs = now.getTime() - new Date(ref).getTime();
  const days = ageMs / 86_400_000;
  if (days <= 0) return 1;
  return Math.max(0, 1 - days / 90);
}

/**
 * Convert FTS5 BM25 rank (lower = better) to a 0..1 score (higher = better).
 * FTS5 rank is unbounded, but for personal-scale corpora it almost never
 * exceeds 20. Apply a soft saturating transform.
 */
function normalizeBm25(rank: number): number {
  if (rank <= 0) return 1;
  return 1 / (1 + rank / 5);
}

/**
 * Half-life to per-day decay factor.  e.g. halfLife=30 → 0.977.
 */
function halfLifeToDecay(halfLifeDays: number): number {
  return Math.pow(0.5, 1 / halfLifeDays);
}
