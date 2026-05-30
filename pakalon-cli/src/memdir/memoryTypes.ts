/**
 * Memory Types
 *
 * Typed memory categories for organized memory management.
 * Different memory types have different lifecycle and retrieval patterns.
 */

import type { MemoryFile } from './memdir.js';

/**
 * Memory type enumeration.
 */
export type MemoryType = 'project' | 'session' | 'team' | 'user' | 'agent';

/**
 * Typed memory file extending the base MemoryFile.
 */
export interface TypedMemoryFile extends MemoryFile {
  type: MemoryType;
  scope: string;
  tags: string[];
}

/**
 * Create a typed memory file.
 */
export function createTypedMemory(
  path: string,
  content: string,
  type: MemoryType,
  scope: string,
  tags: string[] = [],
): TypedMemoryFile {
  return {
    path,
    content,
    lastModified: Date.now(),
    size: content.length,
    type,
    scope,
    tags,
  };
}

/**
 * Infer memory type from file path patterns.
 */
export function getMemoryTypeFromPath(filePath: string): MemoryType {
  const lower = filePath.toLowerCase();

  // Project-level files
  if (lower.includes('claudemd') || lower.includes('pakalon.md') || lower.includes('project.md')) {
    return 'project';
  }

  // Team files
  if (lower.includes('team') || lower.includes('shared')) {
    return 'team';
  }

  // Session files
  if (lower.includes('session') || lower.includes('conversation')) {
    return 'session';
  }

  // User-specific files
  if (lower.includes('user') || lower.includes('personal') || lower.includes('preferences')) {
    return 'user';
  }

  // Agent-specific files
  if (lower.includes('agent') || lower.includes('context')) {
    return 'agent';
  }

  // Default to project
  return 'project';
}

/**
 * Get the scope for a memory type.
 */
export function getMemoryScope(type: MemoryType, projectRoot: string): string {
  switch (type) {
    case 'project':
      return projectRoot;
    case 'session':
      return `session:${Date.now()}`;
    case 'team':
      return 'team';
    case 'user':
      return 'user';
    case 'agent':
      return 'agent';
    default:
      return projectRoot;
  }
}

/**
 * Filter memories by type.
 */
export function filterByType(
  memories: TypedMemoryFile[],
  type: MemoryType,
): TypedMemoryFile[] {
  return memories.filter((m) => m.type === type);
}

/**
 * Filter memories by tag.
 */
export function filterByTag(
  memories: TypedMemoryFile[],
  tag: string,
): TypedMemoryFile[] {
  return memories.filter((m) => m.tags.includes(tag));
}

/**
 * Get all unique tags from a set of memories.
 */
export function getAllTags(memories: TypedMemoryFile[]): string[] {
  const tags = new Set<string>();
  for (const m of memories) {
    for (const tag of m.tags) {
      tags.add(tag);
    }
  }
  return Array.from(tags).sort();
}
