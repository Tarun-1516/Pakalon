/**
 * Context Management Module
 *
 * Provides content replacement tracking, system prompt caching,
 * file state caching, and file operation tracking for context management.
 */

export { ContentReplacementState, cloneContentReplacementState, type ReplacementRecord } from './contentReplacementState.js';
export { RenderedSystemPrompt } from './renderedSystemPrompt.js';
export { FileStateCache, getFileStateCache, type FileState } from './fileStateCache.js';
export { FileOperationsTracker, getFileOperationsTracker } from './fileOperations.js';
