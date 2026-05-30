/**
 * File Operations Tracker
 *
 * Tracks file operations (read, write, edit, delete) performed during
 * an agent session for context awareness and compaction decisions.
 */

/**
 * Tracks file operations for context awareness.
 */
export class FileOperationsTracker {
  private reads = new Set<string>();
  private writes = new Set<string>();
  private edits = new Set<string>();
  private deletes = new Set<string>();

  /**
   * Track a file read operation.
   */
  trackRead(filePath: string): void {
    this.reads.add(filePath);
  }

  /**
   * Track a file write operation.
   */
  trackWrite(filePath: string): void {
    this.writes.add(filePath);
    // Write implies the file was read first
    this.reads.add(filePath);
  }

  /**
   * Track a file edit operation.
   */
  trackEdit(filePath: string): void {
    this.edits.add(filePath);
    // Edit implies the file was read first
    this.reads.add(filePath);
  }

  /**
   * Track a file delete operation.
   */
  trackDelete(filePath: string): void {
    this.deletes.add(filePath);
  }

  /**
   * Get all read files.
   */
  getReads(): Set<string> {
    return new Set(this.reads);
  }

  /**
   * Get all written files.
   */
  getWrites(): Set<string> {
    return new Set(this.writes);
  }

  /**
   * Get all edited files.
   */
  getEdits(): Set<string> {
    return new Set(this.edits);
  }

  /**
   * Get all deleted files.
   */
  getDeletes(): Set<string> {
    return new Set(this.deletes);
  }

  /**
   * Get all modified files (writes + edits).
   */
  getModified(): Set<string> {
    return new Set([...this.writes, ...this.edits]);
  }

  /**
   * Get all touched files (reads + writes + edits + deletes).
   */
  getAllTouched(): Set<string> {
    return new Set([...this.reads, ...this.writes, ...this.edits, ...this.deletes]);
  }

  /**
   * Get operation summary.
   */
  getSummary(): {
    reads: number;
    writes: number;
    edits: number;
    deletes: number;
    total: number;
  } {
    return {
      reads: this.reads.size,
      writes: this.writes.size,
      edits: this.edits.size,
      deletes: this.deletes.size,
      total: this.reads.size + this.writes.size + this.edits.size + this.deletes.size,
    };
  }

  /**
   * Check if a file was modified (written or edited).
   */
  wasModified(filePath: string): boolean {
    return this.writes.has(filePath) || this.edits.has(filePath);
  }

  /**
   * Check if a file was touched (any operation).
   */
  wasTouched(filePath: string): boolean {
    return (
      this.reads.has(filePath) ||
      this.writes.has(filePath) ||
      this.edits.has(filePath) ||
      this.deletes.has(filePath)
    );
  }

  /**
   * Get files modified since a given timestamp.
   * (All operations are recorded with current time, so this returns all
   * operations for now - can be extended with timestamps if needed.)
   */
  getModifiedSince(_since: number): string[] {
    return Array.from(this.getModified());
  }

  /**
   * Reset all tracking.
   */
  reset(): void {
    this.reads.clear();
    this.writes.clear();
    this.edits.clear();
    this.deletes.clear();
  }

  /**
   * Clone the tracker state (for subagent fork).
   */
  clone(): FileOperationsTracker {
    const clone = new FileOperationsTracker();
    for (const f of this.reads) clone.trackRead(f);
    for (const f of this.writes) clone.trackWrite(f);
    for (const f of this.edits) clone.trackEdit(f);
    for (const f of this.deletes) clone.trackDelete(f);
    return clone;
  }
}

// Singleton instance
let _instance: FileOperationsTracker | null = null;

/**
 * Get the global file operations tracker.
 */
export function getFileOperationsTracker(): FileOperationsTracker {
  if (!_instance) {
    _instance = new FileOperationsTracker();
  }
  return _instance;
}
