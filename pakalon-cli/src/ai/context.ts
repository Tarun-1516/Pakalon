/**
 * Context manager — builds the message context window.
 * Respects the model's context_length limit by trimming old messages.
 */
import type { ModelMessage as CoreMessage } from "ai";
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// Token estimation constants
// 1 token ≈ 4 chars for natural language, but code has different density
const CHARS_PER_TOKEN_DEFAULT = 4;
const CHARS_PER_TOKEN_CODE = 3.5; // Code is more token-dense
const CHARS_PER_TOKEN_JSON = 2; // JSON with many single-char tokens

// Per-message overhead (role prefix, formatting markers)
const MESSAGE_OVERHEAD_TOKENS = 4;

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (p.type === "tool_result" && typeof p.content === "string") return p.content;
          if (p.type === "tool_use") return `${p.name ?? ""}: ${(p.input ? JSON.stringify(p.input) : "").slice(0, 200)}`;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    return "";
  }
  return "";
}

/**
 * Determine the appropriate chars-per-token ratio based on content type
 */
function getCharsPerToken(text: string): number {
  // Check if content appears to be code or structured data
  const codeIndicators = [
    /^(import|export|const|let|var|function|class|interface|type|enum)\s/m,
    /[{}\[\]();]=>/.test(text), // Programming syntax
    /^\s*(def|class|import|from|if __name__|async def)\s/m, // Python
    /^\s*(func|package|import|struct|interface|type)\s/m, // Go
    /^\s*(fn|let|mut|impl|struct|enum|use)\s/m, // Rust
  ];

  // Check for JSON-like content
  const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');

  if (isJson) {
    return CHARS_PER_TOKEN_JSON;
  }

  // Check for code indicators - if multiple present, likely code
  const codeScore = codeIndicators.filter(indicator =>
    typeof indicator === 'boolean' ? indicator : indicator.test(text)
  ).length;

  return codeScore >= 2 ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_DEFAULT;
}

/**
 * Estimate token count for text content with content-type-aware estimation
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const charsPerToken = getCharsPerToken(text);
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate token count for messages array with improved accuracy
 */
export function estimateMessagesTokens(messages: CoreMessage[]): number {
  if (!messages || messages.length === 0) return 0;

  return messages.reduce((sum, m) => {
    const content = extractTextContent(m.content);
    if (!content) return sum;

    const contentTokens = estimateTokens(content);
    // Add message overhead for role markers and formatting
    return sum + contentTokens + MESSAGE_OVERHEAD_TOKENS;
  }, 0);
}

/**
 * Trim the messages array to fit within `maxTokens` budget,
 * always keeping the first (system) message and last `keepTail` user messages.
 */
export function trimToContextWindow(
  messages: CoreMessage[],
  maxTokens: number,
  keepTail = 4
): CoreMessage[] {
  if (estimateMessagesTokens(messages) <= maxTokens) return messages;

  // Always keep system message (index 0) and last keepTail messages
  const system = messages[0];
  if (!system) return messages;
  const rest = messages.slice(1);
  const tail = rest.slice(-keepTail);
  let budget = maxTokens - estimateMessagesTokens([system, ...tail]);

  const middle = rest.slice(0, -keepTail);
  const kept: CoreMessage[] = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const m = middle[i];
    if (!m) continue;
    const t = estimateMessagesTokens([m]);
    if (budget - t > 0) {
      kept.unshift(m);
      budget -= t;
    } else {
      break;
    }
  }

  return [system, ...kept, ...tail];
}

export interface FileContext {
  filePath: string;
  content: string;
  tokens: number;
}

/**
 * Read a file and return it as a context message string.
 */
export function buildFileContextBlock(filePath: string, maxBytes = 16384): FileContext | null {
  try {
    const abs = path.resolve(filePath);
    const content = fs.readFileSync(abs, "utf-8").slice(0, maxBytes);
    const ext = path.extname(abs).replace(".", "");
    const block = `\`\`\`${ext}\n// File: ${abs}\n${content}\n\`\`\``;
    return { filePath: abs, content: block, tokens: estimateTokens(block) };
  } catch (err) {
    logger.warn("Could not read file for context", { filePath, err: String(err) });
    return null;
  }
}

const MAX_SYSTEM_PROMPT_CHARS = 16000; // ~4000 tokens (1 token ≈ 4 chars)

/**
 * Build a system message that includes file contexts.
 * Caps total size at ~4000 tokens. Truncates oldest contexts first.
 */
export function buildSystemWithContext(
  baseSystem: string,
  fileContexts: FileContext[]
): string {
  if (fileContexts.length === 0) return baseSystem;

  const header = "\n\n## Active File Context\n\n";
  const separator = "\n\n";
  const baseLen = baseSystem.length + header.length;
  let budget = MAX_SYSTEM_PROMPT_CHARS - baseLen;

  const keptBlocks: string[] = [];
  for (let i = 0; i < fileContexts.length; i++) {
    const fileContext = fileContexts[i];
    if (!fileContext) continue;
    const block = fileContext.content;
    const needed = block.length + (keptBlocks.length > 0 ? separator.length : 0);
    if (budget >= needed) {
      keptBlocks.push(block);
      budget -= needed;
    } else if (budget > 100) {
      keptBlocks.push(block.slice(0, budget - 20) + "\n... (truncated)");
      budget = 0;
      break;
    } else {
      break;
    }
  }

  if (keptBlocks.length === 0) return baseSystem;

  const result = `${baseSystem}${header}${keptBlocks.join(separator)}`;
  if (result.length > MAX_SYSTEM_PROMPT_CHARS) {
    return result.slice(0, MAX_SYSTEM_PROMPT_CHARS - 20) + "\n... (truncated)";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Context Stats — real-time token usage reporting
// ---------------------------------------------------------------------------

export interface ContextStats {
  used: number;
  total: number;
  percent: number;
  remaining: number;
  messageCount: number;
}

/**
 * Compute current context window statistics.
 * Emits a `context_stats` event on the global event emitter so the TUI
 * can display a live token usage bar.
 */
export function getContextStats(
  messages: CoreMessage[],
  maxTokens: number
): ContextStats {
  const used = estimateMessagesTokens(messages);
  const percent = Math.min(100, Math.round((used / maxTokens) * 100));
  const stats: ContextStats = {
    used,
    total: maxTokens,
    percent,
    remaining: Math.max(0, maxTokens - used),
    messageCount: messages.length,
  };
  // Emit to global event target so UI components can subscribe
  contextEvents.emit("context_stats", stats);
  return stats;
}

/**
 * Simple typed event emitter for context events.
 * Usage: contextEvents.on("context_stats", (s) => renderBar(s))
 */
class ContextEventEmitter {
  private readonly _listeners = new Map<string, Array<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event)!.push(handler);
    // return unsubscribe
    return () => {
      const arr = this._listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  emit(event: string, payload: unknown): void {
    for (const h of this._listeners.get(event) ?? []) {
      try { h(payload); } catch { /* ignore handler errors */ }
    }
  }
}

export const contextEvents = new ContextEventEmitter();

// ---------------------------------------------------------------------------
// Context Compression — summarize middle messages when context > 80% full
// ---------------------------------------------------------------------------

const COMPRESSION_THRESHOLD = 0.80; // trigger at 80% full

export interface CompressionResult {
  messages: CoreMessage[];
  compressed: boolean;
  savedTokens: number;
  summaryMessageIndex?: number;
}

/**
 * Compress the context window by summarising the middle messages via an LLM call.
 * This keeps the system message and the latest `keepTail` messages intact.
 *
 * @param messages  Current message history
 * @param maxTokens Model context window size
 * @param summarizerFn Callback that receives a block of text and returns a summary.
 *                  Pass your AI stream/generate function here.
 * @param keepTail  Number of recent messages to always preserve (default 6)
 */
export async function compressContext(
  messages: CoreMessage[],
  maxTokens: number,
  summarizerFn: (text: string) => Promise<string>,
  keepTail = 6
): Promise<CompressionResult> {
  const stats = getContextStats(messages, maxTokens);
  if (stats.percent < COMPRESSION_THRESHOLD * 100) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  const system = messages[0];
  if (!system || messages.length < keepTail + 2) {
    // Not enough messages to compress
    return { messages, compressed: false, savedTokens: 0 };
  }

  const tail = messages.slice(-keepTail);
  const middle = messages.slice(1, -keepTail);

  if (middle.length === 0) {
    return { messages, compressed: false, savedTokens: 0 };
  }

  // Build a text representation of the middle block for the summarizer
  const middleText = middle
    .map((m) => {
      const role = (m as { role?: string }).role ?? "unknown";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  let summary: string;
  try {
    summary = await summarizerFn(
      `Summarise this conversation history concisely, preserving decisions, code changes, and key facts:\n\n${middleText}`
    );
  } catch (err) {
    logger.warn("Context compression summarizer failed", { err: String(err) });
    // Fall back to simple trimming
    const trimmed = trimToContextWindow(messages, maxTokens, keepTail);
    return {
      messages: trimmed,
      compressed: true,
      savedTokens: stats.used - estimateMessagesTokens(trimmed),
    };
  }

  const summaryMessage: CoreMessage = {
    role: "assistant",
    content: `[Context Summary — ${middle.length} messages compressed]\n\n${summary}`,
  } as CoreMessage;

  const compressed = [system, summaryMessage, ...tail];
  const newTokens = estimateMessagesTokens(compressed);
  const savedTokens = stats.used - newTokens;

  logger.info("Context compressed", {
    before: stats.used,
    after: newTokens,
    savedTokens,
    messagesRemoved: middle.length,
  });

  contextEvents.emit("context_stats", getContextStats(compressed, maxTokens));

  return {
    messages: compressed,
    compressed: true,
    savedTokens,
    summaryMessageIndex: 1,
  };
}

// ---------------------------------------------------------------------------
// PAKALON.md Memory File Loading (T-A35)
// ---------------------------------------------------------------------------

/**
 * Load PAKALON.md memory files at session start.
 * Looks for:
 * - .pakalon/PAKALON.md (project scope)
 * - ~/.config/pakalon/PAKALON.md (personal scope)
 */
export function loadMemoryFiles(projectDir?: string): string[] {
  const memories: string[] = [];
  
  // Project-scoped memory
  const projectMemory = projectDir
    ? path.join(projectDir, ".pakalon", "PAKALON.md")
    : path.join(process.cwd(), ".pakalon", "PAKALON.md");
  
  if (fs.existsSync(projectMemory)) {
    try {
      const content = fs.readFileSync(projectMemory, "utf-8");
      memories.push(`[Project Memory]\n\n${content}`);
      logger.debug("[Context] Loaded project memory", { path: projectMemory });
    } catch (err) {
      logger.warn("[Context] Failed to load project memory", { path: projectMemory, error: String(err) });
    }
  }
  
  // Personal-scoped memory
  const personalMemory = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".config",
    "pakalon",
    "PAKALON.md"
  );
  
  if (fs.existsSync(personalMemory)) {
    try {
      const content = fs.readFileSync(personalMemory, "utf-8");
      memories.push(`[Personal Memory]\n\n${content}`);
      logger.debug("[Context] Loaded personal memory", { path: personalMemory });
    } catch (err) {
      logger.warn("[Context] Failed to load personal memory", { path: personalMemory, error: String(err) });
    }
  }
  
  return memories;
}

/**
 * Inject memory files into system prompt
 */
export function injectMemoryIntoSystem(baseSystem: string, projectDir?: string): string {
  const memories = loadMemoryFiles(projectDir);
  
  if (memories.length === 0) return baseSystem;
  
  return `${baseSystem}\n\n## Memory Files\n\n${memories.join("\n\n---\n\n")}`;
}

// ---------------------------------------------------------------------------
// PAKALON.md Auto-Write-Back — T-A35b
// ---------------------------------------------------------------------------

export interface MemoryWriteOptions {
  /** "project" saves to <projectDir>/.pakalon/PAKALON.md (default) */
  scope?: "project" | "personal";
  /** Append to existing file instead of replacing it */
  append?: boolean;
}

/**
 * Save a session summary back to PAKALON.md (auto-memory write-back).
 *
 * Called at session end with AI-generated summary so the memory persists
 * across sessions (T-A35b). Creates the directory if missing.
 *
 * @param summary   Markdown summary text to write
 * @param projectDir Project root directory
 * @param options   Scope and write mode
 */
export function saveMemoryFile(
  summary: string,
  projectDir?: string,
  options: MemoryWriteOptions = {}
): void {
  const { scope = "project", append = false } = options;

  let memoryPath: string;
  if (scope === "personal") {
    const configDir = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "",
      ".config",
      "pakalon"
    );
    memoryPath = path.join(configDir, "PAKALON.md");
  } else {
    const dot = projectDir
      ? path.join(projectDir, ".pakalon")
      : path.join(process.cwd(), ".pakalon");
    memoryPath = path.join(dot, "PAKALON.md");
  }

  try {
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const header = `\n\n---\n<!-- Updated: ${timestamp} -->\n`;

    if (append && fs.existsSync(memoryPath)) {
      fs.appendFileSync(memoryPath, `${header}\n${summary}\n`, "utf-8");
    } else {
      const content = `# Pakalon Memory\n${header}\n${summary}\n`;
      fs.writeFileSync(memoryPath, content, "utf-8");
    }
    logger.debug("[Context] Saved memory file", { path: memoryPath, scope, append });
  } catch (err) {
    logger.warn("[Context] Failed to save memory file", { path: memoryPath, error: String(err) });
  }
}

/**
 * Generate a session summary string from the conversation messages.
 * Uses the last assistant message as the primary summary source, augmented
 * with key decisions extracted from the conversation.
 *
 * @param messages   Full conversation message array
 * @param maxLength  Maximum length of the summary (default: 2000 chars)
 */
export function buildSessionMemorySummary(
  messages: CoreMessage[],
  maxLength = 2000
): string {
  if (messages.length === 0) return "";

  // Extract all assistant messages for key info
  const assistantMsgs = messages.filter(
    (m) => (m as { role?: string }).role === "assistant"
  );
  const userMsgs = messages.filter(
    (m) => (m as { role?: string }).role === "user"
  );

  const lines: string[] = [
    `## Session Summary (${new Date().toISOString().slice(0, 10)})`,
    "",
    `**Messages:** ${messages.length} (${userMsgs.length} user, ${assistantMsgs.length} assistant)`,
    "",
    "### Key Decisions & Changes",
  ];

  // Extract decisions from assistant messages (look for bullet points and headings)
  const decisionPats = [
    /^\s*[-*•]\s+.{10,}/gm,      // bullet points
    /^#{1,3}\s+.+/gm,             // headings
    /\b(created|wrote|updated|fixed|installed|configured|added|removed)\b.{5,60}/gi, // action verbs
  ];

  const decisions = new Set<string>();
  for (const m of assistantMsgs.slice(-10)) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    for (const pat of decisionPats) {
      const matches = text.match(pat) ?? [];
      for (const match of matches.slice(0, 3)) {
        decisions.add(match.trim().slice(0, 100));
      }
    }
  }

  if (decisions.size > 0) {
    for (const d of Array.from(decisions).slice(0, 15)) {
      lines.push(`- ${d}`);
    }
  } else {
    lines.push("- Session completed (no explicit decisions recorded)");
  }

  // Add last user message as context for next session
  const lastUser = userMsgs[userMsgs.length - 1];
  if (lastUser) {
    const text = typeof lastUser.content === "string"
      ? lastUser.content.slice(0, 200)
      : JSON.stringify(lastUser.content).slice(0, 200);
    lines.push("", "### Last User Request", text);
  }

  return lines.join("\n").slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Auto-Compact on Context Window Fill (T-A34)
// ---------------------------------------------------------------------------

const AUTO_COMPACT_THRESHOLD = 0.85; // trigger at 85% full
let _autoCompactEnabled = true;
let _lastAutoCompactTime = 0;
const AUTO_COMPACT_COOLDOWN_MS = 60000; // minimum 1 minute between auto-compactions

/**
 * Enable or disable auto-compact
 */
export function setAutoCompactEnabled(enabled: boolean): void {
  _autoCompactEnabled = enabled;
}

/**
 * Check if auto-compact should run and execute if needed.
 * Returns true if compaction was performed.
 */
export async function checkAndAutoCompact(
  messages: CoreMessage[],
  maxTokens: number,
  summarizerFn: (text: string) => Promise<string>
): Promise<CompressionResult> {
  if (!_autoCompactEnabled) {
    return { messages, compressed: false, savedTokens: 0 };
  }
  
  const now = Date.now();
  if (now - _lastAutoCompactTime < AUTO_COMPACT_COOLDOWN_MS) {
    return { messages, compressed: false, savedTokens: 0 };
  }
  
  const stats = getContextStats(messages, maxTokens);
  
  if (stats.percent < AUTO_COMPACT_THRESHOLD * 100) {
    return { messages, compressed: false, savedTokens: 0 };
  }
  
  logger.info("[Context] Auto-compacting context", { percent: stats.percent });
  
  const result = await compressContext(messages, maxTokens, summarizerFn);
  
  if (result.compressed) {
    _lastAutoCompactTime = Date.now();
  }
  
  return result;
}

// ---------------------------------------------------------------------------
// /compact Command (T-A33)
// ---------------------------------------------------------------------------

export interface CompactOptions {
  /** Focus hints for summarization (e.g., "focus on database schema changes") */
  focus?: string;
  /** Force compact even if below threshold */
  force?: boolean;
}

/**
 * Manual context compaction via /compact command
 */
export async function compactContext(
  messages: CoreMessage[],
  maxTokens: number,
  summarizerFn: (text: string) => Promise<string>,
  options: CompactOptions = {}
): Promise<CompressionResult> {
  const stats = getContextStats(messages, maxTokens);
  
  // If not forced and below threshold, just return
  if (!options.force && stats.percent < COMPRESSION_THRESHOLD * 100) {
    return { 
      messages, 
      compressed: false, 
      savedTokens: 0,
      summaryMessageIndex: undefined 
    };
  }
  
  const tail = 6; // preserve last 6 messages
  
  // Build custom summarization prompt with focus hints
  const focusHint = options.focus 
    ? `User requested focus: ${options.focus}\n\n`
    : "";
  
  const system = messages[0];
  const tailMessages = messages.slice(-tail);
  const middleMessages = messages.slice(1, -tail);
  
  if (middleMessages.length === 0) {
    return { 
      messages, 
      compressed: false, 
      savedTokens: 0,
      summaryMessageIndex: undefined 
    };
  }
  
  const middleText = middleMessages
    .map((m) => {
      const role = (m as { role?: string }).role ?? "unknown";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");
  
  let summary: string;
  try {
    summary = await summarizerFn(
      `${focusHint}Summarise this conversation history concisely, preserving decisions, code changes, and key facts. Focus on maintaining useful context for future messages:\n\n${middleText}`
    );
  } catch (err) {
    logger.warn("[Context] /compact summarization failed", { error: String(err) });
    return { 
      messages: trimToContextWindow(messages, maxTokens, tail),
      compressed: true,
      savedTokens: 0,
      summaryMessageIndex: undefined
    };
  }
  
  const summaryMessage: CoreMessage = {
    role: "assistant",
    content: `[Context Summary — ${middleMessages.length} messages compressed]\n\n${summary}`,
  } as CoreMessage;
  
  const compressed = system 
    ? [system, summaryMessage, ...tailMessages]
    : [summaryMessage, ...tailMessages];
  
  const newStats = getContextStats(compressed, maxTokens);
  const savedTokens = stats.used - newStats.used;
  
  logger.info("[Context] Manual compact completed", {
    before: stats.used,
    after: newStats.used,
    saved: savedTokens,
  });
  
  contextEvents.emit("context_stats", newStats);
  
  return {
    messages: compressed,
    compressed: true,
    savedTokens,
    summaryMessageIndex: 1,
  };
}

// ---------------------------------------------------------------------------
// Snip-Compact — remove repeated command patterns from history (T-A37a)
// ---------------------------------------------------------------------------

/** Pattern signature for detecting repeated tool/command invocations */
interface SnipSignature {
  toolName: string;
  inputHash: string;
  count: number;
  firstIndex: number;
  lastIndex: number;
}

/** Cheap hash of tool input for dedup — first 200 chars of sorted key/value pairs */
function cheapInputHash(input: unknown): string {
  if (!input || typeof input !== "object") return String(input).slice(0, 200);
  try {
    const sorted = Object.entries(input as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
      .join("&");
    return sorted.slice(0, 200);
  } catch {
    return "unhashable";
  }
}

/**
 * Scan messages for repeated tool-use patterns and collapse duplicates.
 * Keeps the first and last occurrence of each pattern, replacing middle ones
 * with a single summary marker. Frees tokens by removing verbose repeated
 * tool results (e.g., repeated `git status` or `ls` calls).
 *
 * Returns the snipped messages and count of tokens freed.
 */
export function snipCompact(messages: CoreMessage[]): {
  messages: CoreMessage[];
  snippedCount: number;
  tokensFreed: number;
} {
  if (messages.length < 5) {
    return { messages, snippedCount: 0, tokensFreed: 0 };
  }

  // Build signatures for tool-use messages
  const toolUses = new Map<string, SnipSignature>();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const content = m.content;
    if (typeof content !== "object" || !Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use" || typeof p.name !== "string") continue;

      const key = `${p.name}::${cheapInputHash(p.input)}`;
      const existing = toolUses.get(key);
      if (existing) {
        existing.count++;
        existing.lastIndex = i;
      } else {
        toolUses.set(key, {
          toolName: p.name,
          inputHash: cheapInputHash(p.input),
          count: 1,
          firstIndex: i,
          lastIndex: i,
        });
      }
    }
  }

  // Find patterns with 3+ repetitions
  const repeatedPatterns = [...toolUses.values()].filter((s) => s.count >= 3);

  if (repeatedPatterns.length === 0) {
    return { messages, snippedCount: 0, tokensFreed: 0 };
  }

  // Build set of message indices to snip (keep first and last, snip middle)
  const indicesToSnip = new Set<number>();
  for (const sig of repeatedPatterns) {
    // Collect all indices for this pattern
    const patternIndices: number[] = [];
    for (let i = sig.firstIndex; i <= sig.lastIndex; i++) {
      const m = messages[i];
      if (!m) continue;
      const content = m.content;
      if (typeof content !== "object" || !Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "tool_use" && p.name === sig.toolName) {
          const key = `${p.name}::${cheapInputHash(p.input)}`;
          if (key === `${sig.toolName}::${sig.inputHash}`) {
            patternIndices.push(i);
          }
        }
      }
    }

    // Keep first and last, snip everything in between
    if (patternIndices.length > 2) {
      for (let j = 1; j < patternIndices.length - 1; j++) {
        indicesToSnip.add(patternIndices[j]!);
      }
    }
  }

  if (indicesToSnip.size === 0) {
    return { messages, snippedCount: 0, tokensFreed: 0 };
  }

  // Replace snipped messages with compact markers
  const originalTokens = estimateMessagesTokens(messages);
  const result: CoreMessage[] = messages.map((m, i) => {
    if (!indicesToSnip.has(i)) return m;
    // Replace with a compact marker message
    return {
      role: "assistant",
      content: `[Snipped: repeated tool call — see first occurrence]`,
    } as CoreMessage;
  });

  const newTokens = estimateMessagesTokens(result);

  logger.info("[Context] Snip-compact completed", {
    patternsFound: repeatedPatterns.length,
    messagesSnipped: indicesToSnip.size,
    tokensFreed: originalTokens - newTokens,
  });

  return {
    messages: result,
    snippedCount: indicesToSnip.size,
    tokensFreed: originalTokens - newTokens,
  };
}

// ---------------------------------------------------------------------------
// Reactive-Compact — retry after compaction on prompt-too-long errors (T-A37b)
// ---------------------------------------------------------------------------

export class ContextOverflowError extends Error {
  public readonly statusCode?: number;
  public readonly originalError?: unknown;

  constructor(message: string, statusCode?: number, originalError?: unknown) {
    super(message);
    this.name = "ContextOverflowError";
    this.statusCode = statusCode;
    this.originalError = originalError;
  }
}

/** Check if an error indicates context overflow / prompt too long */
export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ContextOverflowError) return true;
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // 413 Payload Too Large, prompt too long, context length exceeded, max context
    return (
      msg.includes("prompt too long") ||
      msg.includes("context length exceeded") ||
      msg.includes("context_length") ||
      msg.includes("maximum context") ||
      msg.includes("too many tokens") ||
      msg.includes("413") ||
      msg.includes("payload too large") ||
      msg.includes("request too large")
    );
  }
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    const status = obj.status ?? obj.statusCode ?? obj.code;
    if (status === 413 || status === "413") return true;
  }
  return false;
}

/**
 * Attempt reactive compaction when a context overflow error occurs.
 *
 * Strategy:
 * 1. First try: snip-compact (fast, no LLM call)
 * 2. Second try: LLM-based compressContext
 * 3. Third try: aggressive trimToContextWindow to 60% of max
 *
 * Returns the compacted messages or throws if recovery fails.
 */
export async function tryReactiveCompact(
  messages: CoreMessage[],
  maxTokens: number,
  summarizerFn: (text: string) => Promise<string>,
  attempt = 1
): Promise<CompressionResult> {
  const maxAttempts = 3;

  if (attempt > maxAttempts) {
    // Last resort: hard trim to 60%
    const hardTrimmed = trimToContextWindow(messages, Math.floor(maxTokens * 0.6), 4);
    const savedTokens = estimateMessagesTokens(messages) - estimateMessagesTokens(hardTrimmed);
    logger.warn("[Context] Reactive compact: hard trim fallback", { attempt, savedTokens });
    contextEvents.emit("context_stats", getContextStats(hardTrimmed, maxTokens));
    return { messages: hardTrimmed, compressed: true, savedTokens };
  }

  logger.info("[Context] Reactive compact attempt", { attempt });

  // Attempt 1: Snip-compact (fast, no LLM cost)
  if (attempt === 1) {
    const { messages: snipped, tokensFreed } = snipCompact(messages);
    if (tokensFreed > 0) {
      const stats = getContextStats(snipped, maxTokens);
      if (stats.percent < 95) {
        logger.info("[Context] Reactive compact: snip succeeded", { tokensFreed });
        contextEvents.emit("context_stats", stats);
        return { messages: snipped, compressed: true, savedTokens: tokensFreed };
      }
      // Snip wasn't enough, escalate to LLM compression with snipped messages
      return tryReactiveCompact(snipped, maxTokens, summarizerFn, 2);
    }
    return tryReactiveCompact(messages, maxTokens, summarizerFn, 2);
  }

  // Attempt 2: LLM-based compressContext
  if (attempt === 2) {
    const result = await compressContext(messages, maxTokens, summarizerFn, 4);
    if (result.compressed && result.savedTokens > 0) {
      const stats = getContextStats(result.messages, maxTokens);
      if (stats.percent < 95) {
        logger.info("[Context] Reactive compact: LLM compression succeeded", {
          savedTokens: result.savedTokens,
        });
        return result;
      }
      return tryReactiveCompact(result.messages, maxTokens, summarizerFn, 3);
    }
    return tryReactiveCompact(messages, maxTokens, summarizerFn, 3);
  }

  // Attempt 3: Should not reach here due to maxAttempts check above,
  // but handle gracefully
  return tryReactiveCompact(messages, maxTokens, summarizerFn, attempt + 1);
}

// ---------------------------------------------------------------------------
// Context Collapse — progressive collapse with commit-log staging (T-A37c)
// ---------------------------------------------------------------------------

export type CollapseStage =
  | "none"           // No collapse applied
  | "light"          // Collapse tool results to summaries
  | "medium"         // Collapse + compress tool_use inputs
  | "heavy"          // Collapse + replace old assistant messages with summaries
  | "critical";      // Keep only system + last 2 exchanges

export interface CollapseResult {
  messages: CoreMessage[];
  stage: CollapseStage;
  tokensFreed: number;
}

const COLLAPSE_THRESHOLDS: Record<CollapseStage, number> = {
  none: 0,
  light: 0.88,    // > 88% → light collapse
  medium: 0.92,   // > 92% → medium collapse
  heavy: 0.96,    // > 96% → heavy collapse
  critical: 0.99, // > 99% → critical collapse
};

/**
 * Determine the collapse stage based on current context usage.
 */
export function getCollapseStage(percentUsed: number): CollapseStage {
  if (percentUsed >= COLLAPSE_THRESHOLDS.critical * 100) return "critical";
  if (percentUsed >= COLLAPSE_THRESHOLDS.heavy * 100) return "heavy";
  if (percentUsed >= COLLAPSE_THRESHOLDS.medium * 100) return "medium";
  if (percentUsed >= COLLAPSE_THRESHOLDS.light * 100) return "light";
  return "none";
}

/**
 * Collapse tool result messages to short summaries.
 * Replaces verbose tool output with a one-line summary.
 */
function collapseToolResults(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((m) => {
    const content = m.content;
    if (typeof content !== "object" || !Array.isArray(content)) return m;

    const collapsed = content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const p = part as Record<string, unknown>;

      // Collapse tool_result content
      if (p.type === "tool_result" && typeof p.content === "string" && p.content.length > 500) {
        const lines = p.content.split("\n").length;
        const chars = p.content.length;
        return {
          ...p,
          content: `[Tool result collapsed: ${lines} lines, ${chars} chars — first 200 chars]\n${p.content.slice(0, 200)}`,
        };
      }
      return part;
    });

    return { ...m, content: collapsed } as CoreMessage;
  });
}

/**
 * Collapse tool_use inputs by truncating large inputs.
 */
function collapseToolInputs(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((m) => {
    const content = m.content;
    if (typeof content !== "object" || !Array.isArray(content)) return m;

    const collapsed = content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const p = part as Record<string, unknown>;

      if (p.type === "tool_use" && p.input && typeof p.input === "object") {
        const inputStr = JSON.stringify(p.input);
        if (inputStr.length > 800) {
          return {
            ...p,
            input: { _collapsed: true, _summary: inputStr.slice(0, 300) + "..." },
          };
        }
      }
      return part;
    });

    return { ...m, content: collapsed } as CoreMessage;
  });
}

/**
 * Heavy collapse: replace older assistant messages with short markers.
 * Keeps system message + last 6 messages intact.
 */
function collapseOldAssistantMessages(messages: CoreMessage[]): CoreMessage[] {
  if (messages.length < 10) return messages;

  const system = messages[0];
  if (!system) return messages;

  const keepRecent = 6;
  const tail = messages.slice(-keepRecent);
  const oldMessages = messages.slice(1, -keepRecent);

  const collapsed: CoreMessage[] = oldMessages.map((m) => {
    const role = (m as { role?: string }).role;
    if (role !== "assistant") return m;

    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (content.length > 200) {
      return {
        role: "assistant",
        content: `[Collapsed assistant message: ${content.length} chars — ${content.slice(0, 100)}...]`,
      } as CoreMessage;
    }
    return m;
  });

  return [system, ...collapsed, ...tail];
}

/**
 * Critical collapse: keep only system + last 2 exchanges.
 */
function criticalCollapse(messages: CoreMessage[]): CoreMessage[] {
  const system = messages[0];
  if (!system || messages.length < 5) return messages;

  // Find last 2 user messages and their responses
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && (m as { role?: string }).role === "user") {
      userIndices.push(i);
      if (userIndices.length >= 2) break;
    }
  }

  if (userIndices.length === 0) {
    // No user messages found — keep last 4 messages
    return [system, ...messages.slice(-4)];
  }

  const lastExchangeStart = Math.min(...userIndices);
  return [system, ...messages.slice(lastExchangeStart)];
}

/**
 * Apply progressive context collapse based on current usage level.
 *
 * Stages:
 * - light (>88%): Collapse verbose tool results
 * - medium (>92%): Also collapse large tool_use inputs
 * - heavy (>96%): Also collapse old assistant messages
 * - critical (>99%): Keep only system + last 2 exchanges
 */
export function applyContextCollapse(messages: CoreMessage[], maxTokens: number): CollapseResult {
  const stats = getContextStats(messages, maxTokens);
  const stage = getCollapseStage(stats.percent);

  if (stage === "none") {
    return { messages, stage: "none", tokensFreed: 0 };
  }

  const originalTokens = estimateMessagesTokens(messages);
  let result = [...messages];

  // Apply stages cumulatively
  if (stage === "light" || stage === "medium" || stage === "heavy" || stage === "critical") {
    result = collapseToolResults(result);
  }

  if (stage === "medium" || stage === "heavy" || stage === "critical") {
    result = collapseToolInputs(result);
  }

  if (stage === "heavy" || stage === "critical") {
    result = collapseOldAssistantMessages(result);
  }

  if (stage === "critical") {
    result = criticalCollapse(result);
  }

  const newTokens = estimateMessagesTokens(result);
  const tokensFreed = originalTokens - newTokens;

  logger.info("[Context] Context collapse applied", {
    stage,
    before: originalTokens,
    after: newTokens,
    tokensFreed,
  });

  contextEvents.emit("context_stats", getContextStats(result, maxTokens));

  return { messages: result, stage, tokensFreed };
}

/**
 * Recover from context overflow by applying progressive collapse.
 * Used when a 413 or context-too-long error occurs during streaming.
 *
 * Returns recovered messages or null if recovery fails.
 */
export function recoverFromOverflow(
  messages: CoreMessage[],
  maxTokens: number
): CollapseResult | null {
  const result = applyContextCollapse(messages, maxTokens);

  if (result.stage === "none" || result.tokensFreed === 0) {
    // Even critical collapse couldn't free enough tokens
    logger.error("[Context] Context overflow recovery failed — all collapse stages exhausted");
    return null;
  }

  // Verify the recovered messages fit within context
  const recoveredStats = getContextStats(result.messages, maxTokens);
  if (recoveredStats.percent >= 100) {
    // Still overflowing after collapse — hard trim
    const hardTrimmed = trimToContextWindow(result.messages, Math.floor(maxTokens * 0.6), 2);
    const hardTokens = estimateMessagesTokens(hardTrimmed);
    logger.warn("[Context] Overflow recovery: hard trim after collapse", {
      stage: result.stage,
      finalTokens: hardTokens,
    });
    return {
      messages: hardTrimmed,
      stage: "critical",
      tokensFreed: estimateMessagesTokens(messages) - hardTokens,
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// max_output_tokens Escalation — auto-escalate output token limits (T-A37d)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const ESCALATED_MAX_OUTPUT_TOKENS = 65536; // 64k
const MAX_OUTPUT_ESCALATION_THRESHOLD = 0.7; // escalate when model uses > 70% of output limit

/**
 * Determine the appropriate max_output_tokens for the current request.
 * Automatically escalates from 8k to 64k when the model's previous response
 * hit the output limit (indicated by stop_reason = "max_tokens" or
 * response approaching the limit).
 */
export function resolveMaxOutputTokens(
  currentSetting: number | undefined,
  lastStopReason?: string,
  lastOutputTokenCount?: number
): number {
  const base = currentSetting ?? DEFAULT_MAX_OUTPUT_TOKENS;

  // Check if we need to escalate
  const hitLimit =
    lastStopReason === "max_tokens" ||
    lastStopReason === "length" ||
    (lastOutputTokenCount !== undefined &&
      lastOutputTokenCount >= base * MAX_OUTPUT_ESCALATION_THRESHOLD);

  if (hitLimit && base < ESCALATED_MAX_OUTPUT_TOKENS) {
    logger.info("[Context] Escalating max_output_tokens", {
      from: base,
      to: ESCALATED_MAX_OUTPUT_TOKENS,
      reason: lastStopReason ?? "threshold exceeded",
    });
    return ESCALATED_MAX_OUTPUT_TOKENS;
  }

  return base;
}

// ---------------------------------------------------------------------------
// /context Command (T-A36)
// ---------------------------------------------------------------------------

/**
 * Get detailed context window information for /context command
 */
export interface ContextInfo {
  stats: ContextStats;
  messageCount: number;
  systemPromptTokens: number;
  memoryTokens: number;
  loadedSkills: string[];
  skillsExcluded: boolean;
  truncationWarnings: string[];
}

/**
 * Get current context information
 */
export function getContextInfo(
  messages: CoreMessage[],
  maxTokens: number,
  loadedSkills: string[] = [],
  totalSkillTokens = 0
): ContextInfo {
  const stats = getContextStats(messages, maxTokens);
  
  // Calculate system prompt tokens
  const systemPromptTokens = messages[0]
    ? estimateTokens(typeof messages[0].content === "string" ? messages[0].content : JSON.stringify(messages[0].content))
    : 0;
  
  // Calculate memory tokens
  const memories = loadMemoryFiles();
  const memoryTokens = memories.reduce((sum, m) => sum + estimateTokens(m), 0);
  
  // Check if skills were excluded due to budget
  const skillsExcluded = totalSkillTokens > 0 && (systemPromptTokens + memoryTokens + totalSkillTokens) > maxTokens * 0.3;
  
  // Generate warnings
  const warnings: string[] = [];
  if (stats.percent > 80) {
    warnings.push("Context window > 80% full. Consider using /compact");
  }
  if (stats.percent > 95) {
    warnings.push("CRITICAL: Context window nearly full. /compact recommended.");
  }
  if (skillsExcluded) {
    warnings.push("Some skills were excluded due to token budget limits.");
  }
  
  return {
    stats,
    messageCount: messages.length,
    systemPromptTokens,
    memoryTokens,
    loadedSkills,
    skillsExcluded,
    truncationWarnings: warnings,
  };
}
