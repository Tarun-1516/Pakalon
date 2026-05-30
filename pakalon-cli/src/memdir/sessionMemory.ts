/**
 * Session Memory
 *
 * Short-term, session-scoped memory with TTL-based expiration.
 * Useful for storing temporary context that doesn't need to persist
 * beyond the current session.
 */

/**
 * A single memory entry.
 */
interface MemoryEntry {
  key: string;
  value: string;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * Options for session memory.
 */
interface SessionMemoryOptions {
  /** TTL in milliseconds (default: 1 hour) */
  ttlMs?: number;
  /** Maximum entries (default: 500) */
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Session-scoped memory with TTL expiration.
 */
export class SessionMemory {
  private entries = new Map<string, MemoryEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options?: SessionMemoryOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Store a value in session memory.
   */
  set(key: string, value: string, options?: { ttl?: number }): void {
    // Evict if at capacity
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      this.evictOldest();
    }

    const now = Date.now();
    const ttl = options?.ttl ?? this.ttlMs;

    this.entries.set(key, {
      key,
      value,
      createdAt: now,
      expiresAt: ttl > 0 ? now + ttl : null,
    });
  }

  /**
   * Retrieve a value from session memory.
   * Returns null if not found or expired.
   */
  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    // Check expiration
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }

    return entry.value;
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete a key from session memory.
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get all keys (excluding expired).
   */
  getKeys(): string[] {
    this.evictExpired();
    return Array.from(this.entries.keys());
  }

  /**
   * Get all entries (excluding expired).
   */
  getEntries(): Array<{ key: string; value: string; createdAt: number; expiresAt: number | null }> {
    this.evictExpired();
    return Array.from(this.entries.values()).map((e) => ({
      key: e.key,
      value: e.value,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
    }));
  }

  /**
   * Get the number of entries (excluding expired).
   */
  getSize(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /**
   * Evict expired entries.
   */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Evict the oldest entry.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }
}

// Singleton per session
let _sessionMemory: SessionMemory | null = null;

/**
 * Get the global session memory instance.
 */
export function getSessionMemory(): SessionMemory {
  if (!_sessionMemory) {
    _sessionMemory = new SessionMemory();
  }
  return _sessionMemory;
}

/**
 * Reset the global session memory.
 */
export function resetSessionMemory(): void {
  _sessionMemory = null;
}
