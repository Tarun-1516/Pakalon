/**
 * Smoke test for the Hindsight memory engine.
 * Runs end-to-end: retain 3 facts, recall, auto-reflect, consolidate, snapshot.
 */
import { HindsightEngine } from "./hindsight-engine.js";
import { TfidfEmbedder, tokenize, fnv1a32 } from "./hindsight-embeddings.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

async function main(): Promise<void> {
  // 1) Tokenizer is stable and useful.
  const tokens = tokenize("The user prefers TypeScript over JavaScript for backend code.");
  assert(tokens.includes("typescript"), "tokenizer keeps content words");
  assert(!tokens.includes("the"), "tokenizer drops stop words");

  // 2) Embedder produces 256-dim unit vectors.
  const emb = new TfidfEmbedder();
  const v = emb.embed("hello world hello");
  assert(v.length === 256, "vector is 256-dim");
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  assert(Math.abs(Math.sqrt(norm) - 1) < 1e-5, "vector is L2-normalized");
  assert(v[fnv1a32("hello") % 256] > 0, "nonzero coordinate at expected bucket");

  // 3) Engine: retain / recall.
  const eng = new HindsightEngine({
    userId: "smoke-user",
    memory: true,
    decayHalfLifeDays: 30,
  });
  const a = eng.retain({
    content: "User prefers TypeScript strict mode with noUncheckedIndexedAccess.",
    kind: "preference",
    tags: ["tsconfig", "style"],
    importance: 0.8,
  });
  const b = eng.retain({
    content: "Project uses PostgreSQL 16 with the pgvector extension for embeddings.",
    kind: "fact",
    tags: ["db", "infra"],
    importance: 0.7,
  });
  const c = eng.retain({
    content: "Always run `bun run test` before committing TypeScript changes.",
    kind: "rule",
    tags: ["workflow"],
    importance: 0.9,
  });

  assert(a.id.length === 32, "id is content-hash 32 chars");
  assert(b.id !== c.id, "different content → different id");

  // Dedup: retain same content returns same row, bumps importance.
  const dup = eng.retain({ content: a.content });
  assert(dup.id === a.id, "duplicate retain dedupes to same id");
  assert(dup.importance >= a.importance, "duplicate retain bumps importance");

  // Recall — should find at least one hit.
  const hits = eng.recall({ query: "TypeScript strict mode", topK: 5 });
  assert(hits.length >= 1, "recall returns at least 1 hit");
  if (hits.length > 0) {
    assert(hits[0].memory.content.includes("TypeScript"), "top hit is the TypeScript memory");
    assert(hits[0].vectorScore > 0, "vector score is positive");
    assert(hits[0].reasons.length > 0, "hit has explainable reasons");
  }

  // Recall with scope filter.
  const projectHits = eng.recall({
    query: "TypeScript",
    topK: 5,
    scope: "project",
  });
  assert(projectHits.every((h) => h.memory.scope === "project"), "scope filter works");

  // Auto-reflect.
  const mm = eng.autoReflect("session-1", "Discussed TS strict mode and PG setup", 12, 60_000);
  assert(mm.sessionId === "session-1", "mental model has sessionId");
  assert(mm.messageCount === 12, "mental model has messageCount");

  // Snapshot / restore.
  const snap = eng.snapshot();
  assert(snap.version === 1, "snapshot has version 1");
  assert(snap.memories.length >= 3, "snapshot has at least 3 memories");
  assert(Array.isArray(snap.idf) && snap.idf.length === 256, "snapshot serializes IDF");

  // Restore into a fresh engine.
  const eng2 = new HindsightEngine({ userId: "smoke-user", memory: true });
  const restored = eng2.restore(snap, { wipe: true });
  assert(restored >= 3, "restore inserts memories");
  const reHits = eng2.recall({ query: "PostgreSQL pgvector", topK: 3 });
  assert(reHits.some((h) => h.memory.content.includes("pgvector")), "restored engine can recall");

  // Consolidate — should not throw, should scan.
  const c2 = eng.consolidate();
  assert(c2.scanned >= 3, "consolidate scans all memories");

  // Forget.
  const forgot = eng.forget(c.id, "test");
  assert(forgot, "forget deletes the row");
  assert(eng.store.getMemory(c.id) === null, "forgotten memory is gone");

  // 4) Cleanup.
  eng.close();
  eng2.close();

  console.log(`\nSummary: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

await main();
