/**
 * Hindsight memory storage layer — bun:sqlite with FTS5 + vector BLOB.
 *
 * Schema:
 *   - memories: canonical row per memory (one memory = one row)
 *   - memories_fts: FTS5 virtual table mirroring content for fast recall
 *   - links: many-to-many graph (memoryId <-> otherMemoryId, type)
 *   - access_log: append-only history of every recall/forget operation
 *   - mental_models: compressed per-session summaries
 *   - mnemopi_sync: pending outbox rows waiting to push to remote mnemopi
 *
 * The store is intentionally narrow: it persists bytes, runs queries,
 * and returns plain JSON-able rows. The engine (`hindsight-engine.ts`)
 * owns the policy (importance decay, hybrid scoring, etc.) on top of
 * this raw storage.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database, type Statement } from "bun:sqlite";
import {
  TfidfEmbedder,
  emptyVectorBlob,
  packVector,
  unpackVector,
  type EmbedderOptions,
} from "./hindsight-embeddings.js";

// ---------------------------------------------------------------------------
// Row / API types
// ---------------------------------------------------------------------------

export type MemoryKind = "fact" | "summary" | "preference" | "rule" | "link" | "mental_model";
export type MemoryScope = "global" | "project" | "tagged" | "session";

export interface MemoryRow {
  id: string;
  userId: string;
  sessionId: string | null;
  projectPath: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  tags: string;            // JSON string[]
  links: string;           // JSON string[] of other memory ids
  importance: number;      // 0..1
  confidence: number;      // 0..1 (e.g. user-confirmed > inferred)
  embedding: Float32Array; // 256-dim unit vector
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Packed Float32Array BLOB mirror used for fast cosine scans in SQL. */
  embeddingBytes: Buffer;
}

export interface InsertMemoryInput {
  id: string;
  userId: string;
  sessionId?: string | null;
  projectPath?: string | null;
  scope?: MemoryScope;
  kind?: MemoryKind;
  content: string;
  tags?: string[];
  links?: string[];
  importance?: number;
  confidence?: number;
  embedding: Float32Array;
}

export interface LinkRow {
  fromId: string;
  toId: string;
  type: string;            // "supports" | "contradicts" | "supersedes" | "related"
  weight: number;
  createdAt: string;
}

export interface MentalModelRow {
  id: string;
  userId: string;
  sessionId: string;
  summary: string;
  keyFindings: string;     // JSON string[]
  projectInsights: string; // JSON string[]
  messageCount: number;
  durationMs: number;
  createdAt: string;
}

export interface AccessLogRow {
  id: number;
  memoryId: string;
  userId: string;
  op: "recall" | "retain" | "update" | "forget" | "consolidate";
  score: number | null;
  note: string | null;
  at: string;
}

export interface MnemopiOutboxRow {
  id: number;
  memoryId: string;
  userId: string;
  op: "push" | "delete";
  payload: string;         // JSON snapshot
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Schema (idempotent)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  userId          TEXT NOT NULL,
  sessionId       TEXT,
  projectPath     TEXT,
  scope           TEXT NOT NULL DEFAULT 'global',
  kind            TEXT NOT NULL DEFAULT 'fact',
  content         TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  links           TEXT NOT NULL DEFAULT '[]',
  importance      REAL NOT NULL DEFAULT 0.5,
  confidence      REAL NOT NULL DEFAULT 0.5,
  embedding       BLOB NOT NULL,
  accessCount     INTEGER NOT NULL DEFAULT 0,
  lastAccessedAt  TEXT,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_user        ON memories(userId);
CREATE INDEX IF NOT EXISTS idx_memories_session     ON memories(sessionId);
CREATE INDEX IF NOT EXISTS idx_memories_project     ON memories(projectPath);
CREATE INDEX IF NOT EXISTS idx_memories_scope       ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_kind        ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_importance  ON memories(importance DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- FTS triggers keep the virtual table in sync with the base table.
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS links (
  fromId    TEXT NOT NULL,
  toId      TEXT NOT NULL,
  type      TEXT NOT NULL,
  weight    REAL NOT NULL DEFAULT 1.0,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (fromId, toId, type)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(toId);

CREATE TABLE IF NOT EXISTS access_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  memoryId  TEXT NOT NULL,
  userId    TEXT NOT NULL,
  op        TEXT NOT NULL,
  score     REAL,
  note      TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_log_memory ON access_log(memoryId, at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_user   ON access_log(userId, at DESC);

CREATE TABLE IF NOT EXISTS mental_models (
  id              TEXT PRIMARY KEY,
  userId          TEXT NOT NULL,
  sessionId       TEXT NOT NULL,
  summary         TEXT NOT NULL,
  keyFindings     TEXT NOT NULL DEFAULT '[]',
  projectInsights TEXT NOT NULL DEFAULT '[]',
  messageCount    INTEGER NOT NULL DEFAULT 0,
  durationMs      INTEGER NOT NULL DEFAULT 0,
  createdAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mental_models_user_session
  ON mental_models(userId, sessionId, createdAt DESC);

CREATE TABLE IF NOT EXISTS mnemopi_outbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  memoryId       TEXT NOT NULL,
  userId         TEXT NOT NULL,
  op             TEXT NOT NULL,
  payload        TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lastError      TEXT,
  nextAttemptAt  TEXT NOT NULL,
  createdAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON mnemopi_outbox(nextAttemptAt);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface HindsightStoreOptions {
  /** Override the database file path. Defaults to ~/.config/pakalon/memory/hindsight.db. */
  persistPath?: string;
  /** In-memory mode (for tests / ephemeral sessions). Overrides persistPath. */
  memory?: boolean;
  embedder?: EmbedderOptions;
  /** Open in read-only mode. */
  readonly?: boolean;
}

export class HindsightStore {
  readonly db: Database;
  readonly path: string;
  readonly memory: boolean;
  readonly embedder: TfidfEmbedder;

  // Prepared statements (cached for speed)
  private stmts: Record<string, Statement> = {};

  constructor(opts: HindsightStoreOptions = {}) {
    if (opts.memory) {
      this.path = ":memory:";
      this.memory = true;
    } else {
      const configDir = process.env.PAKALON_CONFIG_DIR
        ?? path.join(os.homedir(), ".config", "pakalon");
      const memDir = opts.persistPath ?? path.join(configDir, "memory");
      if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
      this.path = path.join(memDir, "hindsight.db");
      this.memory = false;
    }

    this.db = new Database(this.path, opts.readonly ? { readonly: true } : undefined);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);

    this.embedder = new TfidfEmbedder(opts.embedder);
    this.prepare();
  }

  // -------------------------------------------------------------------------
  // Statement cache
  // -------------------------------------------------------------------------

  private prepare(): void {
    this.stmts.insertMemory = this.db.prepare(`
      INSERT OR REPLACE INTO memories
        (id, userId, sessionId, projectPath, scope, kind, content, tags, links,
         importance, confidence, embedding, accessCount, lastAccessedAt, createdAt, updatedAt)
      VALUES
        ($id, $userId, $sessionId, $projectPath, $scope, $kind, $content, $tags, $links,
         $importance, $confidence, $embedding, $accessCount, $lastAccessedAt, $createdAt, $updatedAt)
    `);
    this.stmts.getMemory = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    this.stmts.deleteMemory = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    this.stmts.bumpAccess = this.db.prepare(`
      UPDATE memories SET accessCount = accessCount + 1, lastAccessedAt = ? WHERE id = ?
    `);
    this.stmts.allForUser = this.db.prepare(`
      SELECT * FROM memories WHERE userId = ? ORDER BY importance DESC, createdAt DESC LIMIT ?
    `);
    this.stmts.ftsSearch = this.db.prepare(`
      SELECT m.*, bm25(memories_fts) AS rank
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.userId = ?
      ORDER BY rank ASC LIMIT ?
    `);
    this.stmts.upsertLink = this.db.prepare(`
      INSERT OR REPLACE INTO links (fromId, toId, type, weight, createdAt)
      VALUES ($fromId, $toId, $type, $weight, $createdAt)
    `);
    this.stmts.linksFor = this.db.prepare(`SELECT * FROM links WHERE fromId = ? OR toId = ?`);
    this.stmts.deleteLink = this.db.prepare(`
      DELETE FROM links WHERE (fromId = $a AND toId = $b) OR (fromId = $b AND toId = $a)
    `);
    this.stmts.insertAccess = this.db.prepare(`
      INSERT INTO access_log (memoryId, userId, op, score, note, at)
      VALUES ($memoryId, $userId, $op, $score, $note, $at)
    `);
    this.stmts.recentAccess = this.db.prepare(`
      SELECT * FROM access_log WHERE memoryId = ? ORDER BY at DESC LIMIT ?
    `);
    this.stmts.upsertMentalModel = this.db.prepare(`
      INSERT OR REPLACE INTO mental_models
        (id, userId, sessionId, summary, keyFindings, projectInsights, messageCount, durationMs, createdAt)
      VALUES
        ($id, $userId, $sessionId, $summary, $keyFindings, $projectInsights, $messageCount, $durationMs, $createdAt)
    `);
    this.stmts.getMentalModel = this.db.prepare(`
      SELECT * FROM mental_models WHERE id = ?
    `);
    this.stmts.listMentalModels = this.db.prepare(`
      SELECT * FROM mental_models WHERE userId = ? ORDER BY createdAt DESC LIMIT ?
    `);
    this.stmts.enqueueOutbox = this.db.prepare(`
      INSERT INTO mnemopi_outbox
        (memoryId, userId, op, payload, attempts, lastError, nextAttemptAt, createdAt)
      VALUES
        ($memoryId, $userId, $op, $payload, 0, NULL, $nextAttemptAt, $createdAt)
    `);
    this.stmts.outboxDue = this.db.prepare(`
      SELECT * FROM mnemopi_outbox
      WHERE nextAttemptAt <= ? ORDER BY nextAttemptAt ASC LIMIT ?
    `);
    this.stmts.outboxMark = this.db.prepare(`
      UPDATE mnemopi_outbox
      SET attempts = attempts + 1, lastError = $lastError, nextAttemptAt = $nextAttemptAt
      WHERE id = $id
    `);
    this.stmts.outboxDelete = this.db.prepare(`DELETE FROM mnemopi_outbox WHERE id = ?`);
    this.stmts.outboxCount = this.db.prepare(`SELECT COUNT(*) AS c FROM mnemopi_outbox`);
    this.stmts.metaGet = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
    this.stmts.metaSet = this.db.prepare(`
      INSERT OR REPLACE INTO meta (key, value) VALUES ($key, $value)
    `);
  }

  // -------------------------------------------------------------------------
  // Memories CRUD
  // -------------------------------------------------------------------------

  insertMemory(input: InsertMemoryInput): MemoryRow {
    const now = new Date().toISOString();
    const row: MemoryRow = {
      id: input.id,
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      projectPath: input.projectPath ?? null,
      scope: input.scope ?? "global",
      kind: input.kind ?? "fact",
      content: input.content,
      tags: JSON.stringify(input.tags ?? []),
      links: JSON.stringify(input.links ?? []),
      importance: clamp01(input.importance ?? 0.5),
      confidence: clamp01(input.confidence ?? 0.5),
      embedding: input.embedding,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: now,
      updatedAt: now,
      embeddingBytes: packVector(input.embedding),
    };
    this.stmts.insertMemory.run({
      $id: row.id,
      $userId: row.userId,
      $sessionId: row.sessionId,
      $projectPath: row.projectPath,
      $scope: row.scope,
      $kind: row.kind,
      $content: row.content,
      $tags: row.tags,
      $links: row.links,
      $importance: row.importance,
      $confidence: row.confidence,
      $embedding: row.embeddingBytes,
      $accessCount: row.accessCount,
      $lastAccessedAt: row.lastAccessedAt,
      $createdAt: row.createdAt,
      $updatedAt: row.updatedAt,
    });
    this.stmts.insertAccess.run({
      $memoryId: row.id,
      $userId: row.userId,
      $op: "retain",
      $score: null,
      $note: null,
      $at: now,
    });
    return row;
  }

  getMemory(id: string): MemoryRow | null {
    const r = this.stmts.getMemory.get(id) as any;
    return r ? rowFromSqlite(r) : null;
  }

  deleteMemory(id: string): boolean {
    const r = this.stmts.deleteMemory.run(id);
    return r.changes > 0;
  }

  bumpAccess(id: string): void {
    this.stmts.bumpAccess.run(new Date().toISOString(), id);
  }

  listForUser(userId: string, limit = 200): MemoryRow[] {
    return (this.stmts.allForUser.all(userId, limit) as any[]).map(rowFromSqlite);
  }

  /**
   * Full-text search via FTS5. Returns rows + BM25 rank (lower = better).
   */
  ftsSearch(query: string, userId: string, limit = 20): Array<MemoryRow & { rank: number }> {
    if (!query.trim()) return [];
    // Wrap in double quotes if the user used punctuation that would break
    // the FTS5 parser; otherwise let porter+unicode61 handle it.
    const ftsQuery = escapeFtsQuery(query);
    return (this.stmts.ftsSearch.all(ftsQuery, userId, limit) as any[]).map((r) => ({
      ...rowFromSqlite(r),
      rank: r.rank,
    }));
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  upsertLink(from: string, to: string, type: string, weight = 1.0): void {
    this.stmts.upsertLink.run({
      $fromId: from,
      $toId: to,
      $type: type,
      $weight: weight,
      $createdAt: new Date().toISOString(),
    });
  }

  linksFor(id: string): LinkRow[] {
    return this.stmts.linksFor.all(id, id) as LinkRow[];
  }

  deleteLink(a: string, b: string): void {
    this.stmts.deleteLink.run({ $a: a, $b: b });
  }

  // -------------------------------------------------------------------------
  // Access log
  // -------------------------------------------------------------------------

  logAccess(memoryId: string, userId: string, op: AccessLogRow["op"], score?: number, note?: string): void {
    this.stmts.insertAccess.run({
      $memoryId: memoryId,
      $userId: userId,
      $op: op,
      $score: score ?? null,
      $note: note ?? null,
      $at: new Date().toISOString(),
    });
  }

  recentAccess(memoryId: string, limit = 20): AccessLogRow[] {
    return this.stmts.recentAccess.all(memoryId, limit) as AccessLogRow[];
  }

  // -------------------------------------------------------------------------
  // Mental models
  // -------------------------------------------------------------------------

  upsertMentalModel(input: Omit<MentalModelRow, "createdAt"> & { createdAt?: string }): MentalModelRow {
    const row: MentalModelRow = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    } as MentalModelRow;
    this.stmts.upsertMentalModel.run({
      $id: row.id,
      $userId: row.userId,
      $sessionId: row.sessionId,
      $summary: row.summary,
      $keyFindings: row.keyFindings,
      $projectInsights: row.projectInsights,
      $messageCount: row.messageCount,
      $durationMs: row.durationMs,
      $createdAt: row.createdAt,
    });
    return row;
  }

  getMentalModel(id: string): MentalModelRow | null {
    return (this.stmts.getMentalModel.get(id) as MentalModelRow) ?? null;
  }

  listMentalModels(userId: string, limit = 20): MentalModelRow[] {
    return this.stmts.listMentalModels.all(userId, limit) as MentalModelRow[];
  }

  // -------------------------------------------------------------------------
  // Mnemopi outbox
  // -------------------------------------------------------------------------

  enqueueOutbox(memoryId: string, userId: string, op: "push" | "delete", payload: unknown, delayMs = 0): number {
    const now = new Date();
    const next = new Date(now.getTime() + Math.max(0, delayMs));
    const r = this.stmts.enqueueOutbox.run({
      $memoryId: memoryId,
      $userId: userId,
      $op: op,
      $payload: JSON.stringify(payload),
      $nextAttemptAt: next.toISOString(),
      $createdAt: now.toISOString(),
    });
    return Number(r.lastInsertRowid);
  }

  outboxDue(now: Date, limit = 50): MnemopiOutboxRow[] {
    return this.stmts.outboxDue.all(now.toISOString(), limit) as MnemopiOutboxRow[];
  }

  outboxMark(id: number, lastError: string, nextAttemptAt: Date): void {
    this.stmts.outboxMark.run({
      $id: id,
      $lastError: lastError.slice(0, 1000),
      $nextAttemptAt: nextAttemptAt.toISOString(),
    });
  }

  outboxDelete(id: number): void {
    this.stmts.outboxDelete.run(id);
  }

  outboxCount(): number {
    return (this.stmts.outboxCount.get() as { c: number }).c;
  }

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  metaGet(key: string): string | null {
    const r = this.stmts.metaGet.get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  metaSet(key: string, value: string): void {
    this.stmts.metaSet.run({ $key: key, $value: value });
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Vacuum the DB and rebuild the FTS index. */
  optimize(): void {
    this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');");
    this.db.exec("ANALYZE;");
  }

  close(): void {
    this.db.close();
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

/**
 * Convert a SQLite row into a typed MemoryRow.
 * Unpacks the embedding BLOB into a Float32Array and parses JSON fields.
 */
export function rowFromSqlite(r: any): MemoryRow {
  return {
    id: r.id,
    userId: r.userId,
    sessionId: r.sessionId ?? null,
    projectPath: r.projectPath ?? null,
    scope: r.scope as MemoryScope,
    kind: r.kind as MemoryKind,
    content: r.content,
    tags: typeof r.tags === "string" ? r.tags : JSON.stringify(r.tags ?? []),
    links: typeof r.links === "string" ? r.links : JSON.stringify(r.links ?? []),
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    embedding: unpackVector(r.embedding ?? emptyVectorBlob()),
    embeddingBytes: Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding ?? emptyVectorBlob()),
    accessCount: Number(r.accessCount ?? 0),
    lastAccessedAt: r.lastAccessedAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Escape a free-form user query for FTS5 MATCH.
 * Splits on whitespace, wraps each token in double quotes, and joins
 * with AND. Drops FTS5 operators that could be abused.
 */
export function escapeFtsQuery(q: string): string {
  const cleaned = q
    .replace(/[^a-zA-Z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => `"${t}"`)
    .join(" AND ");
  return cleaned || '""';
}
