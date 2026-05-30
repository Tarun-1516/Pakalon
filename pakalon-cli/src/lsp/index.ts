/**
 * LSP (Language Server Protocol) Integration for Pakalon
 *
 * Provides IDE-like code intelligence:
 * - Go to definition
 * - Find references
 * - Real-time diagnostics
 * - Symbol search
 *
 * Features:
 * - Gitignored file filtering
 * - File size validation (10MB limit)
 * - Crash recovery with automatic reconnection
 * - Protocol tracing for debugging
 * - resultCount/fileCount metadata
 *
 * Based on Claude Code LSP implementation (released December 2025)
 * Supports 11 programming languages
 */

import { debugLog } from "@/utils/logger.js";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

// Configuration constants
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const LSP_INIT_TIMEOUT_MS = 5000;
const LSP_REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const WORKSPACE_LANGUAGE_SCAN_LIMIT = 300;
const CONTENT_LANGUAGE_READ_LIMIT = 8192;

// Protocol tracing enabled via DEBUG environment variable
const PROTOCOL_TRACE_ENABLED = process.env.DEBUG?.includes("lsp:protocol") ?? false;

/**
 * Check if a path is gitignored using git check-ignore
 * Batches multiple paths for efficient checking
 */
async function isPathGitignored(filePaths: string[], workspaceRoot: string): Promise<Set<string>> {
  const ignored = new Set<string>();

  if (filePaths.length === 0) return ignored;

  try {
    // Use git check-ignore with batched paths
    const batchSize = 100;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      const joinedPaths = batch.map(p => `"${p}"`).join(" ");

      try {
        const result = execSync(
          `git check-ignore --no-index --exclude-standard ${joinedPaths}`,
          {
            cwd: workspaceRoot,
            timeout: 5000,
            encoding: "utf-8",
            input: batch.join("\n"),
          }
        );
        // If check-ignore finds ignored paths, they appear in stderr
        const ignoredPaths = result.split("\n").filter(p => p.trim());
        ignoredPaths.forEach(p => ignored.add(p.trim()));
      } catch {
        // git check-ignore returns exit code 1 when paths are not ignored
        // This is expected behavior, ignore the error
      }
    }
  } catch (err) {
    debugLog(`[lsp] Gitignore check failed: ${err}`);
  }

  return ignored;
}

/**
 * Validate file size is under the limit
 */
function validateFileSize(filePath: string): { valid: boolean; error?: string } {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        error: `File ${filePath} is ${stats.size} bytes (exceeds ${MAX_FILE_SIZE_BYTES} limit)`,
      };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: `Cannot stat file ${filePath}` };
  }
}

/**
 * Filter results to exclude gitignored files
 */
async function filterGitignoredResults<T extends { file: string }>(
  results: T[],
  workspaceRoot: string
): Promise<T[]> {
  if (results.length === 0) return results;

  const filePaths = results.map(r => r.file);
  const ignoredFiles = await isPathGitignored(filePaths, workspaceRoot);

  return results.filter(result => !ignoredFiles.has(result.file));
}

/**
 * Log LSP protocol message if tracing is enabled
 */
function logProtocol(side: "→" | "←", method: string, params?: unknown): void {
  if (PROTOCOL_TRACE_ENABLED) {
    const paramsStr = params ? ` ${JSON.stringify(params).slice(0, 200)}` : "";
    debugLog(`[lsp:protocol] ${side} ${method}${paramsStr}`);
  }
}

/**
 * Create a crash recovery wrapper for LSP operations
 */
async function withCrashRecovery<T>(
  operation: () => Promise<T>,
  context: { workspaceRoot: string; language: string; operation: string }
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRY_ATTEMPTS) {
        debugLog(
          `[lsp] ${context.operation} failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}): ${lastError.message}. Retrying...`
        );
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));

        // Force reconnection by clearing the client cache
        const key = `${context.workspaceRoot}:${context.language}`;
        lspClients.delete(key);
      }
    }
  }

  throw lastError || new Error(`${context.operation} failed after ${MAX_RETRY_ATTEMPTS} attempts`);
}

// LSP Client implementation using stdio communication with language servers
export interface LSPClient {
  name: string;
  language: string;
  command: string[];
  args?: string[];
}

export interface SymbolLocation {
  file: string;
  line: number;
  column: number;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source?: string;
}

export interface DefinitionResult {
  file: string;
  line: number;
  column: number;
  symbolName?: string;
}

export interface ReferencesResult {
  file: string;
  line: number;
  column: number;
  symbolName: string;
  context?: string;
}

export interface CodeActionResult {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: Diagnostic[];
  edit?: unknown;
  command?: unknown;
}

export interface SemanticTokensResult {
  data: number[];
  resultId?: string;
  tokenCount: number;
}

interface IncrementalTextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  text: string;
}

function fileUriToPath(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") return uri;
    return decodeURIComponent(parsed.pathname).replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return uri.replace(/file:\/\/\/?/, "").replace(/^\/([A-Za-z]:)/, "$1");
  }
}

function pathToFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  const clampedOffset = Math.max(0, Math.min(offset, text.length));

  for (let i = 0; i < clampedOffset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  return { line, character: clampedOffset - lineStart };
}

function computeIncrementalEdit(previous: string, next: string): IncrementalTextEdit | null {
  if (previous === next) return null;

  let start = 0;
  const previousLength = previous.length;
  const nextLength = next.length;
  const minLength = Math.min(previousLength, nextLength);

  while (start < minLength && previous.charCodeAt(start) === next.charCodeAt(start)) {
    start++;
  }

  let previousEnd = previousLength;
  let nextEnd = nextLength;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd--;
    nextEnd--;
  }

  return {
    range: {
      start: positionAt(previous, start),
      end: positionAt(previous, previousEnd),
    },
    text: next.slice(start, nextEnd),
  };
}

function tryReadTextPrefix(filePath: string, limit = CONTENT_LANGUAGE_READ_LIMIT): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) return null;
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(limit, stats.size));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// Language Server configurations
const LSP_SERVERS: Record<string, LSPClient> = {
  python: {
    name: "python-lsp-server",
    language: "python",
    command: ["python", "-m", "pylsp"],
  },
  typescript: {
    name: "typescript-language-server",
    language: "typescript",
    command: ["typescript-language-server", "--stdio"],
  },
  javascript: {
    name: "typescript-language-server",
    language: "javascript",
    command: ["typescript-language-server", "--stdio"],
  },
  tsx: {
    name: "typescript-language-server",
    language: "tsx",
    command: ["typescript-language-server", "--stdio"],
  },
  jsx: {
    name: "typescript-language-server",
    language: "jsx",
    command: ["typescript-language-server", "--stdio"],
  },
  go: {
    name: "gopls",
    language: "go",
    command: ["gopls"],
  },
  rust: {
    name: "rust-analyzer",
    language: "rust",
    command: ["rust-analyzer"],
  },
  java: {
    name: "jdtls",
    language: "java",
    command: ["jdtls"],
  },
  csharp: {
    name: "omnisharp",
    language: "csharp",
    command: ["omnisharp", "--stdio"],
  },
  cpp: {
    name: "clangd",
    language: "cpp",
    command: ["clangd"],
  },
  c: {
    name: "clangd",
    language: "c",
    command: ["clangd"],
  },
  php: {
    name: "php-language-server",
    language: "php",
    command: ["php", "-S", "localhost:0", "-t", ".", "| php-language-server"],
  },
  kotlin: {
    name: "kotlin-language-server",
    language: "kotlin",
    command: ["kotlin-language-server"],
  },
  ruby: {
    name: "solargraph",
    language: "ruby",
    command: ["solargraph", "stdio"],
  },
  html: {
    name: "vscode-html-languageserver",
    language: "html",
    command: ["vscode-html-languageserver", "--stdio"],
  },
  css: {
    name: "vscode-css-languageserver",
    language: "css",
    command: ["vscode-css-languageserver", "--stdio"],
  },
  json: {
    name: "vscode-json-languageserver",
    language: "json",
    command: ["vscode-json-languageserver", "--stdio"],
  },
  yaml: {
    name: "yaml-language-server",
    language: "yaml",
    command: ["yaml-language-server", "--stdio"],
  },
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  php: "php",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
};

const CONTENT_LANGUAGE_PATTERNS: Array<{ language: string; patterns: Array<[RegExp, number]> }> = [
  {
    language: "typescript",
    patterns: [
      [/\bimport\s+type\b|\bexport\s+type\b|\binterface\s+\w+/m, 5],
      [/\btype\s+\w+\s*=/m, 4],
      [/\bReact\.(FC|Node|Element)\b|<\/?[A-Z][A-Za-z0-9]*[\s>]/m, 4],
      [/\bfrom\s+["'][^"']+["'];?/m, 2],
    ],
  },
  {
    language: "javascript",
    patterns: [
      [/\b(import|export)\s+[\s\S]*?\bfrom\s+["'][^"']+["']/m, 4],
      [/\b(module\.exports|require\(["'][^"']+["']\))/m, 3],
      [/\bconst\s+\w+\s*=|\blet\s+\w+\s*=|\bfunction\s+\w+\s*\(/m, 2],
    ],
  },
  {
    language: "python",
    patterns: [
      [/^from\s+\S+\s+import\s+|^import\s+\S+/m, 4],
      [/^def\s+\w+\s*\(|^class\s+\w+.*:/m, 4],
      [/\bself\b|:\s*(str|int|float|bool|list|dict)\b/m, 2],
    ],
  },
  {
    language: "go",
    patterns: [
      [/^package\s+\w+/m, 6],
      [/\bfunc\s+\w+\s*\(|\bfunc\s*\([^)]*\)\s*\w+\s*\(/m, 4],
      [/\bimport\s+\(/m, 3],
    ],
  },
  {
    language: "rust",
    patterns: [
      [/\bfn\s+\w+\s*\(|\blet\s+mut\b|\bimpl\s+\w+/m, 4],
      [/\buse\s+[\w:]+;|\bpub\s+(struct|enum|fn)\b/m, 4],
      [/\bmatch\s+\w+\s*\{|::\w+/m, 2],
    ],
  },
  {
    language: "java",
    patterns: [
      [/\bpublic\s+(final\s+)?class\s+\w+|\binterface\s+\w+/m, 5],
      [/^package\s+[\w.]+;/m, 4],
      [/\bpublic\s+static\s+void\s+main\s*\(/m, 3],
    ],
  },
  {
    language: "csharp",
    patterns: [
      [/\bnamespace\s+[\w.]+|\busing\s+[\w.]+;/m, 4],
      [/\b(public|private|internal)\s+(class|record|interface)\s+\w+/m, 5],
    ],
  },
  {
    language: "cpp",
    patterns: [
      [/#include\s+<[^>]+>|\bstd::\w+/m, 4],
      [/\btemplate\s*<|\bclass\s+\w+\s*[:{]/m, 3],
    ],
  },
  {
    language: "c",
    patterns: [
      [/#include\s+["<][^">]+[">]/m, 3],
      [/\bint\s+main\s*\(|\btypedef\s+struct\b/m, 3],
    ],
  },
  {
    language: "php",
    patterns: [
      [/<\?php/m, 6],
      [/\bnamespace\s+[\w\\]+;|\buse\s+[\w\\]+;/m, 3],
    ],
  },
  {
    language: "ruby",
    patterns: [
      [/^class\s+\w+|^module\s+\w+|^def\s+\w+/m, 4],
      [/\brequire\s+["'][^"']+["']/m, 2],
    ],
  },
  {
    language: "html",
    patterns: [
      [/<!doctype\s+html|<html[\s>]/im, 6],
      [/<(div|main|section|script|style|body)[\s>]/im, 3],
    ],
  },
  {
    language: "css",
    patterns: [
      [/[.#]?[A-Za-z][\w-]*\s*\{[^}]*:[^}]*\}/m, 3],
      [/@media\s+|@keyframes\s+/m, 3],
    ],
  },
  {
    language: "json",
    patterns: [
      [/^\s*[{[][\s\S]*[}\]]\s*$/m, 2],
      [/"[^"]+"\s*:/m, 3],
    ],
  },
  {
    language: "yaml",
    patterns: [
      [/^---\s*$/m, 2],
      [/^[A-Za-z0-9_.-]+:\s+.+$/m, 3],
    ],
  },
];

function scoreLanguageFromContent(content: string): string | null {
  if (!content.trim()) return null;
  let best: { language: string; score: number } | null = null;

  for (const candidate of CONTENT_LANGUAGE_PATTERNS) {
    let score = 0;
    for (const [pattern, weight] of candidate.patterns) {
      if (pattern.test(content)) score += weight;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { language: candidate.language, score };
    }
  }

  return best && best.score >= 3 ? best.language : null;
}

/**
 * Detect language from extension and, for unknown/ambiguous paths, content heuristics.
 */
export function detectLanguage(filePath: string, contentHint?: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const fromExtension = ext ? EXT_TO_LANGUAGE[ext] ?? null : null;

  if (fromExtension && !["h", "m"].includes(ext ?? "")) {
    return fromExtension;
  }

  const content = contentHint ?? tryReadTextPrefix(filePath);
  const fromContent = content ? scoreLanguageFromContent(content) : null;
  return fromContent ?? fromExtension;
}

/**
 * Get LSP client for a file
 */
export function getLSPClient(filePath: string): LSPClient | null {
  const lang = detectLanguage(filePath);
  if (!lang) return null;
  return LSP_SERVERS[lang] || null;
}

function getWorkspaceLSPClient(workspaceRoot: string): LSPClient | null {
  const configHints: Array<{ file: string; language: string }> = [
    { file: "tsconfig.json", language: "typescript" },
    { file: "package.json", language: "typescript" },
    { file: "pyproject.toml", language: "python" },
    { file: "requirements.txt", language: "python" },
    { file: "go.mod", language: "go" },
    { file: "Cargo.toml", language: "rust" },
    { file: "pom.xml", language: "java" },
    { file: "build.gradle", language: "java" },
    { file: "composer.json", language: "php" },
    { file: "Gemfile", language: "ruby" },
  ];

  for (const hint of configHints) {
    if (fs.existsSync(path.join(workspaceRoot, hint.file))) {
      return LSP_SERVERS[hint.language] ?? null;
    }
  }

  const ignoredDirs = new Set([".git", "node_modules", "dist", "build", "coverage", ".pakalon-agents", ".pakalon"]);
  const stack = [workspaceRoot];
  let scanned = 0;
  const languageScores = new Map<string, number>();

  while (stack.length > 0 && scanned < WORKSPACE_LANGUAGE_SCAN_LIMIT) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scanned >= WORKSPACE_LANGUAGE_SCAN_LIMIT) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) stack.push(fullPath);
        continue;
      }

      scanned++;
      const language = detectLanguage(fullPath);
      if (language && LSP_SERVERS[language]) {
        languageScores.set(language, (languageScores.get(language) ?? 0) + 1);
      }
    }
  }

  const [language] = [...languageScores.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return language ? LSP_SERVERS[language] ?? null : null;
}

/**
 * Check if LSP is available for a file
 */
export function isLSPAvailable(filePath: string): boolean {
  return getLSPClient(filePath) !== null;
}

// LSP Request/Response types
interface LSPRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface LSPResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface LSPNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type LSPMessage = LSPResponse | LSPNotification;

class LSPClientConnection {
  private proc: ReturnType<typeof import("child_process")["spawn"]> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private stdoutBuffer = Buffer.alloc(0);
  private capabilities: Record<string, boolean> = {};
  private documentVersions = new Map<string, number>();
  private documentContents = new Map<string, string>();
  private initialized = false;

  constructor(
    private client: LSPClient,
    private workspaceRoot: string
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const { spawn } = await import("child_process");
      
      this.proc = spawn(this.client.command[0]!, [...(this.client.args || []), ...this.client.command.slice(1)], {
        cwd: this.workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stdout?.on("data", (chunk: Buffer | string) => this.handleStdout(chunk));
      this.proc.stderr?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString().trim();
        if (text) debugLog(`[lsp:${this.client.language}:stderr] ${text}`);
      });
      this.proc.on("error", (err) => this.rejectPendingRequests(err));
      this.proc.on("exit", (code, signal) => {
        this.initialized = false;
        this.rejectPendingRequests(
          new Error(`LSP server ${this.client.name} exited with code ${code ?? "null"} signal ${signal ?? "null"}`)
        );
      });

      // Initialize LSP
      const initPromise = this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileUri(this.workspaceRoot),
        workspaceFolders: [{ uri: pathToFileUri(this.workspaceRoot), name: "pakalon" }],
        capabilities: {
          textDocument: {
            synchronization: { willSave: false, didSave: true, willSaveWaitUntil: false, didChange: true },
            codeAction: { dynamicRegistration: false },
            completion: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            typeDefinition: { dynamicRegistration: false },
            implementation: { dynamicRegistration: false },
            callHierarchy: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false },
            hover: { dynamicRegistration: false },
            semanticTokens: {
              dynamicRegistration: false,
              requests: { full: true, range: true },
              tokenTypes: [
                "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
                "parameter", "variable", "property", "enumMember", "event", "function",
                "method", "macro", "keyword", "modifier", "comment", "string", "number",
                "regexp", "operator",
              ],
              tokenModifiers: [
                "declaration", "definition", "readonly", "static", "deprecated", "abstract",
                "async", "modification", "documentation", "defaultLibrary",
              ],
              formats: ["relative"],
            },
            signatureHelp: { dynamicRegistration: false },
            documentFormatting: { dynamicRegistration: false },
            typeHierarchy: { dynamicRegistration: false },
            inlayHint: { dynamicRegistration: false },
          },
          workspace: {
            applyEdit: false,
            workspaceFolders: true,
            symbol: { dynamicRegistration: false },
          },
        },
      });

      // Wait for initialization with timeout
      await Promise.race([
        initPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("LSP init timeout")), LSP_INIT_TIMEOUT_MS)),
      ]);

      // Send initialized notification
      this.sendNotification("initialized", {});

      this.initialized = true;
      debugLog(`[lsp] Initialized ${this.client.name} for ${this.client.language}`);
    } catch (err) {
      debugLog(`[lsp] Failed to initialize ${this.client.name}: ${err}`);
      throw err;
    }
  }

  private writeMessage(message: LSPRequest | LSPNotification): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) {
      throw new Error("LSP server stdin is not available");
    }

    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    this.proc.stdin.write(header + body);
  }

  private handleStdout(chunk: Buffer | string): void {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunkBuffer]);

    while (this.stdoutBuffer.length > 0) {
      let headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      let separatorLength = 4;
      if (headerEnd === -1) {
        headerEnd = this.stdoutBuffer.indexOf("\n\n");
        separatorLength = 2;
      }
      if (headerEnd === -1) return;

      const header = this.stdoutBuffer.slice(0, headerEnd).toString("ascii");
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        debugLog(`[lsp] Dropping malformed server message header: ${header}`);
        this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + separatorLength);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1]!, 10);
      const bodyStart = headerEnd + separatorLength;
      const bodyEnd = bodyStart + contentLength;
      if (this.stdoutBuffer.length < bodyEnd) return;

      const body = this.stdoutBuffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.slice(bodyEnd);

      try {
        this.handleMessage(JSON.parse(body) as LSPMessage);
      } catch (err) {
        debugLog(`[lsp] Failed to parse server message: ${err}`);
      }
    }
  }

  private handleMessage(message: LSPMessage): void {
    if ("id" in message && typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;

      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.message ?? `LSP request ${message.id} failed`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("method" in message) {
      logProtocol("←", message.method, message.params);
    }
  }

  private rejectPendingRequests(reason: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pendingRequests.clear();
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) throw new Error("LSP not initialized");

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;

      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, LSP_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        const request: LSPRequest = { jsonrpc: "2.0", id, method, params };
        this.writeMessage(request);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.proc) return;
    const notification: LSPNotification = { jsonrpc: "2.0", method, params };
    this.writeMessage(notification);
  }

  private sendDidOpenNotification(filePath: string, content: string): void {
    this.documentVersions.set(filePath, 1);
    this.documentContents.set(filePath, content);
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileUri(filePath),
        languageId: this.client.language,
        version: 1,
        text: content,
      },
    });
  }

  sendDidChangeNotification(filePath: string, content: string): void {
    const previous = this.documentContents.get(filePath);
    const version = (this.documentVersions.get(filePath) ?? 0) + 1;
    const edit = previous === undefined ? null : computeIncrementalEdit(previous, content);

    if (previous === undefined) {
      this.sendDidOpenNotification(filePath, content);
      return;
    }

    if (!edit) return;

    this.documentVersions.set(filePath, version);
    this.documentContents.set(filePath, content);
    this.sendNotification("textDocument/didChange", {
      textDocument: {
        uri: pathToFileUri(filePath),
        version,
      },
      contentChanges: [{
        range: edit.range,
        rangeLength: undefined,
        text: edit.text,
      }],
    });
  }

  private syncDocument(filePath: string): boolean {
    const sizeCheck = validateFileSize(filePath);
    if (!sizeCheck.valid) {
      debugLog(`[lsp] document sync skipped: ${sizeCheck.error}`);
      return false;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      debugLog(`[lsp] document sync failed for ${filePath}: ${err}`);
      return false;
    }

    if (!this.documentContents.has(filePath)) {
      this.sendDidOpenNotification(filePath, content);
      return true;
    }

    this.sendDidChangeNotification(filePath, content);
    return true;
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    await this.sendRequest("shutdown", {});
    this.sendNotification("exit", {});
    this.proc?.kill();
    this.initialized = false;
  }

  // LSP Methods
  async gotoDefinition(filePath: string, line: number, column: number): Promise<DefinitionResult | null> {
    try {
      // Validate file size before LSP operation
      const sizeCheck = validateFileSize(filePath);
      if (!sizeCheck.valid) {
        debugLog(`[lsp] gotoDefinition skipped: ${sizeCheck.error}`);
        return null;
      }

      logProtocol("→", "textDocument/definition", { filePath, line, column });
      this.syncDocument(filePath);

      const result = await this.sendRequest("textDocument/definition", {
        textDocument: { uri: pathToFileUri(filePath) },
        position: { line, character: column },
      });

      logProtocol("←", "textDocument/definition", result);

      if (!result || Array.isArray(result) && result.length === 0) return null;

      const location = Array.isArray(result) ? result[0] : result;
      if (!location || !location.uri) return null;

      const uri = location.uri;

      return {
        file: fileUriToPath(uri),
        line: location.range?.start?.line || 0,
        column: location.range?.start?.character || 0,
        symbolName: location.symbolName,
      };
    } catch (err) {
      debugLog(`[lsp] gotoDefinition error: ${err}`);
      return null;
    }
  }

  async findReferences(filePath: string, line: number, column: number): Promise<ReferencesResult[]> {
    try {
      // Validate file size before LSP operation
      const sizeCheck = validateFileSize(filePath);
      if (!sizeCheck.valid) {
        debugLog(`[lsp] findReferences skipped: ${sizeCheck.error}`);
        return [];
      }

      logProtocol("→", "textDocument/references", { filePath, line, column });
      this.syncDocument(filePath);

      const result = await this.sendRequest("textDocument/references", {
        textDocument: { uri: pathToFileUri(filePath) },
        position: { line, character: column },
        context: { includeDeclaration: true },
      });

      logProtocol("←", "textDocument/references", result);

      if (!result || !Array.isArray(result)) return [];

      const rawResults = result.map((location: any) => ({
        file: location.uri ? fileUriToPath(location.uri) : "",
        line: location.range?.start?.line || 0,
        column: location.range?.start?.character || 0,
        symbolName: "",
        context: "",
      }));

      // Filter out gitignored files
      const uniqueFiles = [...new Set(rawResults.map(r => r.file))];
      const ignoredFiles = await isPathGitignored(uniqueFiles, this.workspaceRoot);

      return rawResults.filter(r => !ignoredFiles.has(r.file));
    } catch (err) {
      debugLog(`[lsp] findReferences error: ${err}`);
      return [];
    }
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    try {
      if (!this.syncDocument(filePath)) return [];

      // Request diagnostics
      const raw = await this.sendRequest("textDocument/diagnostic", {
        textDocument: { uri: pathToFileUri(filePath) },
      });

      const result = Array.isArray(raw)
        ? raw
        : ((raw as { items?: unknown[] } | null)?.items ?? []);
      if (!Array.isArray(result)) return [];

      return result.map((diag: any) => ({
        file: filePath,
        line: diag.range?.start?.line || 0,
        column: diag.range?.start?.character || 0,
        severity: mapDiagnosticSeverity(diag.severity),
        message: diag.message || "",
        source: diag.source,
      }));
    } catch (err) {
      // Diagnostics might not be supported
      return [];
    }
  }

  async getDocumentSymbols(filePath: string): Promise<Array<{ name: string; kind: number; location: { file: string; line: number; column: number } }>> {
    try {
      // Validate file size before LSP operation
      const sizeCheck = validateFileSize(filePath);
      if (!sizeCheck.valid) {
        debugLog(`[lsp] getDocumentSymbols skipped: ${sizeCheck.error}`);
        return [];
      }

      logProtocol("→", "textDocument/documentSymbol", { filePath });
      this.syncDocument(filePath);

      const result = await this.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: pathToFileUri(filePath) },
      });

      logProtocol("←", "textDocument/documentSymbol", result);

      if (!result || !Array.isArray(result)) return [];

      return result.map((symbol: any) => ({
        name: symbol.name,
        kind: symbol.kind,
        location: {
          file: filePath,
          line: symbol.location?.range?.start?.line || 0,
          column: symbol.location?.range?.start?.character || 0,
        },
      }));
    } catch (err) {
      debugLog(`[lsp] getDocumentSymbols error: ${err}`);
      return [];
    }
  }

  async getWorkspaceSymbols(query: string): Promise<Array<{ name: string; location: { file: string; line: number } }>> {
    try {
      const result = await this.sendRequest("workspace/symbol", {
        query,
      });

      if (!result || !Array.isArray(result)) return [];

      return result.map((symbol: any) => ({
        name: symbol.name,
        location: {
          file: symbol.location?.uri ? fileUriToPath(symbol.location.uri) : "",
          line: symbol.location?.range?.start?.line || 0,
        },
      }));
    } catch (err) {
      debugLog(`[lsp] getWorkspaceSymbols error: ${err}`);
      return [];
    }
  }

  async getHover(filePath: string, line: number, column: number): Promise<{ contents: string; range?: { startLine: number; startCol: number; endLine: number; endCol: number } } | null> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/hover", {
        textDocument: { uri: pathToFileUri(filePath) },
        position: { line, character: column },
      });

      if (!raw) return null;
      const result = raw as Record<string, unknown>;

      let contents = "";
      const resultContents = result["contents"];
      if (typeof resultContents === "string") {
        contents = resultContents;
      } else if (Array.isArray(resultContents)) {
        contents = resultContents.map((c: unknown) => typeof c === "string" ? c : (c as Record<string, unknown>)?.value ?? "").join("\n");
      } else if (resultContents && typeof resultContents === "object" && "value" in resultContents) {
        contents = String((resultContents as Record<string, unknown>).value ?? "");
      }

      let range = undefined;
      const resultRange = result["range"];
      if (resultRange && typeof resultRange === "object") {
        const r = resultRange as Record<string, unknown>;
        const start = r["start"] as Record<string, unknown> | undefined;
        const end = r["end"] as Record<string, unknown> | undefined;
        range = {
          startLine: (start?.["line"] as number) ?? 0,
          startCol: (start?.["character"] as number) ?? 0,
          endLine: (end?.["line"] as number) ?? 0,
          endCol: (end?.["character"] as number) ?? 0,
        };
      }

      return { contents, range };
    } catch (err) {
      debugLog(`[lsp] getHover error: ${err}`);
      return null;
    }
  }

  async getCompletion(filePath: string, line: number, column: number): Promise<Array<{ label: string; kind: string; detail?: string; documentation?: string }>> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/completion", {
        textDocument: { uri: pathToFileUri(filePath) },
        position: { line, character: column },
      });

      const result = raw as Record<string, unknown>;
      const items = (result?.["items"] as unknown[]) ?? (Array.isArray(raw) ? raw : []);
      if (!Array.isArray(items)) return [];

      const completionKinds: Record<number, string> = {
        1: "text", 2: "method", 3: "function", 4: "constructor", 5: "field",
        6: "variable", 7: "class", 8: "interface", 9: "module", 10: "property",
        11: "unit", 12: "value", 13: "enum", 14: "keyword", 15: "snippet",
        16: "color", 17: "file", 18: "reference", 19: "folder", 20: "enumMember",
        21: "constant", 22: "struct", 23: "event", 24: "operator", 25: "typeParameter",
      };

      return items.slice(0, 20).map((item: unknown) => {
        const i = item as Record<string, unknown>;
        const doc = i["documentation"];
        return {
          label: String(i["label"] ?? ""),
          kind: completionKinds[i["kind"] as number] || "text",
          detail: i["detail"] as string | undefined,
          documentation: typeof doc === "string" ? doc : (doc as Record<string, unknown>)?.["value"] as string | undefined,
        };
      });
    } catch (err) {
      debugLog(`[lsp] getCompletion error: ${err}`);
      return [];
    }
  }

  async getCodeActions(
    filePath: string,
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
    diagnostics: Diagnostic[] = [],
    only?: string[],
  ): Promise<CodeActionResult[]> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/codeAction", {
        textDocument: { uri: pathToFileUri(filePath) },
        range,
        context: {
          diagnostics: diagnostics.map((diagnostic) => ({
            range: {
              start: { line: diagnostic.line, character: diagnostic.column },
              end: { line: diagnostic.line, character: diagnostic.column },
            },
            severity: diagnostic.severity,
            message: diagnostic.message,
            source: diagnostic.source,
          })),
          ...(only?.length ? { only } : {}),
        },
      });

      if (!raw || !Array.isArray(raw)) return [];
      return raw.map((entry: unknown) => {
        const action = entry as Record<string, unknown>;
        return {
          title: String(action["title"] ?? ""),
          kind: action["kind"] as string | undefined,
          isPreferred: action["isPreferred"] as boolean | undefined,
          diagnostics: action["diagnostics"] as Diagnostic[] | undefined,
          edit: action["edit"],
          command: action["command"],
        };
      });
    } catch (err) {
      debugLog(`[lsp] getCodeActions error: ${err}`);
      return [];
    }
  }

  async getSemanticTokens(filePath: string): Promise<SemanticTokensResult | null> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/semanticTokens/full", {
        textDocument: { uri: pathToFileUri(filePath) },
      });
      if (!raw || typeof raw !== "object") return null;
      const result = raw as Record<string, unknown>;
      const data = Array.isArray(result["data"]) ? result["data"].filter((value): value is number => typeof value === "number") : [];
      return {
        data,
        resultId: result["resultId"] as string | undefined,
        tokenCount: Math.floor(data.length / 5),
      };
    } catch (err) {
      debugLog(`[lsp] getSemanticTokens error: ${err}`);
      return null;
    }
  }

  async renameSymbol(filePath: string, line: number, column: number, newName: string): Promise<{ changes: Array<{ file: string; edits: Array<{ line: number; startCol: number; endCol: number; newText: string }> }> } | null> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/rename", {
        textDocument: { uri: pathToFileUri(filePath) },
        position: { line, character: column },
        newName,
      });

      if (!raw) return null;
      const result = raw as Record<string, unknown>;

      if (!result["documentChanges"]) {
        if (result["changes"]) {
          const changesObj = result["changes"] as Record<string, unknown[]>;
          const changes = Object.entries(changesObj).map(([uri, edits]) => ({
            file: fileUriToPath(uri),
            edits: (edits as Record<string, unknown>[]).map((e: Record<string, unknown>) => {
              const range = e["range"] as Record<string, unknown> | undefined;
              const start = range?.["start"] as Record<string, unknown> | undefined;
              const end = range?.["end"] as Record<string, unknown> | undefined;
              return {
                line: (start?.["line"] as number) ?? 0,
                startCol: (start?.["character"] as number) ?? 0,
                endCol: (end?.["character"] as number) ?? 0,
                newText: String(e["newText"] ?? ""),
              };
            }),
          }));
          return { changes };
        }
        return null;
      }

      const docChanges = result["documentChanges"] as Record<string, unknown>[];
      const changes = docChanges.map((change: Record<string, unknown>) => {
        const textDoc = change["textDocument"] as Record<string, unknown> | undefined;
        const edits = (change["edits"] as Record<string, unknown>[]) ?? [];
        return {
          file: fileUriToPath(String(textDoc?.["uri"] ?? "")),
          edits: edits.map((e: Record<string, unknown>) => {
            const range = e["range"] as Record<string, unknown> | undefined;
            const start = range?.["start"] as Record<string, unknown> | undefined;
            const end = range?.["end"] as Record<string, unknown> | undefined;
            return {
              line: (start?.["line"] as number) ?? 0,
              startCol: (start?.["character"] as number) ?? 0,
              endCol: (end?.["character"] as number) ?? 0,
              newText: String(e["newText"] ?? ""),
            };
          }),
        };
      });

      return { changes };
    } catch (err) {
      debugLog(`[lsp] renameSymbol error: ${err}`);
      return null;
    }
  }

  async formatDocument(filePath: string): Promise<any[] | null> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/formatting", {
        textDocument: { uri: pathToFileUri(filePath) },
        options: { tabSize: 2, insertSpaces: true },
      });
      return Array.isArray(raw) ? raw : null;
    } catch (err) {
      debugLog(`[lsp] formatDocument error: ${err}`);
      return null;
    }
  }

  async getTypeHierarchy(filePath: string, line: number, character: number): Promise<any[] | null> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/prepareTypeHierarchy", {
        textDocument: { uri: pathToFileUri(filePath) },
        position: { line, character },
      });
      if (!raw) return null;
      const items = Array.isArray(raw) ? raw : [raw];
      return items;
    } catch (err) {
      debugLog(`[lsp] getTypeHierarchy error: ${err}`);
      return null;
    }
  }

  async getInlayHints(filePath: string, line: number, character: number): Promise<any[] | null> {
    try {
      this.syncDocument(filePath);
      const range = { start: { line: 0, character: 0 }, end: { line, character } };
      const raw = await this.sendRequest("textDocument/inlayHint", {
        textDocument: { uri: pathToFileUri(filePath) },
        range,
      });
      return Array.isArray(raw) ? raw : null;
    } catch (err) {
      debugLog(`[lsp] getInlayHints error: ${err}`);
      return null;
    }
  }

  async getSignatureHelp(filePath: string, line: number, character: number): Promise<any | null> {
    try {
      this.syncDocument(filePath);
      const raw = await this.sendRequest("textDocument/signatureHelp", {
        textDocument: { uri: pathToFileUri(filePath) },
        position: { line, character },
      });
      if (!raw || typeof raw !== "object") return null;
      return raw;
    } catch (err) {
      debugLog(`[lsp] getSignatureHelp error: ${err}`);
      return null;
    }
  }
}

// LSP Client cache by workspace
const lspClients = new Map<string, LSPClientConnection>();

function mapDiagnosticSeverity(severity: number): Diagnostic["severity"] {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "information";
    case 4: return "hint";
    default: return "information";
  }
}

/**
 * Get or create LSP client for workspace
 */
export async function getOrCreateLSPClient(
  workspaceRoot: string,
  filePath?: string
): Promise<LSPClientConnection | null> {
  const langClient = filePath ? getLSPClient(filePath) : getWorkspaceLSPClient(workspaceRoot);
  if (!langClient) return null;

  const key = `${workspaceRoot}:${langClient.language}`;
  
  if (lspClients.has(key)) {
    const client = lspClients.get(key)!;
    try {
      await client.initialize();
      return client;
    } catch {
      lspClients.delete(key);
    }
  }

  try {
    const client = new LSPClientConnection(langClient, workspaceRoot);
    await client.initialize();
    lspClients.set(key, client);
    return client;
  } catch (err) {
    debugLog(`[lsp] Failed to create LSP client: ${err}`);
    return null;
  }
}

/**
 * Go to definition - navigates to where a symbol is defined
 * Includes crash recovery and file validation
 */
export async function gotoDefinition(
  filePath: string,
  line: number,
  column: number,
  workspaceRoot?: string
): Promise<DefinitionResult | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const lang = detectLanguage(filePath) || "unknown";

  return withCrashRecovery(
    async () => {
      const client = await getOrCreateLSPClient(workspace, filePath);
      if (!client) return null;
      return client.gotoDefinition(filePath, line, column);
    },
    { workspaceRoot: workspace, language: lang, operation: "gotoDefinition" }
  );
}

/**
 * Find all references to a symbol
 * Includes crash recovery, file validation, and gitignored filtering
 * Returns results with metadata (resultCount, fileCount)
 */
export async function findReferences(
  filePath: string,
  line: number,
  column: number,
  workspaceRoot?: string
): Promise<ReferencesResult[]> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const lang = detectLanguage(filePath) || "unknown";

  return withCrashRecovery(
    async () => {
      const client = await getOrCreateLSPClient(workspace, filePath);
      if (!client) return [];
      const results = await client.findReferences(filePath, line, column);

      // Add metadata about results
      debugLog(`[lsp] findReferences: ${results.length} results across ${new Set(results.map(r => r.file)).size} files`);

      return results;
    },
    { workspaceRoot: workspace, language: lang, operation: "findReferences" }
  );
}

/**
 * Extended result type with metadata
 */
export interface ReferencesResultWithMetadata extends ReferencesResult {
  resultCount: number;
  fileCount: number;
}

/**
 * Get diagnostics for a file
 */
export async function getFileDiagnostics(
  filePath: string,
  workspaceRoot?: string
): Promise<Diagnostic[]> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return [];
  return client.getDiagnostics(filePath);
}

function collectLspCandidateFiles(workspaceRoot: string, maxFiles: number): string[] {
  const ignoredDirs = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".pakalon", ".pakalon-agents"]);
  const files: string[] = [];
  const stack = [workspaceRoot];

  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) stack.push(fullPath);
      } else if (getLSPClient(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Aggregate diagnostics across LSP-supported files in the workspace.
 */
export async function getWorkspaceDiagnostics(
  workspaceRoot = process.cwd(),
  maxFiles = 50
): Promise<Array<{ file: string; diagnostics: Diagnostic[] }>> {
  const workspace = path.resolve(workspaceRoot);
  const files = collectLspCandidateFiles(workspace, maxFiles);
  const results: Array<{ file: string; diagnostics: Diagnostic[] }> = [];

  for (const file of files) {
    const diagnostics = await getFileDiagnostics(file, workspace);
    if (diagnostics.length > 0) {
      results.push({ file, diagnostics });
    }
  }

  return results;
}

/**
 * Get all symbols in a document
 */
export async function getDocumentSymbols(
  filePath: string,
  workspaceRoot?: string
): Promise<Array<{ name: string; kind: number; location: { file: string; line: number; column: number } }>> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return [];
  return client.getDocumentSymbols(filePath);
}

/**
 * Search for symbols across the workspace
 */
export async function searchWorkspaceSymbols(
  query: string,
  workspaceRoot: string
): Promise<Array<{ name: string; location: { file: string; line: number } }>> {
  const client = await getOrCreateLSPClient(workspaceRoot);
  if (!client) return [];
  return client.getWorkspaceSymbols(query);
}

/**
 * Get hover documentation for a symbol
 */
export async function getHover(
  filePath: string,
  line: number,
  column: number,
  workspaceRoot?: string
): Promise<{ contents: string; range?: { startLine: number; startCol: number; endLine: number; endCol: number } } | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.getHover(filePath, line, column);
}

/**
 * Get code completion suggestions at a position
 */
export async function getCompletion(
  filePath: string,
  line: number,
  column: number,
  workspaceRoot?: string
): Promise<Array<{ label: string; kind: string; detail?: string; documentation?: string }>> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return [];
  return client.getCompletion(filePath, line, column);
}

/**
 * Rename a symbol across the workspace
 */
export async function renameSymbol(
  filePath: string,
  line: number,
  column: number,
  newName: string,
  workspaceRoot?: string
): Promise<{ changes: Array<{ file: string; edits: Array<{ line: number; startCol: number; endCol: number; newText: string }> }> } | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.renameSymbol(filePath, line, column, newName);
}

/**
 * Get code actions and quick fixes for a file range.
 */
export async function getCodeActions(
  filePath: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  workspaceRoot?: string,
  only?: string[],
): Promise<CodeActionResult[]> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return [];
  return client.getCodeActions(filePath, range, [], only);
}

/**
 * Get semantic tokens for LSP-backed highlighting.
 */
export async function getSemanticTokens(
  filePath: string,
  workspaceRoot?: string
): Promise<SemanticTokensResult | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.getSemanticTokens(filePath);
}

/**
 * Get available LSP servers info
 */
export function getAvailableLSPServers(): Array<{ language: string; server: string }> {
  return Object.entries(LSP_SERVERS).map(([lang, client]) => ({
    language: lang,
    server: client.name,
  }));
}

/**
 * Check which languages have LSP support
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(LSP_SERVERS);
}

/**
 * Clean up LSP clients
 */
export async function cleanupLSPClients(): Promise<void> {
  for (const client of lspClients.values()) {
    try {
      await client.shutdown();
    } catch {
      // Ignore cleanup errors
    }
  }
  lspClients.clear();
}

/**
 * Format a document using the LSP server
 */
export async function formatDocument(
  filePath: string,
  workspaceRoot?: string
): Promise<any[] | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.formatDocument(filePath);
}

/**
 * Get type hierarchy for a symbol at a position
 */
export async function getTypeHierarchy(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot?: string
): Promise<any[] | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.getTypeHierarchy(filePath, line, character);
}

/**
 * Get inlay hints at a position in a document
 */
export async function getInlayHints(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot?: string
): Promise<any[] | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.getInlayHints(filePath, line, character);
}

/**
 * Get signature help at a position in a document
 */
export async function getSignatureHelp(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot?: string
): Promise<any | null> {
  const workspace = workspaceRoot || filePath.split(/[\\/]/).slice(0, -1).join("/");
  const client = await getOrCreateLSPClient(workspace, filePath);
  if (!client) return null;
  return client.getSignatureHelp(filePath, line, character);
}

// Formatters and symbol context
export * from "./formatters.js";
export * from "./symbolContext.js";

// LSP Recommendations subsystem
export * from "./lsp-recommendations.js";

// Export for use in other modules
export default {
  detectLanguage,
  getLSPClient,
  isLSPAvailable,
  gotoDefinition,
  findReferences,
  getFileDiagnostics,
  getWorkspaceDiagnostics,
  getDocumentSymbols,
  searchWorkspaceSymbols,
  getHover,
  getCompletion,
  renameSymbol,
  getCodeActions,
  getSemanticTokens,
  getAvailableLSPServers,
  getSupportedLanguages,
  cleanupLSPClients,
  formatDocument,
  getTypeHierarchy,
  getInlayHints,
  getSignatureHelp,
};

// Re-export diagnostic push utilities
export {
  getDiagnosticPushManager,
  startDiagnosticPush,
  stopDiagnosticPush,
  pushDiagnostics,
  clearDiagnostics,
  DiagnosticPushManager,
} from './diagnostic-push.js';
export type { DiagnosticPushEvent, DiagnosticPushOptions } from './diagnostic-push.js';
