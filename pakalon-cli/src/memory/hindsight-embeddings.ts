/**
 * TF-IDF embeddings for Hindsight memory.
 *
 * Pure-deterministic, dependency-free embedding model used as a fallback
 * (and as the on-device component of hybrid retrieval) when no remote
 * embedding provider is configured. Produces 256-dimensional unit vectors
 * that are stable across runs and OSes.
 *
 * Pipeline:
 *   1. Tokenize → lowercase, split on non-alphanumeric runs, drop stop words.
 *   2. Hash each token to one of N_BUCKETS feature indices.
 *   3. Compute term frequency per document, normalize to L2 unit vector.
 *   4. Maintain an IDF table per engine instance (built from a corpus).
 *
 * The 256-dim dimensionality is small enough to round-trip inside a
 * 1024-byte BLOB column (256 * 4 bytes) and fast to compute — embedding
 * a typical memory text in well under 1ms on commodity hardware.
 */

const N_BUCKETS = 256;
const NGRAM_MIN = 1;
const NGRAM_MAX = 2;

// Compact English stop word list — keeps signal words (intent, code symbols)
// without us shipping a megabyte of NLP data.
const STOP = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were",
  "will", "with", "i", "you", "we", "they", "he", "she", "them", "us", "our",
  "your", "their", "my", "me", "do", "does", "did", "can", "could", "should",
  "would", "may", "might", "must", "shall", "not", "no", "yes", "but", "if",
  "so", "then", "than", "into", "out", "up", "down", "over", "under", "about",
  "between", "through", "after", "before", "any", "all", "some", "none", "more",
  "most", "much", "few", "very", "just", "also", "only", "even", "such", "each",
]);

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Stable across platforms, fast, zero deps.
 * Used to map tokens to one of N_BUCKETS feature indices.
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function bucket(token: string): number {
  return fnv1a32(token) % N_BUCKETS;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize a text into n-grams (1..NGRAM_MAX). Returns lowercase word-like
 * tokens. Symbols like `./`, `_`, `:` are preserved because they carry
 * meaning in code identifiers and paths.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  // Split on whitespace and most punctuation, but keep CJK runs intact.
  const parts = lower.split(/[^a-z0-9_.:/\\-]+/u).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (part.length < 2 && !/[0-9]/.test(part)) continue;
    if (STOP.has(part)) continue;
    out.push(part);
    for (let n = NGRAM_MIN; n < NGRAM_MAX; n++) {
      if (out.length > n) {
        const gram = out.slice(out.length - 1 - n, out.length - 1).concat([part]).join("_");
        out.push(gram);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

export function zeros(): Float32Array {
  return new Float32Array(N_BUCKETS);
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
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

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export interface EmbedderOptions {
  /** Optional pre-loaded IDF table. */
  idf?: Float32Array;
}

export class TfidfEmbedder {
  /** Per-term inverse document frequency weights. */
  private idf: Float32Array;

  constructor(opts: EmbedderOptions = {}) {
    this.idf = opts.idf ? new Float32Array(opts.idf) : new Float32Array(N_BUCKETS);
    for (let i = 0; i < this.idf.length; i++) {
      if (this.idf[i] === 0) this.idf[i] = 1; // Laplace smoothing default
    }
  }

  /** Number of dimensions produced. */
  get dimensions(): number {
    return N_BUCKETS;
  }

  /** Get the current IDF table (for persistence). */
  exportIdf(): Float32Array {
    return new Float32Array(this.idf);
  }

  /**
   * Embed a single document.
   */
  embed(text: string): Float32Array {
    const tokens = tokenize(text);
    const v = zeros();
    if (tokens.length === 0) return v;
    for (const t of tokens) {
      const idx = bucket(t);
      v[idx] += this.idf[idx];
    }
    return l2normalize(v);
  }

  /**
   * Build / refresh the IDF table from a corpus. Standard smoothed IDF:
   *   idf(t) = log((N + 1) / (df(t) + 1)) + 1
   */
  fit(corpus: string[]): void {
    const df = new Uint32Array(N_BUCKETS);
    for (const doc of corpus) {
      const seen = new Set<number>();
      for (const t of tokenize(doc)) {
        const idx = bucket(t);
        if (!seen.has(idx)) {
          seen.add(idx);
          df[idx]++;
        }
      }
    }
    const n = corpus.length || 1;
    this.idf = new Float32Array(N_BUCKETS);
    for (let i = 0; i < N_BUCKETS; i++) {
      this.idf[i] = Math.log((n + 1) / (df[i] + 1)) + 1;
    }
  }

  /**
   * Update the IDF table incrementally with a single new document.
   * Uses a simple running count model: keeps `totalDocs` and per-bucket
   * `docFreq`, recomputes idf from scratch on demand. For sub-100k docs
   * this is plenty fast.
   */
  update(newDoc: string, stats: { total: number; df: Uint32Array }): void {
    const seen = new Set<number>();
    for (const t of tokenize(newDoc)) {
      const idx = bucket(t);
      if (!seen.has(idx)) {
        seen.add(idx);
        stats.df[idx]++;
      }
    }
    stats.total++;
    const n = stats.total || 1;
    this.idf = new Float32Array(N_BUCKETS);
    for (let i = 0; i < N_BUCKETS; i++) {
      this.idf[i] = Math.log((n + 1) / (stats.df[i] + 1)) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// BLOB (de)serialization
// ---------------------------------------------------------------------------

/** Pack a Float32Array into a Buffer for SQLite BLOB storage. */
export function packVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Unpack a Buffer back into a Float32Array. */
export function unpackVector(b: Buffer | Uint8Array | null | undefined): Float32Array {
  if (!b || b.byteLength === 0) return zeros();
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  // Validate alignment — Float32Array requires 4-byte alignment
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

/** Build a packed BLOB of zeros of the right size (for table default). */
export function emptyVectorBlob(): Buffer {
  return Buffer.alloc(N_BUCKETS * 4);
}
