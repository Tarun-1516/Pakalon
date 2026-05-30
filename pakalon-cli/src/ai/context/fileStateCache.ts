/**
 * File State Cache
 *
 * Caches file contents and hashes for change detection.
 * Avoids re-reading files that haven't changed since last read.
 */

import logger from '@/utils/logger.js';

/**
 * Cached file state.
 */
export interface FileState {
  content: string;
  hash: string;
  lastAccessed: number;
  size: number;
}

/**
 * File state cache with LRU eviction and TTL expiration.
 */
export class FileStateCache {
  private cache = new Map<string, FileState>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options?: { maxSize?: number; ttlMs?: number }) {
    this.maxSize = options?.maxSize ?? 1000;
    this.ttlMs = options?.ttlMs ?? 10 * 60 * 1000; // 10 minutes
  }

  /**
   * Cache a file's state.
   */
  set(filePath: string, content: string, hash: string): void {
    // Evict if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(filePath)) {
      this.evictLRU();
    }

    this.cache.set(filePath, {
      content,
      hash,
      lastAccessed: Date.now(),
      size: content.length,
    });
  }

  /**
   * Get a cached file state.
   */
  get(filePath: string): FileState | null {
    const state = this.cache.get(filePath);
    if (!state) return null;

    // Check TTL
    if (Date.now() - state.lastAccessed > this.ttlMs) {
      this.cache.delete(filePath);
      return null;
    }

    // Update access time
    state.lastAccessed = Date.now();
    return state;
  }

  /**
   * Check if a file has changed based on its hash.
   */
  hasChanged(filePath: string, currentHash: string): boolean {
    const state = this.cache.get(filePath);
    if (!state) return true; // Not cached = assume changed
    return state.hash !== currentHash;
  }

  /**
   * Invalidate a cached file.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Invalidate all cached files.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Get all cached file states.
   */
  getFileStates(): Map<string, FileState> {
    return new Map(this.cache);
  }

  /**
   * Get cache stats.
   */
  getStats(): {
    size: number;
    maxSize: number;
    totalSizeBytes: number;
  } {
    let totalSizeBytes = 0;
    for (const state of this.cache.values()) {
      totalSizeBytes += state.size;
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      totalSizeBytes,
    };
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, state] of this.cache) {
      if (state.lastAccessed < oldestTime) {
        oldestTime = state.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

// Singleton instance
let _instance: FileStateCache | null = null;

/**
 * Get the global file state cache.
 */
export function getFileStateCache(): FileStateCache {
  if (!_instance) {
    _instance = new FileStateCache();
  }
  return _instance;
}
