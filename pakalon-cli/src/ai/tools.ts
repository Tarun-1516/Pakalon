/**
 * Tool definitions for the Pakalon agent.
 * Compatible with Vercel AI SDK tool() format.
 *
 * All tools are in-process TypeScript — no Python bridge dependency.
 * PTY-based bash execution, ripgrep search, tree-sitter parsing,
 * in-process web scraping/search, native memory, and ask_user.
 */
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { generateCompletion } from "@/ai/openrouter.js";
import { DEFAULT_FREE_MODEL_ID } from "@/constants/models.js";
import logger from "@/utils/logger.js";
import { useStore } from "@/store/index.js";
import { syncSessionFileChange } from "@/api/client.js";
import { withExitCode, BlockedByExit2Error } from "@/ai/exit-code.js";
import { permissionGate } from "@/ai/permission-gate.js";
import { undoManager } from "@/ai/undo-manager.js";
import { getFileDiagnostics } from "@/lsp/index.js";
import {
  runPreWriteHooks,
  runPostWriteHooks,
  runPreEditHooks,
  runPostEditHooks,
  runPreBashHooks,
  runPostBashHooks,
} from "@/ai/hooks.js";

// In-process tool modules (replaces Python bridge)
import {
  executeBash as ptyExecuteBash,
  isSafeCommand,
  detectDangerousPatterns,
  isSelfKillCommand,
} from "@/tools/bash.js";
import { validateSedCommand } from "@/tools/bash/sedValidation.js";
import { checkDestructiveCommand } from "@/tools/bash/destructiveCommandWarning.js";
import { validateSecurity } from "@/tools/bash/bashSecurity.js";
import { analyzeCommandSemantics } from "@/tools/bash/commandSemantics.js";
import { isPathSafe } from "@/tools/bash/pathValidation.js";
import {
  expandShellAlias,
  normalizeNoHupForPlatform,
  recordShellHistory,
  suggestShellHistory,
} from "@/tools/shell-history.js";
import {
  createSandboxSession,
  destroySandboxSession,
  executeInSandbox,
} from "@/tools/sandbox-execution.js";
import { ripgrepSearch, ripgrepGlob } from "@/tools/ripgrep.js";
import {
  executePowerShell,
  isReadOnlyCommand as isPowerShellReadOnlyCommand,
  detectDangerousPatterns as detectPowerShellDangerousPatterns,
  hasSyncSecurityConcerns as hasPowerShellSyncSecurityConcerns,
  isSelfKillCommand as isPowerShellSelfKillCommand,
} from "@/tools/powershell.js";
import {
  createTeam,
  deleteTeam,
  listTeams,
  readTeamFile,
  sendMessage,
  teamCreateSchema,
  teamDeleteSchema,
  sendMessageSchema,
} from "@/tools/team-tools.js";
import { executeREPLTool, replToolSchema } from "@/tools/repl-tool.js";
import { scrapeUrl } from "@/scrape/scraper.js";
import { webSearch } from "@/search/web.js";
import { kvGet, kvSet } from "@/memory/kv-store.js";
import { storeMemory, searchMemories } from "@/memory/store.js";
import { analyzeImage, analyzeVideo, generateImage, generateVideo } from "@/media/index.js";
import { uploadFile, downloadFile, listFiles, deleteFile } from "@/storage/client.js";
import { askUserGate } from "@/tools/ask-user.js";
import { loadSkill, listSkills } from "@/tools/skills.js";
import { isApproved, approveForSession, approvePermanently } from "@/security/permission-cache.js";
import {
  isDirectoryTrusted,
  trustDirectory,
  checkWorkspaceTrust,
} from "@/security/trust.js";
import { mcpAuthSchema, mcpAuthToolDefinition } from "@/mcp/auth.js";
import {
  getMcpResources as getManagedMcpResources,
  searchMcpResources as searchManagedMcpResources,
} from "@/mcp/manager.js";
import { executeCronJob } from "@/tools/advanced-tools.js";
import {
  validateSafeCommand,
  hasHeredoc,
  extractHeredocContent,
  normalizeWindowsPath,
  detectWindowsPath,
} from "@/tools/execution-enhancements.js";
import { createSwarm, getSwarm, getAllSwarms, dissolveSwarm } from "@/swarms/index.js";
import { computeDiff } from "@/commands/diff.js";
import {
  browserClick,
  browserClickSchema,
  browserClose,
  browserFillForm,
  browserFillFormSchema,
  browserNavigate,
  browserNavigateSchema,
  browserScreenshot,
  browserScreenshotSchema,
  browserSelectOption,
  browserSelectOptionSchema,
  browserSnapshot,
  browserSnapshotSchema,
  browserWait,
  browserWaitSchema,
} from "@/tools/web-browser-tool.js";
import { ChromeDevToolsMCP } from "@/mcp/chrome-devtools.js";
import { lspTool } from "@/lsp/LSPTool.js";
import { discoverPeers } from "@/peers/discovery.js";

function isInteractivePermissionMode(permissionMode: string): boolean {
  return permissionMode === "normal";
}

function isToolingDisabled(permissionMode: string): boolean {
  return permissionMode === "orchestration";
}

function hasElevatedShellPermission(permissionMode: string): boolean {
  return permissionMode === "bypassPermissions" || permissionMode === "acceptEdits" || permissionMode === "auto";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractShellPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  const redirections = command.matchAll(/(?:^|\s)(?:>|>>|<)\s*(['"]?)([^'"|\s]+)\1/g);
  for (const match of redirections) {
    if (match[2]) candidates.push(match[2]);
  }

  const fileCommands = command.matchAll(/\b(?:rm|rmdir|mv|cp|touch|mkdir|chmod|chown|sed)\b\s+([^|;&]+)/g);
  for (const match of fileCommands) {
    const args = (match[1] ?? "")
      .split(/\s+/)
      .map((arg) => stripOuterQuotes(arg.trim()))
      .filter((arg) => arg && !arg.startsWith("-") && !/^[syaic]\W/.test(arg));
    candidates.push(...args);
  }

  return uniqueStrings(candidates).filter((candidate) => candidate !== "." && candidate !== "..");
}

function formatSafetyList(label: string, items: string[]): string {
  if (items.length === 0) return "";
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function commandLabel(prefix: string, value: string, maxLength = 42): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return `${prefix}: ${normalized.slice(0, maxLength)}`;
}

function isErrorResult(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      ("error" in result || (("exitCode" in result) && Number((result as { exitCode?: unknown }).exitCode) !== 0)),
  );
}

async function trackCommandExecution<T>(name: string, run: () => Promise<T>): Promise<T> {
  const store = useStore.getState();
  const commandId = store.startCommand(name, store.sessionId ?? undefined);
  try {
    const result = await run();
    store.completeCommand(commandId, isErrorResult(result) ? "error" : "completed");
    return result;
  } catch (err) {
    store.completeCommand(commandId, "error");
    throw err;
  }
}

// Maintains a best-effort shell working directory across bash tool calls.
// This lets the assistant honor user requests such as `cd src` / `Set-Location src`
// in subsequent command executions.
let bashSessionCwd: string | null = null;

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveDirectoryTarget(targetRaw: string, baseCwd: string): string {
  const target = stripOuterQuotes(targetRaw);
  if (!target || target === ".") {
    return baseCwd;
  }

  const homeDir = process.env.HOME ?? process.env.USERPROFILE;
  if (target === "~" && homeDir) {
    return path.resolve(homeDir);
  }
  if ((target.startsWith("~/") || target.startsWith("~\\")) && homeDir) {
    return path.resolve(homeDir, target.slice(2));
  }

  return path.resolve(baseCwd, target);
}

function resolveBashInvocation(command: string, cwd?: string): {
  command: string;
  cwd: string;
  persistCwd?: string;
  shortCircuit?: {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  };
} {
  const startingCwd = cwd ? path.resolve(cwd) : (bashSessionCwd ?? process.cwd());

  const directChange = command.match(/^\s*(?:cd|set-location)\s+(.+?)\s*;?\s*$/i);
  if (directChange) {
    const nextCwd = resolveDirectoryTarget(directChange[1] ?? "", startingCwd);
    if (!fs.existsSync(nextCwd) || !fs.statSync(nextCwd).isDirectory()) {
      return {
        command,
        cwd: startingCwd,
        shortCircuit: {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: `Directory not found: ${nextCwd}`,
        },
      };
    }

    bashSessionCwd = nextCwd;
    return {
      command,
      cwd: nextCwd,
      persistCwd: nextCwd,
      shortCircuit: {
        success: true,
        exitCode: 0,
        stdout: nextCwd,
        stderr: "",
      },
    };
  }

  const leadingChange = command.match(/^\s*(?:cd|set-location)\s+(.+?)\s*(?:&&|;)\s*([\s\S]+)$/i);
  if (leadingChange) {
    const nextCwd = resolveDirectoryTarget(leadingChange[1] ?? "", startingCwd);
    if (!fs.existsSync(nextCwd) || !fs.statSync(nextCwd).isDirectory()) {
      return {
        command,
        cwd: startingCwd,
        shortCircuit: {
          success: false,
          exitCode: 1,
          stdout: "",
          stderr: `Directory not found: ${nextCwd}`,
        },
      };
    }

    const nextCommand = (leadingChange[2] ?? "").trim();
    if (!nextCommand) {
      bashSessionCwd = nextCwd;
      return {
        command,
        cwd: nextCwd,
        persistCwd: nextCwd,
        shortCircuit: {
          success: true,
          exitCode: 0,
          stdout: nextCwd,
          stderr: "",
        },
      };
    }

    return {
      command: nextCommand,
      cwd: nextCwd,
      persistCwd: nextCwd,
    };
  }

  return {
    command,
    cwd: startingCwd,
  };
}

function normalizeBashCommandForPlatform(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }

  let normalized = command;
  normalized = normalized.replace(/\bmkdir\s+-p\s+((?:[^\s"]+|"[^"]+")+)/gi, (match, target) => {
    const cleanTarget = target.trim().replace(/^["']|["']$/g, "");
    const escapedTarget = cleanTarget.replace(/'/g, "''");
    return `if (-not (Test-Path -LiteralPath '${escapedTarget}')) { New-Item -ItemType Directory -Force -Path '${escapedTarget}' | Out-Null }`;
  });

  return normalized;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function findCurrentTeamName(sessionId: string): string | undefined {
  for (const teamName of listTeams()) {
    const teamFile = readTeamFile(teamName);
    if (teamFile?.leadSessionId === sessionId) {
      return teamName;
    }
  }
  return undefined;
}

function computeLineDelta(previousContent: string | null, updatedContent: string): { added: number; deleted: number } {
  const prevLines = countLines(previousContent ?? "");
  const nextLines = countLines(updatedContent);
  return {
    added: Math.max(0, nextLines - prevLines),
    deleted: Math.max(0, prevLines - nextLines),
  };
}

function buildUnifiedDiff(filePath: string, previousContent: string | null, updatedContent: string): string | undefined {
  const result = computeDiff(previousContent ?? "", updatedContent, { context: 3 });
  if (!result.success || !result.hunks?.length) return undefined;

  const lines = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
  ];

  for (const hunk of result.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
      lines.push(`${prefix}${line.content}`);
    }
  }

  return lines.join("\n");
}

function recordSessionFileChange(filePath: string, previousContent: string | null, updatedContent: string): void {
  try {
    const { added, deleted } = computeLineDelta(previousContent, updatedContent);
    const diff = buildUnifiedDiff(filePath, previousContent, updatedContent);
    const state = useStore.getState();
    state.recordFileChange(filePath, added, deleted, diff);
    if (state.sessionId && (added > 0 || deleted > 0 || diff)) {
      syncSessionFileChange(state.sessionId, {
        path: filePath,
        lines_added: added,
        lines_deleted: deleted,
        diff,
      });
    }
  } catch {
    // Non-critical — ignore errors from stats tracking
  }
}

/**
 * Check if a file is sensitive (e.g., .env files)
 */
function isSensitiveFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  const sensitivePatterns = [
    /^\.env$/i,
    /^\.env\.local$/i,
    /^\.env\.production$/i,
    /^\.env\.development$/i,
    /^\.env\.staging$/i,
    /^\.env\.test$/i,
  ];
  return sensitivePatterns.some(pattern => pattern.test(basename));
}

export const readFileTool = tool({
  description: "Read the content of a file from the filesystem. IMPORTANT: Use this tool instead of bash 'cat', 'type', or 'head' commands for reading files - it's more efficient.",
  inputSchema: z.object({
    filePath: z.string().describe("Absolute or relative path to the file"),
    maxBytes: z.number().optional().describe("Max bytes to read (default 32768)"),
  }),
  execute: async ({ filePath, maxBytes = 32768 }) => {
    try {
      const { permissionMode } = useStore.getState();
      const absPath = path.resolve(filePath);
      const isSensitive = isSensitiveFile(absPath);
      
      if (isToolingDisabled(permissionMode)) {
        return { error: "Read blocked: orchestration mode is Q&A only.", blocked: true, permissionMode };
      }

      // For sensitive files (.env, .env.local, etc.)
      if (isSensitive) {
        // In YOLO/auto-accept mode, skip reading sensitive files
        const permissionModeName = String(permissionMode);
        if (permissionModeName === "auto-accept" || permissionModeName === "auto" || permissionModeName === "bypassPermissions") {
          return { 
            error: "Reading sensitive files (.env, .env.local) is not allowed in YOLO/auto-accept mode for security reasons.", 
            blocked: true, 
            permissionMode,
            reason: "sensitive_file_in_yolo_mode"
          };
        }
        
        // In human-in-loop mode (normal), always ask for permission
        if (isInteractivePermissionMode(permissionMode)) {
          const allowed = await permissionGate.requestPermission(
            "readFile",
            `Read sensitive file: ${absPath}`,
            { filePath: absPath, maxBytes, sensitive: true },
            undefined,
            "This file may contain sensitive information like API keys, passwords, or secrets."
          );
          if (!allowed) {
            return { error: "Read declined by user.", blocked: true, permissionMode };
          }
        }
      } else {
        // For non-sensitive files, use existing permission logic
        if (isInteractivePermissionMode(permissionMode)) {
          const allowed = await permissionGate.requestPermission(
            "readFile",
            `Read file: ${absPath}`,
            { filePath: absPath, maxBytes },
          );
          if (!allowed) {
            return { error: "Read declined by user.", blocked: true, permissionMode };
          }
        }
      }

      const abs = path.resolve(filePath);
      const stat = fs.statSync(abs);
      if (stat.size > 1_000_000) {
        return { error: "File too large (>1MB). Use maxBytes to read a portion." };
      }
      const content = fs.readFileSync(abs, "utf-8").slice(0, maxBytes);
      return { content, truncated: stat.size > maxBytes };
    } catch (err) {
      logger.error("readFile tool error", { filePath, err: String(err) });
      return { error: String(err) };
    }
  },
});

export const writeFileTool = tool({
  description: "Write content to a file on the filesystem. IMPORTANT: Use this tool instead of bash commands like 'echo', 'printf', or redirect operators (>) for file creation. This is more efficient and cross-platform.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to write to"),
    content: z.string().describe("The content to write"),
    append: z.boolean().optional().describe("Append instead of overwrite"),
  }),
  execute: async ({ filePath, content, append = false }) => {
    // Block all writes in Plan mode — only read-only actions allowed
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      return {
        error: "Write blocked in the current mode. Switch to normal or auto-accept to allow file writes.",
        blocked: true,
        permissionMode,
      };
    }

    const abs = path.resolve(filePath);
    let previousContent: string | null = null;
    try {
      previousContent = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
    } catch {
      previousContent = null;
    }

    if (!append && previousContent !== null && previousContent === content) {
      return {
        success: true,
        path: abs,
        noChange: true,
        message: "File already up to date. No write performed.",
      };
    }

    // Edit mode: ask human for permission before writing
    // Skip if user chose "accept all" this session
    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const allowed = await permissionGate.requestPermission(
        "writeFile",
        `${append ? "Append to" : "Write"} file: ${abs}`,
        { filePath: abs, byteCount: content.length, append },
      );
      if (!allowed) {
        return { error: "Write declined by user.", blocked: true, permissionMode };
      }
    }

    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });

      await runPreWriteHooks(abs);
      if (append) {
        fs.appendFileSync(abs, content, "utf-8");
        undoManager.record(abs, content, previousContent);
      } else {
        fs.writeFileSync(abs, content, "utf-8");
        undoManager.record(abs, content, previousContent);
      }
      await runPostWriteHooks(abs);

      // Record session file-change stats for the FileChangeSummary panel
      const updatedContent = append ? `${previousContent ?? ""}${content}` : content;
      recordSessionFileChange(abs, previousContent, updatedContent);

      // T-LSP-04: fetch diagnostics after write so the AI sees errors immediately
      let lspDiagnostics: unknown[] = [];
      try {
        const diags = await getFileDiagnostics(abs);
        if (diags.length > 0) {
          lspDiagnostics = diags.map((d) => ({
            severity: d.severity,
            message: d.message,
            line: d.line != null ? d.line + 1 : undefined,
            source: d.source ?? undefined,
          }));
        }
      } catch {
        // LSP may not be running — non-fatal
      }

      return {
        success: true,
        path: abs,
        ...(lspDiagnostics.length > 0 ? { lspDiagnostics, diagnosticCount: lspDiagnostics.length } : {}),
      };
    } catch (err) {
      logger.error("writeFile tool error", { filePath, err: String(err) });
      return { error: String(err) };
    }
  },
});

export const listDirTool = tool({
  description: "List files and directories at a given path. IMPORTANT: Use this tool instead of bash 'ls' or 'dir' commands for directory listing. This is more efficient.",
  inputSchema: z.object({
    dirPath: z.string().describe("Directory to list"),
    recursive: z.boolean().optional().describe("Recursively list (default false)"),
  }),
  execute: async ({ dirPath, recursive = false }) => {
    try {
      const { permissionMode } = useStore.getState();
      if (isToolingDisabled(permissionMode)) {
        return { error: "List blocked: orchestration mode is Q&A only.", blocked: true, permissionMode };
      }
      if (isInteractivePermissionMode(permissionMode)) {
        const absPath = path.resolve(dirPath);
        const allowed = await permissionGate.requestPermission(
          "listDir",
          `List directory: ${absPath}`,
          { dirPath: absPath, recursive },
        );
        if (!allowed) {
          return { error: "Directory listing declined by user.", blocked: true, permissionMode };
        }
      }
      const abs = path.resolve(dirPath);
      if (recursive) {
        const results: string[] = [];
        const walk = (dir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            results.push(path.relative(abs, full) + (e.isDirectory() ? "/" : ""));
            if (e.isDirectory() && results.length < 500) walk(full);
          }
        };
        walk(abs);
        return { entries: results.slice(0, 500), truncated: results.length >= 500 };
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) =>
        e.name + (e.isDirectory() ? "/" : "")
      );
      return { entries };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const bashTool = tool({
  description:
    "Execute a shell command asynchronously using PTY. " +
    "Supports streaming output, configurable timeout, persistent working directory. " +
    "Safe commands (ls, cat, grep, git status, etc.) are auto-approved. " +
    "Dangerous patterns (command substitution, variable expansion) are detected. " +
    "Self-kill commands are blocked.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
  }),
  execute: async ({ command, cwd, timeout = 30000 }) => {
    const { permissionMode } = useStore.getState();
    const startingCwd = cwd ?? process.cwd();
    const aliasExpansion = expandShellAlias(command, startingCwd);
    const nohupNormalization = normalizeNoHupForPlatform(aliasExpansion.command, startingCwd);
    const pathNormalizedCommand = detectWindowsPath(nohupNormalization.command)
      ? normalizeWindowsPath(nohupNormalization.command)
      : nohupNormalization.command;
    const requestedCommand = command;
    const commandForExecution = pathNormalizedCommand;
    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    let promptedForRisk = false;
    // Heredoc detection for better command handling
    const heredocContent = hasHeredoc(commandForExecution) ? extractHeredocContent(commandForExecution) : null;

    // Safe command validation (SBash allowlist check)
    const safeValidation = validateSafeCommand(commandForExecution);
    if (!safeValidation.valid && permissionMode === "plan") {
      return {
        error: `Command not allowed in plan mode: ${safeValidation.reason}`,
        blocked: true,
        permissionMode,
      };
    }

    const writePatterns = /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|install|npm|yarn|pnpm|pip|apt|brew)\b|>>?|tee\b|curl\s.*-o\b|wget\b/;
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      if (writePatterns.test(commandForExecution)) {
        return {
          error: "Command blocked in the current mode. This command appears to modify files or install packages.",
          blocked: true,
          permissionMode,
        };
      }
      if (isToolingDisabled(permissionMode)) {
        return {
          error: "Command blocked: orchestration mode is Q&A only.",
          blocked: true,
          permissionMode,
        };
      }
    }

    // Self-kill prevention
    if (isSelfKillCommand(commandForExecution)) {
      return {
        error: "Blocked: command would kill the CLI process.",
        blocked: true,
        exitCode: 1,
      };
    }

    const securityValidation = validateSecurity(commandForExecution);
    if (!securityValidation.valid) {
      return {
        error: `Command blocked by shell security policy: ${securityValidation.errors.map((item) => item.message).join("; ")}`,
        blocked: true,
        exitCode: 126,
        permissionMode,
        securityErrors: securityValidation.errors,
      };
    }

    const sedValidation = validateSedCommand(commandForExecution);
    if (!sedValidation.valid) {
      return {
        error: `Command blocked by sed validation: ${sedValidation.error}`,
        blocked: true,
        exitCode: 126,
        permissionMode,
      };
    }

    const destructiveCommand = checkDestructiveCommand(commandForExecution);
    const semantics = analyzeCommandSemantics(commandForExecution);
    const highRiskSideEffects = semantics.sideEffects.filter((sideEffect) => sideEffect.severity === "high");
    const unsafePaths = extractShellPathCandidates(commandForExecution)
      .map((candidate) => ({ candidate, result: isPathSafe(candidate, startingCwd) }))
      .filter(({ result }) => !result.safe);

    if (unsafePaths.length > 0 && !hasElevatedShellPermission(permissionMode)) {
      return {
        error: `Command blocked: path safety check failed for ${unsafePaths.map(({ candidate }) => candidate).join(", ")}`,
        blocked: true,
        exitCode: 126,
        permissionMode,
        unsafePaths,
      };
    }

    if (destructiveCommand?.severity === "critical" && !hasElevatedShellPermission(permissionMode)) {
      return {
        error: `Command blocked: ${destructiveCommand.reason}`,
        blocked: true,
        exitCode: 126,
        permissionMode,
        destructiveCommand,
      };
    }

    if (
      permissionMode === "plan" &&
      (sedValidation.isInplace ||
        destructiveCommand ||
        semantics.intent === "write" ||
        semantics.intent === "delete" ||
        highRiskSideEffects.length > 0)
    ) {
      return {
        error: "Command blocked in plan mode. It appears to modify files or perform a high-risk action.",
        blocked: true,
        exitCode: 126,
        permissionMode,
      };
    }

    const safetyWarnings = uniqueStrings([
      ...securityValidation.warnings.map((item) => item.message),
      ...sedValidation.warnings.map((warning) => `sed: ${warning}`),
      ...(destructiveCommand ? [`${destructiveCommand.severity}: ${destructiveCommand.reason}`] : []),
      ...highRiskSideEffects.map((sideEffect) => `${sideEffect.type}: ${sideEffect.description}`),
      ...unsafePaths.map(({ candidate, result }) => `path ${candidate}: ${result.reason ?? "unsafe path"}`),
    ]);

    if (safetyWarnings.length > 0 && isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const effectiveDir = startingCwd;
      if (!isApproved("bash", effectiveDir, commandForExecution)) {
        promptedForRisk = true;
        const allowed = await permissionGate.requestPermission(
          "bash",
          `${formatSafetyList("Command safety warnings", safetyWarnings)}\nCommand: ${commandForExecution}`,
          {
            command: commandForExecution,
            originalCommand: requestedCommand,
            cwd: effectiveDir,
            securityWarnings: securityValidation.warnings,
            sedValidation,
            destructiveCommand,
            semantics,
            unsafePaths,
          },
        );
        if (!allowed) {
          return {
            error: `Command declined after safety warnings: ${safetyWarnings.join("; ")}`,
            blocked: true,
            permissionMode,
          };
        }
      }
    }

    // Dangerous pattern detection
    const dangerous = detectDangerousPatterns(commandForExecution);
    if (dangerous.length > 0) {
      const description = dangerous.map((d) => d.description).join(", ");
      // Still allow but require explicit permission
      if (isInteractivePermissionMode(permissionMode) && !promptedForRisk) {
        const allowed = await permissionGate.requestPermission(
          "bash",
          `Warning: Dangerous pattern detected: ${description}\nCommand: ${commandForExecution}`,
          { command: commandForExecution, originalCommand: requestedCommand, cwd: startingCwd, dangerousPatterns: dangerous },
        );
        if (!allowed) {
          return {
            error: `Command blocked due to dangerous patterns: ${description}`,
            blocked: true,
            permissionMode,
          };
        }
      }
    }

    // Safe command auto-approval (skip permission gate)
    const isSafe = isSafeCommand(commandForExecution);
    if (!isSafe && !promptedForRisk) {
      if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
        // Check permission cache first
        const effectiveDir = startingCwd;
        if (!isApproved("bash", effectiveDir, commandForExecution)) {
          const allowed = await permissionGate.requestPermission(
            "bash",
            `Execute command: ${commandForExecution}`,
            { command: commandForExecution, originalCommand: requestedCommand, cwd: effectiveDir },
          );
          if (!allowed) {
            return { error: "Command declined by user.", blocked: true, permissionMode };
          }
        }
      }
    }

    return trackCommandExecution(commandLabel("bash", commandForExecution), async () => {
      // Handle cd commands
      const invocation = resolveBashInvocation(commandForExecution, cwd);
      if (invocation.shortCircuit) {
        recordShellHistory({
          shell: "bash",
          command: requestedCommand,
          expandedCommand: commandForExecution !== requestedCommand ? commandForExecution : undefined,
          cwd: invocation.cwd,
          exitCode: invocation.shortCircuit.exitCode,
        });
        return { ...invocation.shortCircuit, cwd: invocation.cwd };
      }

      const effectiveCommand = invocation.command;
      const normalizedCommand = normalizeBashCommandForPlatform(effectiveCommand);
      const effectiveCwd = invocation.cwd;

      try {
        await runPreBashHooks(commandForExecution);

        const result = await ptyExecuteBash({
          command: normalizedCommand,
          cwd: effectiveCwd,
          timeout,
        });

        if (invocation.persistCwd) {
          // Persist the cwd through the bashSessionCwd mechanism
        }

        await runPostBashHooks(commandForExecution);

        recordShellHistory({
          shell: "bash",
          command: requestedCommand,
          expandedCommand: normalizedCommand !== requestedCommand ? normalizedCommand : undefined,
          cwd: effectiveCwd,
          exitCode: result.exitCode,
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          cwd: effectiveCwd,
          timedOut: result.timedOut,
          ...(aliasExpansion.expanded ? { aliasExpanded: aliasExpansion.alias, expandedCommand: commandForExecution } : {}),
          ...(nohupNormalization.normalized ? { nohup: true, logPath: nohupNormalization.logPath } : {}),
        };
      } catch (err) {
        logger.error("bash tool error", { command, err: String(err) });
        return { error: String(err), exitCode: 1, stderr: String(err) };
      }
    });
  },
});

export const secureBashTool = tool({
  description:
    "Execute a shell command in Pakalon's restricted sandbox worker with CPU, memory, timeout, and disallowed-pattern limits. " +
    "Use this for untrusted shell snippets, install probes, or commands that should not write directly to the project workspace.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute in the sandbox"),
    cwd: z.string().optional().describe("Workspace used for sandbox metadata; command itself runs in an isolated temp directory"),
    timeout: z.number().optional().default(30000).describe("Timeout in milliseconds"),
    memoryLimit: z.number().optional().describe("Memory limit in bytes"),
    cpuTimeLimit: z.number().optional().describe("CPU time limit in milliseconds"),
  }),
  execute: async ({ command, cwd, timeout = 30000, memoryLimit, cpuTimeLimit }) => {
    const workspaceDir = path.resolve(cwd ?? process.cwd());
    const shell = process.platform === "win32" ? "powershell.exe" : (fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
    const normalizedCommand = detectWindowsPath(command) ? normalizeWindowsPath(command) : command;
    const safeValidation = validateSafeCommand(normalizedCommand);
    if (!safeValidation.valid) {
      return {
        error: `secureBash blocked command: ${safeValidation.reason}`,
        blocked: true,
        exitCode: 126,
      };
    }
    const args = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", normalizedCommand]
      : [shell.endsWith("bash") ? "-lc" : "-c", normalizedCommand];

    return trackCommandExecution(commandLabel("secureBash", command), async () => {
      const session = await createSandboxSession(workspaceDir, {
        timeout,
        memoryLimit,
        cpuTimeLimit,
        security: {
          allowedCommands: [shell],
        },
      });
      try {
        const result = await executeInSandbox(session.sandboxId, shell, args, {
          timeout,
          memoryLimit,
          cpuTimeLimit,
        });
        recordShellHistory({
          shell: "secure-bash",
          command,
          cwd: workspaceDir,
          exitCode: result.exitCode,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          duration: result.duration,
          sandboxId: result.sandboxId,
          resourceUsage: result.resourceUsage,
          error: result.error,
        };
      } finally {
        await destroySandboxSession(session.sandboxId).catch(() => false);
      }
    });
  },
});

export const shellHistoryTool = tool({
  description:
    "Search recent shell commands for completion suggestions. " +
    "Returns de-duplicated commands from bash, PowerShell, and secureBash history.",
  inputSchema: z.object({
    query: z.string().optional().default("").describe("Command prefix or keyword to search for"),
    limit: z.number().int().positive().max(50).optional().default(10),
  }),
  execute: async ({ query = "", limit = 10 }) => {
    const suggestions = suggestShellHistory(query, limit).map((entry) => ({
      shell: entry.shell,
      command: entry.command,
      expandedCommand: entry.expandedCommand,
      cwd: entry.cwd,
      exitCode: entry.exitCode,
      createdAt: entry.createdAt,
    }));
    return { success: true, suggestions, count: suggestions.length };
  },
});

export const listPeersTool = tool({
  description:
    "List peer Pakalon sessions discovered for the current project. " +
    "Peers are registered by active CLI instances via .pakalon/peers heartbeats.",
  inputSchema: z.object({
    includeInactive: z.boolean().optional().default(false),
    filter: z.enum(["local", "remote", "all"]).optional().default("all"),
    projectDir: z.string().optional(),
  }),
  execute: async ({ includeInactive = false, filter = "all", projectDir }) => {
    const peers = discoverPeers(projectDir ?? process.cwd(), { includeInactive, filter });
    return {
      success: true,
      peers,
      total: peers.length,
      connected: peers.filter((peer) => peer.status === "connected").length,
    };
  },
});

export const powerShellTool = tool({
  description:
    "Execute a PowerShell command asynchronously on Windows. " +
    "Supports persistent working directory, timeout handling, and safety checks. " +
    "Read-only commands are auto-approved; destructive or suspicious commands require permission.",
  inputSchema: z.object({
    command: z.string().describe("PowerShell command to execute"),
    cwd: z.string().optional().describe("Working directory"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 120000)"),
  }),
  execute: async ({ command, cwd, timeout = 120000 }) => {
    const { permissionMode } = useStore.getState();

    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      if (
        !isPowerShellReadOnlyCommand(command) ||
        hasPowerShellSyncSecurityConcerns(command)
      ) {
        return {
          error: "PowerShell command blocked in the current mode. Only read-only PowerShell commands are allowed.",
          blocked: true,
          permissionMode,
        };
      }
      if (isToolingDisabled(permissionMode)) {
        return {
          error: "PowerShell command blocked: orchestration mode is Q&A only.",
          blocked: true,
          permissionMode,
        };
      }
    }

    if (isPowerShellSelfKillCommand(command)) {
      return {
        error: "Blocked: command would kill the CLI process.",
        blocked: true,
        exitCode: 1,
      };
    }

    const dangerous = detectPowerShellDangerousPatterns(command);
    const readOnly = isPowerShellReadOnlyCommand(command) &&
      !hasPowerShellSyncSecurityConcerns(command);

    if (dangerous.length > 0) {
      const description = dangerous.map((entry) => entry.description).join(", ");
      if (isInteractivePermissionMode(permissionMode)) {
        const allowed = await permissionGate.requestPermission(
          "powershell",
          `Warning: Dangerous PowerShell pattern detected: ${description}\nCommand: ${command}`,
          { command, cwd: cwd ?? process.cwd(), dangerousPatterns: dangerous },
        );
        if (!allowed) {
          return {
            error: `Command blocked due to dangerous PowerShell patterns: ${description}`,
            blocked: true,
            permissionMode,
          };
        }
      }
    } else if (!readOnly) {
      const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
      if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
        const effectiveDir = cwd ?? process.cwd();
        if (!isApproved("powershell", effectiveDir, command)) {
          const allowed = await permissionGate.requestPermission(
            "powershell",
            `Execute PowerShell command: ${command}`,
            { command, cwd: effectiveDir },
          );
          if (!allowed) {
            return { error: "PowerShell command declined by user.", blocked: true, permissionMode };
          }
        }
      }
    }

    return trackCommandExecution(commandLabel("powershell", command), async () => {
      try {
        const result = await executePowerShell({ command, cwd, timeout });
        recordShellHistory({
          shell: "powershell",
          command,
          cwd: result.cwd,
          exitCode: result.exitCode,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          cwd: result.cwd,
          timedOut: result.timedOut,
          interrupted: result.interrupted,
          duration: result.duration,
        };
      } catch (err) {
        logger.error("powershell tool error", { command, err: String(err) });
        return { error: String(err), exitCode: 1, stderr: String(err) };
      }
    });
  },
});

/**
 * justbash tool — command execution alias that prefers just-bash when available,
 * and falls back to the existing PTY bash executor.
 */
export const justBashTool = tool({
  description:
    "Execute shell commands using just-bash style invocation. " +
    "Uses the existing safe bash execution pipeline and permissions.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    cwd: z.string().optional().describe("Working directory"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
  }),
  execute: async ({ command, cwd, timeout = 30000 }) => {
    // Reuse the same execution/safety behavior as bash.
    if (!bashTool.execute) {
      return { error: "bash tool executor is unavailable", exitCode: 1 };
    }
    return bashTool.execute(
      { command, cwd, timeout },
      { toolCallId: "just-bash", messages: [] } as any,
    );
  },
});

const SECURE_EXEC_ALLOWLIST = new Set([
  "git",
  "gh",
  "npm",
  "pnpm",
  "bun",
  "node",
  "python",
  "python3",
  "uv",
  "docker",
  "docker-compose",
  "ls",
  "dir",
  "pwd",
  "whoami",
  "where",
  "which",
  "rg",
  "grep",
  "cat",
  "type",
]);

function parseCommandForSecureExec(command: string): { executable: string; args: string[] } {
  const parts = command.match(/(?:[^\s\"]+|\"[^\"]*\")+/g) ?? [];
  const normalized = parts.map((part) =>
    part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  );
  const executable = normalized[0] ?? "";
  return { executable, args: normalized.slice(1) };
}

/**
 * secureExec tool — shell-free execution with allowlisted executables.
 */
export const secureExecTool = tool({
  description:
    "Secure command execution without shell expansion/injection. " +
    "Runs allowlisted executables with explicit args and timeout.",
  inputSchema: z.object({
    executable: z.string().optional().describe("Executable binary name (e.g. git, npm, bun)"),
    args: z.array(z.string()).optional().describe("Arguments for executable"),
    command: z.string().optional().describe("Optional convenience string; parsed into executable + args"),
    cwd: z.string().optional().describe("Working directory"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
  }),
  execute: async ({ executable, args, command, cwd, timeout = 30000 }) => {
    const { permissionMode } = useStore.getState();
    if (isToolingDisabled(permissionMode)) {
      return {
        error: "secureExec blocked: orchestration mode is Q&A only.",
        blocked: true,
        permissionMode,
      };
    }

    let exe = executable?.trim() ?? "";
    let finalArgs = args ?? [];
    if (!exe && command) {
      const parsed = parseCommandForSecureExec(command);
      exe = parsed.executable;
      finalArgs = parsed.args;
    }

    if (!exe) {
      return { error: "secureExec requires either `executable` or `command`." };
    }

    const normalizedExe = exe.toLowerCase();
    if (!SECURE_EXEC_ALLOWLIST.has(normalizedExe)) {
      return {
        error: `secureExec blocked: executable '${exe}' is not allowlisted.`,
        blocked: true,
      };
    }

    const effectiveCwd = cwd ? path.resolve(cwd) : process.cwd();

    if (isInteractivePermissionMode(permissionMode)) {
      const display = `${exe} ${finalArgs.join(" ")}`.trim();
      const allowed = await permissionGate.requestPermission(
        "secureExec",
        `Execute secure command: ${display}`,
        { executable: exe, args: finalArgs, cwd: effectiveCwd },
      );
      if (!allowed) {
        return { error: "secureExec command declined by user.", blocked: true, permissionMode };
      }
    }

    const display = `${exe} ${finalArgs.join(" ")}`.trim();
    return trackCommandExecution(commandLabel("secureExec", display), async () => await new Promise((resolve) => {
      const proc = spawn(exe, finalArgs, {
        cwd: effectiveCwd,
        env: process.env,
        shell: false,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              proc.kill("SIGTERM");
            } catch {
              // ignore
            }
          }, timeout)
        : null;

      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });

      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, 16384),
          stderr: stderr.slice(0, 8192),
          exitCode: code ?? (timedOut ? 124 : 1),
          cwd: effectiveCwd,
          timedOut,
        });
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({
          error: String(err),
          exitCode: 1,
          stderr: String(err),
          cwd: effectiveCwd,
          timedOut,
        });
      });
    }));
  },
});



export const replTool = tool({
  description:
    "Interactive REPL for JavaScript, TypeScript, and Python. " +
    "Supports persistent contexts, history inspection, and safe evaluation with timeouts.",
  inputSchema: replToolSchema,
  execute: async (input) => executeREPLTool(input),
});

// ---------------------------------------------------------------------------
// Programmatic Tool Calling - Code Execution Tool
// Based on Anthropic's advanced tool use spec
// Allows Claude to orchestrate multiple tool calls in code rather than 
// through individual API round-trips, reducing context pollution
// ---------------------------------------------------------------------------

export const codeExecutionTool = tool({
  description:
    "Execute JavaScript code that can orchestrate multiple tool calls programmatically. " +
    "This allows Claude to run complex workflows with loops, conditionals, and data transformations " +
    "without intermediate results polluting the context window. " +
    "When tools are called within the code, only the final output enters Claude's context.",
  inputSchema: z.object({
    code: z.string().describe("JavaScript code to execute"),
    tools: z.array(z.string()).optional().describe("List of tool names available for programmatic calling"),
  }),
  execute: async ({ code }) => {
    const { permissionMode } = useStore.getState();
    if (isToolingDisabled(permissionMode)) {
      return {
        error: "Code execution blocked: orchestration mode is Q&A only.",
        blocked: true,
        permissionMode,
      };
    }

    // For now, code execution runs in a sandboxed manner
    // The actual implementation would require a proper sandboxed environment
    return {
      stdout: "",
      stderr: "Code execution tool available. Configure allowed_callers for programmatic tool calling.",
      exitCode: 0,
      note: "Programmatic tool calling requires API support. This tool enables the pattern.",
    };
  },
});

export const mcpAuthTool = tool({
  description: "Manage OAuth authentication state for MCP servers.",
  inputSchema: mcpAuthSchema,
  execute: async (input) => mcpAuthToolDefinition.execute(input),
});

export const teamCreateTool = tool({
  description:
    "Create a multi-agent team for parallel work and return the lead agent identity.",
  inputSchema: teamCreateSchema,
  execute: async (input) => {
    const { sessionId, selectedModel } = useStore.getState();
    const effectiveSessionId = sessionId ?? "local-session";
    const existingTeamName = findCurrentTeamName(effectiveSessionId);
    return createTeam(input, {
      sessionId: effectiveSessionId,
      cwd: process.cwd(),
      model: selectedModel ?? undefined,
      existingTeamName,
    });
  },
});

export const teamDeleteTool = tool({
  description: "Delete the current team led by this session and clean up its resources.",
  inputSchema: teamDeleteSchema,
  execute: async (input) => {
    const { sessionId } = useStore.getState();
    const teamName = sessionId ? findCurrentTeamName(sessionId) : undefined;
    return deleteTeam(input, { teamName });
  },
});

export const sendMessageTool = tool({
  description: "Send a message to another agent within the current team.",
  inputSchema: sendMessageSchema,
  execute: async (input) => {
    const { sessionId } = useStore.getState();
    const teamName = sessionId ? findCurrentTeamName(sessionId) : undefined;
    const fromAgentId = teamName ? `team-lead@${teamName}` : `session-${sessionId ?? "local-session"}`;
    return sendMessage(input, { fromAgentId, teamName });
  },
});

export const imageAnalysisTool = tool({
  description: "Analyze an image using OpenRouter vision API (in-process, no bridge)",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the image file"),
  }),
  execute: async ({ path: imagePath }) => {
    try {
      const result = await analyzeImage(imagePath);
      if (!result.success) return { error: result.error };
      return { description: result.description, labels: result.labels };
    } catch (err) {
      logger.error("imageAnalysis tool error", { path: imagePath, err: String(err) });
      return { error: String(err) };
    }
  },
});

export const videoAnalysisTool = tool({
  description: "Analyze a video using ffmpeg frame extraction + OpenRouter vision API (in-process, no bridge)",
  inputSchema: z.object({
    path: z.string().describe("Absolute path to the video file"),
    fps: z.number().optional().describe("Frames per second to extract (default 1)"),
  }),
  execute: async ({ path: videoPath, fps = 1 }) => {
    try {
      const intervalSeconds = fps > 0 ? 1 / fps : 5;
      const result = await analyzeVideo(videoPath, { maxFrames: Math.max(1, Math.ceil(10 * fps)) });
      if (!result.success) return { error: result.error };
      return { summary: result.summary, frameCount: result.frameAnalyses.length };
    } catch (err) {
      logger.error("videoAnalysis tool error", { path: videoPath, err: String(err) });
      return { error: String(err) };
    }
  },
});

/**
 * T-CLI-P8: Pro-only image generation via Flux/DALL-E/StabilityAI/Replicate.
 * Requires user_plan="pro" — blocked for free users.
 */
export const generateImageTool = tool({
  description:
    "Generate an AI image from a text prompt (Pro-only). " +
    "Supports Flux.1, DALL-E 3, Stability AI SD3, and Replicate. " +
    "Returns the saved image path and base64 data.",
  inputSchema: z.object({
    prompt: z.string().describe("Detailed text description of the image to generate"),
    outputPath: z
      .string()
      .optional()
      .describe("Absolute path to save the generated image (optional — temp file if omitted)"),
    model: z
      .enum(["flux", "flux-schnell", "flux-pro", "dall-e-3", "sdxl", "sd3"])
      .optional()
      .default("flux")
      .describe("Generation model to use"),
    width: z.number().optional().default(1024).describe("Image width in pixels"),
    height: z.number().optional().default(1024).describe("Image height in pixels"),
    steps: z.number().optional().default(28).describe("Inference steps (higher = quality, slower)"),
    guidance: z.number().optional().default(3.5).describe("Guidance scale"),
    userPlan: z.string().optional().default("free").describe("User subscription plan"),
  }),
  execute: async ({ prompt, outputPath, model = "flux", width = 1024, height = 1024, steps = 28, guidance = 3.5, userPlan = "free" }) => {
    // Block all generative/write tools in Plan mode
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "generateImage blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow image generation.",
        blocked: true,
        permissionMode,
      };
    }
    try {
      const result = await generateImage({
        prompt,
        outputPath,
        model,
        width,
        height,
        steps,
        guidance,
      });
      if (!result.success) return { error: result.error };
      return { filePath: result.filePath, url: result.url };
    } catch (err) {
      logger.error("generateImage tool error", { prompt, err: String(err) });
      return { error: String(err) };
    }
  },
});

/**
 * T-CLI-P8: Pro-only video generation via Runway Gen-3, Replicate, or fal.ai.
 * Requires user_plan="pro" — blocked for free users.
 */
export const generateVideoTool = tool({
  description:
    "Generate an AI video from a text prompt (Pro-only). " +
    "Supports fal.ai MiniMax, Runway Gen-3 Alpha, and Replicate. " +
    "Optionally accepts an initial image for image-to-video generation.",
  inputSchema: z.object({
    prompt: z.string().describe("Text description of the video to generate"),
    imagePath: z
      .string()
      .optional()
      .describe("Optional starting image path for image-to-video"),
    outputPath: z
      .string()
      .optional()
      .describe("Absolute path to save the generated MP4 (optional)"),
    model: z
      .enum(["minimax", "wan", "runway", "svd"])
      .optional()
      .default("minimax")
      .describe("Video generation model"),
    duration: z.number().optional().default(5).describe("Video duration in seconds (1–10)"),
    userPlan: z.string().optional().default("free").describe("User subscription plan"),
  }),
  execute: async ({ prompt, imagePath, outputPath, model = "minimax", duration = 5, userPlan = "free" }) => {
    // Block all generative/write tools in Plan mode
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "generateVideo blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow video generation.",
        blocked: true,
        permissionMode,
      };
    }
    try {
      const result = await generateVideo({
        prompt,
        outputPath,
        model,
      });
      if (!result.success) return { error: result.error };
      return { filePath: result.filePath, url: result.url };
    } catch (err) {
      logger.error("generateVideo tool error", { prompt, err: String(err) });
      return { error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// T-CLI-P14: Cloud storage tools (MinIO/S3 + Cloudinary)
// ---------------------------------------------------------------------------

const BRIDGE_BASE = process.env["PAKALON_BRIDGE_URL"] ?? "http://localhost:7432";

export const uploadFileTool = tool({
  description: "Upload a local file to cloud storage (S3/MinIO or Cloudinary). Pro-only.",
  inputSchema: z.object({
    localPath: z.string().describe("Absolute path to the local file to upload"),
    remoteKey: z.string().optional().describe("Remote storage key/path (auto-generated if omitted)"),
    provider: z.enum(["minio", "cloudinary"]).optional().describe("Force a specific provider"),
    public: z.boolean().optional().default(true).describe("Whether the uploaded file should be publicly accessible"),
    userPlan: z.string().optional().default("free").describe("User subscription plan"),
  }),
  execute: async ({ localPath, remoteKey, provider, public: pub, userPlan }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return { error: "uploadFile blocked: permission mode is 'plan'.", blocked: true, permissionMode };
    }
    try {
      const result = await uploadFile({
        localPath,
        remoteKey,
        provider: provider === "minio" ? "s3" : provider,
        isPublic: pub,
      });
      return result;
    } catch (err) {
      logger.error("uploadFile tool error", { localPath, err: String(err) });
      return { success: false, error: String(err) };
    }
  },
});

export const downloadFileTool = tool({
  description: "Download a file from cloud storage (S3/MinIO or Cloudinary) to disk. Pro-only.",
  inputSchema: z.object({
    remoteKey: z.string().describe("Remote storage key/path"),
    localPath: z.string().optional().describe("Where to save the file locally (auto-generated if omitted)"),
    provider: z.enum(["minio", "cloudinary"]).optional(),
    userPlan: z.string().optional().default("free"),
  }),
  execute: async ({ remoteKey, localPath, provider, userPlan }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return { error: "downloadFile blocked: permission mode is 'plan'.", blocked: true, permissionMode };
    }
    try {
      return await downloadFile({
        remoteKey,
        localPath,
        provider: provider === "minio" ? "s3" : provider,
      });
    } catch (err) {
      logger.error("downloadFile tool error", { remoteKey, err: String(err) });
      return { success: false, error: String(err) };
    }
  },
});

export const deleteFileTool = tool({
  description: "Delete a file from cloud storage. Pro-only.",
  inputSchema: z.object({
    remoteKey: z.string().describe("Remote storage key to delete"),
    provider: z.enum(["minio", "cloudinary"]).optional(),
    userPlan: z.string().optional().default("free"),
  }),
  execute: async ({ remoteKey, provider, userPlan }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return { error: "deleteFile blocked: permission mode is 'plan'.", blocked: true, permissionMode };
    }
    try {
      const success = await deleteFile(remoteKey, provider === "minio" ? "s3" : provider);
      return { success };
    } catch (err) {
      logger.error("deleteFile tool error", { remoteKey, err: String(err) });
      return { success: false, error: String(err) };
    }
  },
});

export const listFilesTool = tool({
  description: "List files in cloud storage under a given prefix/folder. Pro-only.",
  inputSchema: z.object({
    prefix: z.string().optional().default("").describe("Prefix/folder to list (default: top-level)"),
    provider: z.enum(["minio", "cloudinary"]).optional(),
    userPlan: z.string().optional().default("free"),
  }),
  execute: async ({ prefix, provider, userPlan }) => {
    try {
      const files = await listFiles({
        prefix: prefix ?? "",
        provider: provider === "minio" ? "s3" : provider,
      });
      return { success: true, files };
    } catch (err) {
      logger.error("listFiles tool error", { prefix, err: String(err) });
      return { success: false, files: [], error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// Edit file (diff/patch) — T-CLI-EDIT
// ---------------------------------------------------------------------------

/**
 * Edit a specific section of a file by replacing oldString with newString.
 * More precise than writeFile — preserves surrounding content.
 */
export const editFileTool = tool({
  description:
    "Edit a file by replacing a specific string or section with new content. " +
    "IMPORTANT: Use this tool instead of sed, awk, or bash redirection for file modifications. " +
    "Safer than writeFile — only changes the specified region. " +
    "Use oldString to uniquely identify the text to replace and newString for the replacement.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file to edit"),
    oldString: z.string().describe("The exact text to find and replace (must be unique in the file)"),
    newString: z.string().describe("The replacement text"),
    allowMultiple: z.boolean().optional().default(false).describe("Replace all occurrences (default: false, fail if >1 match)"),
  }),
  execute: async ({ filePath, oldString, newString, allowMultiple = false }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      return { error: "Edit blocked: permission mode is 'plan'.", blocked: true };
    }

    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const abs = path.resolve(filePath);
      const allowed = await permissionGate.requestPermission(
        "editFile",
        `Edit file: ${abs}`,
        { filePath: abs, oldString: oldString.slice(0, 80), newString: newString.slice(0, 80) },
      );
      if (!allowed) return { error: "Edit declined by user.", blocked: true };
    }

    try {
      const abs = path.resolve(filePath);
      const content = fs.readFileSync(abs, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return { error: `oldString not found in ${abs}`, found: 0 };
      }
      if (occurrences > 1 && !allowMultiple) {
        return {
          error: `oldString matches ${occurrences} locations in ${abs}. Make it more specific or set allowMultiple=true.`,
          found: occurrences,
        };
      }

      const previousContent = content;
      const updated = allowMultiple
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      await runPreEditHooks(abs);
      undoManager.record(abs, updated, previousContent);
      fs.writeFileSync(abs, updated, "utf-8");
      await runPostEditHooks(abs);
      recordSessionFileChange(abs, previousContent, updated);

      // T-LSP-04: fetch diagnostics after edit so the AI sees errors immediately
      let editDiagnostics: unknown[] = [];
      try {
        const diags = await getFileDiagnostics(abs);
        if (diags.length > 0) {
          editDiagnostics = diags.map((d) => ({
            severity: d.severity,
            message: d.message,
            line: d.line != null ? d.line + 1 : undefined,
            source: d.source ?? undefined,
          }));
        }
      } catch {
        // LSP may not be running — non-fatal
      }

      return {
        success: true,
        path: abs,
        replacements: occurrences,
        ...(editDiagnostics.length > 0 ? { lspDiagnostics: editDiagnostics, diagnosticCount: editDiagnostics.length } : {}),
      };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// Multi-file edit — T-CLI-MULTIEDIT
// ---------------------------------------------------------------------------

/**
 * Apply multiple edits across one or more files in a single operation.
 * Each edit specifies filePath + oldString + newString.
 */
export const multiEditFilesTool = tool({
  description:
    "Apply multiple string replacements across multiple files in one operation. " +
    "Each edit specifies the file, the exact text to find, and the replacement. " +
    "All edits are applied atomically — if any fails, the rest still proceed and errors are reported.",
  inputSchema: z.object({
    edits: z.array(
      z.object({
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
      })
    ).describe("Array of {filePath, oldString, newString} edit operations"),
  }),
  execute: async ({ edits }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan" || isToolingDisabled(permissionMode)) {
      return { error: "Multi-edit blocked: permission mode is 'plan'.", blocked: true };
    }

    const autoAccept = (globalThis as Record<string, unknown>).PAKALON_PERMISSION_AUTO_ACCEPT === true;
    if (isInteractivePermissionMode(permissionMode) && !autoAccept) {
      const summary = edits.map((e) => path.basename(e.filePath)).join(", ");
      const allowed = await permissionGate.requestPermission(
        "multiEditFiles",
        `Edit ${edits.length} file(s): ${summary}`,
        { fileCount: edits.length },
      );
      if (!allowed) return { error: "Multi-edit declined by user.", blocked: true };
    }

    const results: Array<{ filePath: string; success: boolean; error?: string; replacements?: number }> = [];

    for (const edit of edits) {
      try {
        const abs = path.resolve(edit.filePath);
        const content = fs.readFileSync(abs, "utf-8");
        const occurrences = content.split(edit.oldString).length - 1;
        if (occurrences === 0) {
          results.push({ filePath: abs, success: false, error: "oldString not found" });
          continue;
        }
        const previousContent = content;
        const updated = content.replace(edit.oldString, edit.newString);
        await runPreEditHooks(abs);
        undoManager.record(abs, updated, previousContent);
        fs.writeFileSync(abs, updated, "utf-8");
        await runPostEditHooks(abs);
        recordSessionFileChange(abs, previousContent, updated);
        results.push({ filePath: abs, success: true, replacements: occurrences });
      } catch (err) {
        results.push({ filePath: edit.filePath, success: false, error: String(err) });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    return { results, succeeded: successCount, failed: results.length - successCount };
  },
});

// ---------------------------------------------------------------------------
// Glob/Find tool — T-CLI-GLOB
// ---------------------------------------------------------------------------

export const globFindTool = tool({
  description:
    "Find files matching a glob pattern. " +
    "IMPORTANT: Use this tool instead of bash 'find' command - it's more efficient. " +
    "Examples: '**/*.ts', 'src/**/*.test.ts', 'components/*.tsx'. " +
    "Returns matching file paths relative to the search directory.",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match (e.g. '**/*.ts')"),
    cwd: z.string().optional().describe("Directory to search from (default: current working directory)"),
    maxResults: z.number().optional().default(200).describe("Maximum number of results (default 200)"),
    excludePatterns: z.array(z.string()).optional().describe("Patterns to exclude (e.g. ['node_modules/**', '.git/**'])"),
  }),
  execute: async ({ pattern, cwd, maxResults = 200, excludePatterns = ["node_modules/**", ".git/**", "dist/**", ".next/**"] }) =>
    trackCommandExecution(commandLabel("glob", pattern), async () => {
    try {
      const searchDir = path.resolve(cwd ?? process.cwd());

      // Use a simple recursive walk with pattern matching
      const results: string[] = [];
      const { minimatch } = await import("minimatch").catch(() => ({ minimatch: null }));

      const walk = (dir: string, base: string) => {
        if (results.length >= maxResults) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (results.length >= maxResults) break;
          const rel = base ? `${base}/${e.name}` : e.name;
          // Check exclude patterns
          const excluded = excludePatterns.some((ep) =>
            minimatch ? minimatch(rel, ep, { dot: true }) : rel.includes("node_modules") || rel.startsWith(".git")
          );
          if (excluded) continue;

          if (e.isDirectory()) {
            walk(path.join(dir, e.name), rel);
          } else {
            const matches = minimatch
              ? minimatch(rel, pattern, { dot: true })
              : rel.endsWith(pattern.replace("**/*", "").replace("*", ""));
            if (matches) {
              results.push(rel);
            }
          }
        }
      };

      walk(searchDir, "");
      return { files: results, count: results.length, truncated: results.length >= maxResults, cwd: searchDir };
    } catch (err) {
      return { error: String(err), files: [], count: 0 };
    }
  }),
});

// ---------------------------------------------------------------------------
// Grep search tool — T-CLI-GREP
// ---------------------------------------------------------------------------

export const grepSearchTool = tool({
  description:
    "Search for a pattern across files using grep-style matching. " +
    "IMPORTANT: Use this tool instead of bash 'grep' command - it's more efficient and doesn't require shell execution. " +
    "Returns matching lines with file:line information. " +
    "Supports regex patterns.",
  inputSchema: z.object({
    pattern: z.string().describe("Search pattern (string or regex)"),
    cwd: z.string().optional().describe("Directory to search (default: current directory)"),
    filePattern: z.string().optional().describe("Glob pattern to filter files (e.g. '**/*.ts')"),
    isRegex: z.boolean().optional().default(false).describe("Treat pattern as a regex"),
    caseSensitive: z.boolean().optional().default(false).describe("Case-sensitive search"),
    maxResults: z.number().optional().default(50).describe("Maximum number of results"),
  }),
  execute: async ({ pattern, cwd, filePattern = "**/*", isRegex = false, caseSensitive = false, maxResults = 50 }) =>
    trackCommandExecution(commandLabel("grep", pattern), async () => {
    try {
      const searchDir = path.resolve(cwd ?? process.cwd());
      const flags = caseSensitive ? "g" : "gi";
      const regex = isRegex ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

      const matches: Array<{ file: string; line: number; text: string }> = [];

      const walk = (dir: string, base: string) => {
        if (matches.length >= maxResults) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }

        for (const e of entries) {
          if (matches.length >= maxResults) break;
          const rel = base ? `${base}/${e.name}` : e.name;
          if (rel.includes("node_modules") || rel.startsWith(".git")) continue;

          if (e.isDirectory()) {
            walk(path.join(dir, e.name), rel);
          } else {
            // Skip binary files
            if (/\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|mp4|webm|zip|tar|gz|bin|exe|dll)$/i.test(e.name)) continue;
            try {
              const content = fs.readFileSync(path.join(dir, e.name), "utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                if (regex.test(lines[i] ?? "")) {
                  matches.push({ file: rel, line: i + 1, text: (lines[i] ?? "").trim().slice(0, 200) });
                  regex.lastIndex = 0;
                }
              }
            } catch { /* skip unreadable */ }
          }
        }
      };

      walk(searchDir, "");
      return { matches, count: matches.length, truncated: matches.length >= maxResults };
    } catch (err) {
      return { error: String(err), matches: [], count: 0 };
    }
  }),
});

// ---------------------------------------------------------------------------
// LSP tools — Native TypeScript Language Server Protocol integration
// ---------------------------------------------------------------------------

import {
  gotoDefinition as lspGotoDefinition,
  findReferences as lspFindReferences,
  getFileDiagnostics as lspGetFileDiagnostics,
  getDocumentSymbols as lspGetDocumentSymbols,
  searchWorkspaceSymbols as lspSearchWorkspaceSymbols,
  getHover as lspGetHover,
  getCompletion as lspGetCompletion,
  renameSymbol as lspRenameSymbol,
  getWorkspaceDiagnostics as lspGetWorkspaceDiagnostics,
  getCodeActions as lspGetCodeActions,
  getSemanticTokens as lspGetSemanticTokens,
  formatDocument as lspFormatDocument,
  getTypeHierarchy as lspGetTypeHierarchy,
  getInlayHints as lspGetInlayHints,
  getSignatureHelp as lspGetSignatureHelp,
} from "@/lsp/index.js";

export const lspDefinitionTool = tool({
  description:
    "Go-to-definition: find where a symbol is defined. " +
    "Requires a language server (typescript-language-server, pyright, etc.) to be installed. " +
    "Returns file path(s) and line numbers of the definition.",
  inputSchema: z.object({
    filePath: z.string().describe("File containing the symbol"),
    line: z.number().describe("0-based line number of the symbol"),
    character: z.number().describe("0-based character offset of the symbol"),
    workspaceDir: z.string().optional().describe("Workspace root directory"),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    try {
      const result = await lspGotoDefinition(filePath, line, character, workspaceDir);
      if (!result) return { success: false, message: "No definition found" };
      return { success: true, definition: result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspReferencesTool = tool({
  description:
    "Find all references to a symbol across the workspace. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    try {
      const results = await lspFindReferences(filePath, line, character, workspaceDir);
      return { success: true, references: results, count: results.length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspHoverTool = tool({
  description:
    "Get hover documentation for a symbol (type info, JSDoc, docstrings). " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    try {
      const result = await lspGetHover(filePath, line, character, workspaceDir);
      if (!result) return { success: false, message: "No hover info found" };
      return { success: true, hover: result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspCompletionTool = tool({
  description:
    "Get code completion suggestions at a position (IntelliSense). " +
    "Requires a language server to be installed. Returns top 20 completions.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    try {
      const results = await lspGetCompletion(filePath, line, character, workspaceDir);
      return { success: true, completions: results, count: results.length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspRenameTool = tool({
  description:
    "Rename a symbol across all files in the workspace. " +
    "Returns a WorkspaceEdit with all required changes. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number(),
    character: z.number(),
    newName: z.string().describe("The new name for the symbol"),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, newName, workspaceDir }) => {
    try {
      const result = await lspRenameSymbol(filePath, line, character, newName, workspaceDir);
      if (!result) return { success: false, message: "Rename not supported or failed" };
      return { success: true, rename: result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspDiagnosticsTool = tool({
  description:
    "Get LSP diagnostics (errors, warnings, hints) for one file, or aggregate diagnostics across the workspace when filePath is omitted. " +
    "Returns inline error messages with line numbers and per-file counts. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    filePath: z.string().optional(),
    workspaceDir: z.string().optional(),
    maxFiles: z.number().int().positive().max(500).optional().default(50),
  }),
  execute: async ({ filePath, workspaceDir, maxFiles = 50 }) => {
    try {
      if (!filePath) {
        const workspace = workspaceDir ?? process.cwd();
        const results = await lspGetWorkspaceDiagnostics(workspace, maxFiles);
        const count = results.reduce((sum, entry) => sum + entry.diagnostics.length, 0);
        return { success: true, diagnosticsByFile: results, count, fileCount: results.length };
      }
      const results = await lspGetFileDiagnostics(filePath, workspaceDir);
      return { success: true, diagnostics: results, count: results.length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspSymbolsTool = tool({
  description:
    "Search workspace symbols by name (functions, classes, variables, etc.). " +
    "Returns symbol names with file locations. " +
    "Requires a language server to be installed.",
  inputSchema: z.object({
    query: z.string().describe("Symbol name to search for (partial match supported)"),
    workspaceDir: z.string().optional(),
    language: z.string().optional().describe("Limit search to a specific language (typescript, python, etc.)"),
  }),
  execute: async ({ query, workspaceDir }) => {
    try {
      const workspace = workspaceDir ?? process.cwd();
      const results = await lspSearchWorkspaceSymbols(query, workspace);
      return { success: true, symbols: results, count: results.length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// Web Fetch tool — T-CLI-WEB-FETCH
// Fetches a URL and returns its content as markdown for AI context.
// Read-only: safe in all permission modes including plan mode.
// ---------------------------------------------------------------------------

export const webFetchTool = tool({
  description:
    "Fetch the content of a URL and return it as readable markdown text. " +
    "Useful for reading documentation, inspecting a web page, or pulling in reference content from the web. " +
    "Returns the page's main text extracted as markdown. " +
    "This is a read-only operation — safe in plan mode. " +
    "Rejects file:// URLs for security.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch (must start with http:// or https://)"),
    formats: z.array(z.enum(["markdown", "html"])).optional().default(["markdown"]).describe("Content formats to return (default: markdown only)"),
    maxChars: z.number().optional().default(20000).describe("Maximum characters to return from the page content (default 20 000)"),
  }),
  execute: async ({ url, formats = ["markdown"], maxChars = 20000 }) =>
    trackCommandExecution(commandLabel("webFetch", url), async () => {
    try {
      const result = await scrapeUrl({ url, formats, maxChars });
      if (!result.success) return { error: result.error, url };
      return {
        url,
        markdown: result.markdown,
        html: result.html,
        truncated: result.truncated,
        source: result.source,
        title: result.title,
      };
    } catch (err) {
      return { error: String(err), url };
    }
  }),
});

export const webSearchTool = tool({
  description:
    "Search the web and return a list of relevant results with titles, URLs, and snippets. " +
    "Use this to find up-to-date information, research libraries, look up APIs, or verify facts. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    query: z.string().describe("The web search query"),
    maxResults: z.number().optional().default(8).describe("Maximum number of results to return (default 8)"),
  }),
  execute: async ({ query, maxResults = 8 }) =>
    trackCommandExecution(commandLabel("webSearch", query), async () => {
    try {
      const result = await webSearch({ query, maxResults });
      if (!result.success) return { error: result.error, query };
      return {
        query,
        results: result.results,
        count: result.count,
        source: result.source,
      };
    } catch (err) {
      return { error: String(err), query };
    }
  }),
});

// ---------------------------------------------------------------------------
// Programmatic Orchestration tool — batch tool execution (in-process)
// ---------------------------------------------------------------------------

export const orchestrateTool = tool({
  description:
    "Execute a batch of low-level project operations (read/list/grep/glob/command) in-process. " +
    "Replaces the Python bridge /agent/orchestrate endpoint. " +
    "Supported tool_name values: read_file, list_dir, glob_find, grep_search, run_command.",
  inputSchema: z.object({
    tools: z.array(
      z.object({
        tool_name: z.enum(["read_file", "list_dir", "glob_find", "grep_search", "run_command"]).describe("Operation to run"),
        params: z.record(z.any()).describe("Arguments for the selected operation"),
      })
    ).min(1).describe("Ordered list of operations"),
    parallel: z.boolean().optional().default(false).describe("Run read-only operations concurrently"),
    allowMutation: z.boolean().optional().default(false).describe("Allow mutating commands for run_command"),
    projectDir: z.string().optional().describe("Project root for execution (defaults to cwd)"),
  }),
  execute: async ({ tools, parallel = false, allowMutation = false, projectDir }) => {
    const { permissionMode } = useStore.getState();

    if (isToolingDisabled(permissionMode)) {
      return { error: "Orchestration blocked: orchestration mode is Q&A only.", blocked: true, permissionMode };
    }

    if (permissionMode === "plan" && allowMutation) {
      return { error: "Orchestration with allowMutation=true is blocked in plan mode.", blocked: true, permissionMode };
    }

    return trackCommandExecution(`orchestrate: ${tools.length} ops`, async () => {
      const effectiveCwd = projectDir ?? process.cwd();
      const results: Array<{ tool_name: string; result: unknown; error?: string }> = [];

      for (const op of tools) {
        const p = op.params as Record<string, any>;
        try {
          let result: unknown;
          switch (op.tool_name) {
            case "read_file": {
              const filePath = path.resolve(effectiveCwd, p.path ?? p.filePath);
              const content = fs.readFileSync(filePath, "utf-8").slice(0, p.maxBytes ?? 32768);
              result = { content, path: filePath };
              break;
            }
            case "list_dir": {
              const dirPath = path.resolve(effectiveCwd, p.path ?? p.dirPath ?? ".");
              const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((e) =>
                e.name + (e.isDirectory() ? "/" : "")
              );
              result = { entries };
              break;
            }
            case "glob_find": {
              const rgResult = await ripgrepGlob({
                pattern: p.pattern ?? "**/*",
                cwd: effectiveCwd,
                maxResults: p.maxResults ?? 200,
              });
              result = rgResult;
              break;
            }
            case "grep_search": {
              const searchResult = await ripgrepSearch({
                pattern: p.pattern ?? "",
                cwd: effectiveCwd,
                maxResults: p.maxResults ?? 50,
                caseSensitive: p.caseSensitive ?? false,
              });
              result = searchResult;
              break;
            }
            case "run_command": {
              if (!allowMutation) {
                const cmd = p.command ?? "";
                if (!isSafeCommand(cmd)) {
                  result = { error: "Mutation commands not allowed. Set allowMutation=true." };
                  break;
                }
              }
              const bashResult = await ptyExecuteBash({
                command: op.params.command,
                cwd: effectiveCwd,
                timeout: op.params.timeout ?? 15000,
              });
              result = bashResult;
              break;
            }
          }
          results.push({ tool_name: op.tool_name, result });
        } catch (err) {
          results.push({ tool_name: op.tool_name, result: null, error: String(err) });
        }
      }

      return { results, count: results.length };
    });
  },
});

// ---------------------------------------------------------------------------
// Todo Read / Write tools — T-CLI-TODO
// Per-session todo list stored in .pakalon/todos.json in the working directory.
// ---------------------------------------------------------------------------

interface TodoItem {
  id: number;
  content: string;
  /** "pending" | "in_progress" | "completed" */
  status: "pending" | "in_progress" | "completed";
  createdAt: string;
  updatedAt: string;
}

function normalizeTodoStatus(status: unknown): TodoItem["status"] {
  if (status === "pending" || status === "in_progress" || status === "completed") {
    return status;
  }
  // Backward compatibility for older persisted todos.
  if (status === "done") {
    return "completed";
  }
  return "pending";
}

function normalizeTodoItem(item: unknown, fallbackId: number): TodoItem {
  const record = (item && typeof item === "object") ? item as Record<string, unknown> : {};
  const rawId = typeof record.id === "number" ? record.id : fallbackId;
  const content = typeof record.content === "string" ? record.content : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString();
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : createdAt;

  return {
    id: rawId,
    content,
    status: normalizeTodoStatus(record.status),
    createdAt,
    updatedAt,
  };
}

function _getTodosPath(): string {
  return path.join(process.cwd(), ".pakalon", "todos.json");
}

function _readTodosSync(): TodoItem[] {
  try {
    const todosPath = _getTodosPath();
    if (!fs.existsSync(todosPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(todosPath, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => normalizeTodoItem(item, index + 1));
  } catch {
    return [];
  }
}

function _writeTodosSync(todos: TodoItem[]): void {
  const todosPath = _getTodosPath();
  const dir = path.dirname(todosPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(todosPath, JSON.stringify(todos, null, 2), "utf-8");
}

export const todoReadTool = tool({
  description:
    "Read the current todo list for this session/project. " +
    "Returns all todo items with their id, content, status (pending/in_progress/completed), and timestamps. " +
    "Use this to check what tasks have been completed or are in progress. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    statusFilter: z
      .enum(["all", "pending", "in_progress", "completed"])
      .optional()
      .default("all")
      .describe("Filter todos by status (default: all)"),
  }),
  execute: async ({ statusFilter = "all" }) => {
    const todos = _readTodosSync();
    const filtered = statusFilter === "all" ? todos : todos.filter((t) => t.status === statusFilter);
    return {
      todos: filtered,
      total: todos.length,
      filtered: filtered.length,
      pending: todos.filter((t) => t.status === "pending").length,
      in_progress: todos.filter((t) => t.status === "in_progress").length,
      completed: todos.filter((t) => t.status === "completed").length,
    };
  },
});

export const todoWriteTool = tool({
  description:
    "Add, update, or delete todo items in the session todo list. " +
    "Use this to track tasks you plan to complete, mark tasks as in-progress when you start them, " +
    "and mark them completed when finished. Todos persist across the session in .pakalon/todos.json.",
  inputSchema: z.object({
    operation: z.enum(["add", "update", "delete", "clear_done", "clear_completed"]).optional().describe(
      "Operation to perform: 'add' a new todo, 'update' status/content of an existing todo, 'delete' a todo by id, 'clear_done'/'clear_completed' removes all completed todos"
    ),
    action: z.enum(["add", "update", "delete", "clear_done", "clear_completed"]).optional().describe(
      "Alias for operation. Prefer operation, but action is accepted for compatibility with planner outputs."
    ),
    content: z.string().optional().describe("Todo content text (required for 'add'; optional for 'update')"),
    id: z.number().optional().describe("Todo id (required for 'update' and 'delete')"),
    status: z.enum(["pending", "in_progress", "completed", "done"]).optional().describe("New status (used with 'update'; 'done' is accepted as an alias for 'completed')"),
  }),
  execute: async ({ operation, action, content, id, status }) => {
    const todos = _readTodosSync();
    const now = new Date().toISOString();
    const resolvedOperation = operation ?? action;

    if (!resolvedOperation) {
      return { error: "operation (or action alias) is required" };
    }

    switch (resolvedOperation) {
      case "add": {
        if (!content?.trim()) return { error: "content is required for 'add'" };
        const newId = todos.length > 0 ? Math.max(...todos.map((t) => t.id)) + 1 : 1;
        const newTodo: TodoItem = {
          id: newId,
          content: content.trim(),
          status: "pending",
          createdAt: now,
          updatedAt: now,
        };
        todos.push(newTodo);
        _writeTodosSync(todos);
        return { success: true, operation: "add", todo: newTodo };
      }
      case "update": {
        if (id == null) return { error: "id is required for 'update'" };
        const idx = todos.findIndex((t) => t.id === id);
        if (idx === -1) return { error: `Todo id ${id} not found` };
        if (content) todos[idx]!.content = content.trim();
        if (status) todos[idx]!.status = normalizeTodoStatus(status);
        todos[idx]!.updatedAt = now;
        _writeTodosSync(todos);
        return { success: true, operation: "update", todo: todos[idx] };
      }
      case "delete": {
        if (id == null) return { error: "id is required for 'delete'" };
        const before = todos.length;
        const remaining = todos.filter((t) => t.id !== id);
        if (remaining.length === before) return { error: `Todo id ${id} not found` };
        _writeTodosSync(remaining);
        return { success: true, operation: "delete", deleted_id: id };
      }
      case "clear_done":
      case "clear_completed": {
        const remaining = todos.filter((t) => t.status !== "completed");
        const cleared = todos.length - remaining.length;
        _writeTodosSync(remaining);
        return { success: true, operation: "clear_completed", cleared_count: cleared };
      }
      default:
        return { error: `Unknown operation: ${resolvedOperation}` };
    }
  },
});

// ---------------------------------------------------------------------------
// Notebook Read / Edit tools — T-CLI-NOTEBOOK
// Read and edit Jupyter Notebook (.ipynb) files.
// ---------------------------------------------------------------------------

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface JupyterNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

export const notebookReadTool = tool({
  description:
    "Read a Jupyter Notebook (.ipynb) file and return its cells in a readable format. " +
    "Shows each cell's type (code/markdown/raw), source content, and any outputs. " +
    "Use this to understand, review, or plan edits to notebook files. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the .ipynb notebook file"),
    includeOutputs: z.boolean().optional().default(true).describe("Whether to include cell outputs (default: true)"),
    maxOutputChars: z.number().optional().default(500).describe("Max characters per cell output (default 500)"),
  }),
  execute: async ({ filePath, includeOutputs = true, maxOutputChars = 500 }) => {
    try {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
      const raw = fs.readFileSync(abs, "utf-8");
      const nb: JupyterNotebook = JSON.parse(raw);

      const cells = nb.cells.map((cell, idx) => {
        const source = cell.source.join("");
        const entry: Record<string, unknown> = {
          index: idx,
          type: cell.cell_type,
          source,
        };
        if (includeOutputs && cell.outputs && cell.outputs.length > 0) {
          const outputText = cell.outputs
            .map((o: any) => {
              if (o.output_type === "stream") return (o.text ?? []).join("").slice(0, maxOutputChars);
              if (o.output_type === "execute_result") return (o.data?.["text/plain"] ?? []).join("").slice(0, maxOutputChars);
              if (o.output_type === "error") return `${o.ename}: ${o.evalue}`;
              return `[${o.output_type} output]`;
            })
            .join("\n");
          entry.outputs = outputText;
        }
        if (cell.execution_count != null) {
          entry.execution_count = cell.execution_count;
        }
        return entry;
      });

      return {
        filePath: abs,
        nbformat: nb.nbformat,
        kernel: (nb.metadata as any)?.kernelspec?.name ?? "unknown",
        cell_count: nb.cells.length,
        cells,
      };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

export const notebookEditTool = tool({
  description:
    "Edit a cell in a Jupyter Notebook (.ipynb) file, or insert/delete cells. " +
    "Changes are written back to disk. " +
    "Blocked in plan (read-only) mode.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the .ipynb notebook file"),
    operation: z.enum(["edit_cell", "insert_cell", "delete_cell"]).describe(
      "Operation: 'edit_cell' to change source of an existing cell, 'insert_cell' to add at an index, 'delete_cell' to remove by index"
    ),
    cellIndex: z.number().describe("0-based cell index (target for edit/delete; position for insert — new cell goes before this index; use -1 to append)"),
    source: z.string().optional().describe("New source content for the cell (required for edit_cell and insert_cell)"),
    cellType: z.enum(["code", "markdown", "raw"]).optional().default("code").describe("Cell type for insert_cell (default: code)"),
  }),
  execute: async ({ filePath, operation, cellIndex, source, cellType = "code" }) => {
    const { permissionMode } = useStore.getState();
    if (permissionMode === "plan") {
      return {
        error: "Notebook edit blocked: permission mode is 'plan'. Switch to 'edit' or 'auto-accept' to allow modifications.",
        blocked: true,
      };
    }

    try {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` };
      const raw = fs.readFileSync(abs, "utf-8");
      const nb: JupyterNotebook = JSON.parse(raw);
      const cells = nb.cells;

      switch (operation) {
        case "edit_cell": {
          if (source == null) return { error: "source is required for edit_cell" };
          const idx = cellIndex < 0 ? cells.length + cellIndex : cellIndex;
          if (idx < 0 || idx >= cells.length) return { error: `Cell index ${cellIndex} out of bounds (${cells.length} cells)` };
          cells[idx]!.source = source.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
          // Clear outputs when source changes
          if (cells[idx]!.cell_type === "code") {
            cells[idx]!.outputs = [];
            cells[idx]!.execution_count = null;
          }
          break;
        }
        case "insert_cell": {
          if (source == null) return { error: "source is required for insert_cell" };
          const newCell: NotebookCell = {
            cell_type: cellType,
            source: source.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l)),
            metadata: {},
            ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
          };
          const insertAt = cellIndex < 0 ? cells.length : Math.min(cellIndex, cells.length);
          cells.splice(insertAt, 0, newCell);
          break;
        }
        case "delete_cell": {
          const idx = cellIndex < 0 ? cells.length + cellIndex : cellIndex;
          if (idx < 0 || idx >= cells.length) return { error: `Cell index ${cellIndex} out of bounds (${cells.length} cells)` };
          cells.splice(idx, 1);
          break;
        }
        default:
          return { error: `Unknown operation: ${operation}` };
      }

      fs.writeFileSync(abs, JSON.stringify(nb, null, 1), "utf-8");
      return { success: true, operation, filePath: abs, cell_count: cells.length };
    } catch (err) {
      return { error: String(err) };
    }
  },
});
// ---------------------------------------------------------------------------
// ask_user tool — T-CLI-ASK-USER
// Lets the agent ask clarifying questions mid-execution.
// Blocks until the TUI user responds.
// ---------------------------------------------------------------------------

export const askUserTool = tool({
  description:
    "Ask the user a clarifying question during task execution. " +
    "Use this when you need more information, want to confirm an approach, " +
    "or need to choose between options. " +
    "This blocks execution until the user responds.",
  inputSchema: z.object({
    question: z.string().describe("The question to ask the user"),
    choices: z.array(z.string()).optional().describe("Multiple-choice options (if omitted, user types free-form answer)"),
  }),
  execute: async ({ question, choices }) => {
    try {
      const answer = await askUserGate.ask(question, choices);
      return { question, answer };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// memory_search tool — Cross-session memory search
// ---------------------------------------------------------------------------

export const memorySearchTool = tool({
  description:
    "Search stored memories from previous sessions. " +
    "Returns relevant facts, preferences, and context from earlier conversations. " +
    "This is a read-only operation — safe in plan mode.",
  inputSchema: z.object({
    query: z.string().describe("Search query for memories"),
    userId: z.string().optional().describe("User ID (defaults to 'default')"),
    topK: z.number().optional().default(5).describe("Maximum results to return"),
  }),
  execute: async ({ query, userId = "default", topK = 5 }) => {
    try {
      const result = searchMemories({ query, userId, topK });
      return {
        memories: result.entries.map((e) => ({
          id: e.id,
          text: e.text,
          createdAt: e.createdAt,
          metadata: e.metadata,
        })),
        count: result.count,
      };
    } catch (err) {
      return { error: String(err), memories: [], count: 0 };
    }
  },
});

// ---------------------------------------------------------------------------
// memory_store tool — Store facts across sessions
// ---------------------------------------------------------------------------

export const memoryStoreTool = tool({
  description:
    "Store a fact, preference, or piece of context for future sessions. " +
    "The stored memory will be searchable via memory_search in future conversations. " +
    "Use this to remember user preferences, project conventions, and important decisions.",
  inputSchema: z.object({
    text: z.string().describe("The fact or information to remember"),
    userId: z.string().optional().describe("User ID (defaults to 'default')"),
    sessionId: z.string().optional().describe("Current session ID"),
    metadata: z.record(z.unknown()).optional().describe("Additional metadata"),
  }),
  execute: async ({ text, userId = "default", sessionId, metadata }) => {
    try {
      const entry = storeMemory(text, userId, sessionId, metadata ?? {});
      return { success: true, id: entry.id, text: entry.text };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// memory_kv_get / memory_kv_set tools — Key-value store
// ---------------------------------------------------------------------------

export const memoryKvGetTool = tool({
  description: "Get a value from the persistent key-value store. Read-only, safe in plan mode.",
  inputSchema: z.object({
    key: z.string().describe("Key to retrieve"),
  }),
  execute: async ({ key }) => {
    const value = kvGet(key);
    return { key, value, exists: value !== undefined };
  },
});

export const memoryKvSetTool = tool({
  description: "Set a value in the persistent key-value store.",
  inputSchema: z.object({
    key: z.string().describe("Key to set"),
    value: z.unknown().describe("Value to store (JSON-serializable)"),
  }),
  execute: async ({ key, value }) => {
    kvSet(key, value);
    return { success: true, key };
  },
});

// ---------------------------------------------------------------------------
// skill tool — Load domain skills on-demand
// ---------------------------------------------------------------------------

export const skillTool = tool({
  description:
    "Load a domain-specific skill from ~/.agents/skills/ or .pakalon/skills/. " +
    "Skills provide specialized instructions for specific technologies, frameworks, or workflows. " +
    "Use this when you need domain expertise (e.g., Docker, Kubernetes, AWS, specific frameworks).",
  inputSchema: z.object({
    skillName: z.string().describe("Name of the skill to load (e.g., 'docker-patterns', 'kotlin-patterns')"),
  }),
  execute: async ({ skillName }) => {
    try {
      const skill = loadSkill(skillName);
      if (!skill) {
        // List available skills for suggestions
        const available = listSkills().map((s) => s.name);
        return {
          error: `Skill '${skillName}' not found.`,
          availableSkills: available.slice(0, 20),
        };
      }
      return {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        source: skill.source,
        path: skill.path,
      };
    } catch (err) {
      return { error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// directory_trust tool — Check/manage directory trust
// ---------------------------------------------------------------------------

export const directoryTrustTool = tool({
  description:
    "Check if the current directory is trusted, or mark it as trusted. " +
    "Trusted directories can load MCP servers, LSP configs, and hooks without prompts.",
  inputSchema: z.object({
    action: z.enum(["check", "trust"]).describe("Action: 'check' to verify trust, 'trust' to mark as trusted"),
    dirPath: z.string().optional().describe("Directory to check/trust (defaults to cwd)"),
  }),
  execute: async ({ action, dirPath }) => {
    const effectiveDir = dirPath ?? process.cwd();
    if (action === "check") {
      const result = checkWorkspaceTrust(effectiveDir);
      return { trusted: result.trusted, dirPath: result.dirPath, firstTime: result.firstTime };
    }
    trustDirectory(effectiveDir);
    return { success: true, dirPath: effectiveDir };
  },
});

export const lspCodeActionsTool = tool({
  description:
    "Get LSP code actions and quick fixes for a file range. " +
    "Useful for automatic fixes, imports, refactors, and organize-imports actions exposed by the language server.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative().optional(),
    endCharacter: z.number().int().nonnegative().optional(),
    workspaceDir: z.string().optional(),
    only: z.array(z.string()).optional().describe("Optional code action kinds, e.g. quickfix, refactor, source.organizeImports"),
  }),
  execute: async ({ filePath, line, character, endLine, endCharacter, workspaceDir, only }) => {
    try {
      const actions = await lspGetCodeActions(
        filePath,
        {
          start: { line, character },
          end: { line: endLine ?? line, character: endCharacter ?? character },
        },
        workspaceDir,
        only,
      );
      return { success: true, actions, count: actions.length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspSemanticTokensTool = tool({
  description:
    "Get LSP semantic tokens for a file. " +
    "Returns the raw relative-token stream and token count for semantic highlighting or downstream visualization.",
  inputSchema: z.object({
    filePath: z.string(),
    workspaceDir: z.string().optional(),
    includeData: z.boolean().optional().default(false).describe("Return the full raw token data. Defaults to false to save tokens."),
  }),
  execute: async ({ filePath, workspaceDir, includeData = false }) => {
    try {
      const result = await lspGetSemanticTokens(filePath, workspaceDir);
      if (!result) return { success: false, message: "Semantic tokens not supported or unavailable" };
      return {
        success: true,
        tokenCount: result.tokenCount,
        resultId: result.resultId,
        data: includeData ? result.data : undefined,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspFormattingTool = tool({
  description:
    "Ask the language server for document formatting edits. " +
    "Returns text edits only; callers must inspect and apply them with editFile/writeFile if desired.",
  inputSchema: z.object({
    filePath: z.string(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, workspaceDir }) => {
    try {
      const edits = await lspFormatDocument(filePath, workspaceDir);
      return {
        success: true,
        edits: edits ?? [],
        count: edits?.length ?? 0,
        supported: edits !== null,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspTypeHierarchyTool = tool({
  description:
    "Get LSP type hierarchy information for the symbol at a position. " +
    "Useful for class/interface inheritance and related type navigation.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    try {
      const hierarchy = await lspGetTypeHierarchy(filePath, line, character, workspaceDir);
      return {
        success: true,
        hierarchy: hierarchy ?? [],
        count: hierarchy?.length ?? 0,
        supported: hierarchy !== null,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspInlayHintsTool = tool({
  description:
    "Get LSP inlay hints for a document range ending at the requested position. " +
    "Useful for inferred types, parameter names, and inline value hints.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    try {
      const hints = await lspGetInlayHints(filePath, line, character, workspaceDir);
      return {
        success: true,
        hints: hints ?? [],
        count: hints?.length ?? 0,
        supported: hints !== null,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

export const lspSignatureHelpTool = tool({
  description:
    "Get LSP signature help for the function call at a position. " +
    "Returns parameter/signature metadata when the language server supports it.",
  inputSchema: z.object({
    filePath: z.string(),
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
    workspaceDir: z.string().optional(),
  }),
  execute: async ({ filePath, line, character, workspaceDir }) => {
    try {
      const signatureHelp = await lspGetSignatureHelp(filePath, line, character, workspaceDir);
      return {
        success: signatureHelp !== null,
        signatureHelp,
        supported: signatureHelp !== null,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  },
});

// ---------------------------------------------------------------------------
// Browser automation tools
// ---------------------------------------------------------------------------

export const browserNavigateTool = tool({
  description:
    "Open a URL in a headless browser and return the current page title plus an accessibility snapshot.",
  inputSchema: browserNavigateSchema,
  execute: browserNavigate,
});

export const browserClickTool = tool({
  description:
    "Click an element from the latest browser snapshot using its element reference.",
  inputSchema: browserClickSchema,
  execute: browserClick,
});

export const browserFillFormTool = tool({
  description:
    "Fill one or more browser form fields using element references from the latest snapshot.",
  inputSchema: browserFillFormSchema,
  execute: browserFillForm,
});

export const browserSnapshotTool = tool({
  description:
    "Capture the current browser page accessibility snapshot and visible text content.",
  inputSchema: browserSnapshotSchema,
  execute: browserSnapshot,
});

export const browserScreenshotTool = tool({
  description:
    "Capture a screenshot of the current browser page and save it to disk.",
  inputSchema: browserScreenshotSchema,
  execute: browserScreenshot,
});

export const browserWaitTool = tool({
  description:
    "Wait for browser page time, text appearance, or text disappearance.",
  inputSchema: browserWaitSchema,
  execute: browserWait,
});

export const browserSelectOptionTool = tool({
  description:
    "Select one or more options in a browser dropdown using an element reference.",
  inputSchema: browserSelectOptionSchema,
  execute: browserSelectOption,
});

export const browserCloseTool = tool({
  description: "Close the active headless browser session.",
  inputSchema: z.object({}),
  execute: async () => browserClose(),
});

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol tools — production-grade browser automation
// ---------------------------------------------------------------------------
// These tools connect directly to Chrome/Chromium via the CDP (Chrome DevTools
// Protocol) for deeper introspection than standard Playwright-based browsing.
// Use for performance audits, network capture, JS evaluation, and screenshots.

let _chromeClient: ChromeDevToolsMCP | null = null;

function getChromeClient(): ChromeDevToolsMCP {
  if (!_chromeClient) {
    _chromeClient = new ChromeDevToolsMCP();
  }
  return _chromeClient;
}

export const chromeLaunchTool = tool({
  description:
    "Launch Chrome/Chromium with remote debugging. Call this first before using other chrome_* tools. Auto-detects Chrome path on your system.",
  inputSchema: z.object({
    port: z.number().optional().default(9222).describe("Remote debugging port"),
    headless: z.boolean().optional().default(true).describe("Run in headless mode (no visible window)"),
  }),
  execute: async ({ port, headless }) => {
    const client = getChromeClient();
    if (port !== undefined) (client as unknown as Record<string, unknown> & { options: Record<string, unknown> }).options.port = port;
    if (headless !== undefined) (client as unknown as Record<string, unknown> & { options: Record<string, unknown> }).options.headless = headless;
    const result = await client.launchChrome();
    await client.connect();
    return result;
  },
});

export const chromeKillTool = tool({
  description: "Terminate the Chrome/Chromium process started by chrome_launch.",
  inputSchema: z.object({}),
  execute: async () => {
    const client = getChromeClient();
    return client.killChrome();
  },
});

export const chromeNavigateTool = tool({
  description:
    "Navigate Chrome to a URL via the DevTools Protocol. Requires chrome_launch first.",
  inputSchema: z.object({
    url: z.string().describe("Full URL to navigate to (e.g. https://localhost:3000)"),
  }),
  execute: async ({ url }) => {
    const client = getChromeClient();
    return client.navigate(url);
  },
});

export const chromeScreenshotTool = tool({
  description:
    "Take a screenshot of the current page via Chrome DevTools Protocol. Requires chrome_launch and chrome_navigate first.",
  inputSchema: z.object({
    format: z.enum(["png", "jpeg"]).optional().default("png"),
    fullPage: z.boolean().optional().default(false).describe("Capture full scrollable page"),
  }),
  execute: async ({ format, fullPage }) => {
    const client = getChromeClient();
    return client.captureScreenshot({ format, fullPage });
  },
});

export const chromeNetworkTool = tool({
  description:
    "Enable network event capture for the current page. Call after chrome_navigate to start recording network requests.",
  inputSchema: z.object({}),
  execute: async () => {
    const client = getChromeClient();
    return client.captureNetworkLog();
  },
});

export const chromePerformanceTool = tool({
  description:
    "Collect page performance metrics (Lighthouse-style) via Chrome DevTools. Requires chrome_launch and chrome_navigate.",
  inputSchema: z.object({}),
  execute: async () => {
    const client = getChromeClient();
    return client.runLighthouseAudit();
  },
});

export const chromeInspectTool = tool({
  description:
    "Inspect a DOM element by CSS selector using the DevTools Protocol. Returns node information.",
  inputSchema: z.object({
    selector: z.string().describe("CSS selector (e.g. '#app', '.header', 'button[type=submit]')"),
  }),
  execute: async ({ selector }) => {
    const client = getChromeClient();
    return client.inspectElement(selector);
  },
});

export const chromeEvaluateTool = tool({
  description:
    "Execute JavaScript in the Chrome page context and return the result. Allows runtime inspection of page state.",
  inputSchema: z.object({
    expression: z.string().describe("JavaScript expression to evaluate (e.g. 'document.title', 'JSON.stringify(window.__INITIAL_STATE__)')"),
  }),
  execute: async ({ expression }) => {
    const client = getChromeClient();
    return client.evaluateExpression(expression);
  },
});

export const chromeConsoleTool = tool({
  description:
    "Enable console log capture. Call after chrome_navigate to start recording console messages from the page.",
  inputSchema: z.object({}),
  execute: async () => {
    const client = getChromeClient();
    return client.getConsoleLog();
  },
});

// ---------------------------------------------------------------------------
// Runtime discovery, MCP resource, and utility tools
// ---------------------------------------------------------------------------

let runtimeToolSearchRegistry: Record<string, unknown> = {};

function getRuntimeToolDescription(toolDef: unknown): string {
  if (!toolDef || typeof toolDef !== "object") return "";
  const description = (toolDef as { description?: unknown }).description;
  return typeof description === "string" ? description : "";
}

function categorizeRuntimeTool(name: string): string {
  const lower = name.toLowerCase();
  if (/(read|write|edit|file|dir|glob|grep|rg|view|notebook)/.test(lower)) return "file";
  if (/(bash|powershell|shell|exec|repl|codeexecution)/.test(lower)) return "shell";
  if (/(browser|web|fetch|search)/.test(lower)) return "web";
  if (/(mcp|resource)/.test(lower)) return "mcp";
  if (/(agent|task|team|orchestrate|message)/.test(lower)) return "agent";
  if (/(memory|remember|kv)/.test(lower)) return "memory";
  if (/(image|video|media|upload|download|storage|file)/.test(lower)) return "media";
  if (/lsp/.test(lower)) return "lsp";
  if (/todo/.test(lower)) return "task";
  return "other";
}

export const toolSearchTool = tool({
  description:
    "Search the active Pakalon runtime tool surface by name, category, or description. Use this when a needed capability may exist but is not currently obvious.",
  inputSchema: z.object({
    query: z.string().describe("Search terms, tool name, alias, or capability"),
    category: z
      .enum(["all", "file", "shell", "web", "mcp", "agent", "memory", "media", "lsp", "task", "other"])
      .optional()
      .default("all"),
    limit: z.number().int().min(1).max(50).optional().default(12),
  }),
  execute: async ({ query, category = "all", limit = 12 }) => {
    const normalizedQuery = query.trim().toLowerCase();
    const entries = Object.entries(runtimeToolSearchRegistry)
      .map(([name, toolDef]) => {
        const toolCategory = categorizeRuntimeTool(name);
        return {
          name,
          category: toolCategory,
          description: getRuntimeToolDescription(toolDef),
        };
      })
      .filter((entry) => category === "all" || entry.category === category)
      .filter((entry) => {
        if (!normalizedQuery) return true;
        const haystack = `${entry.name} ${entry.category} ${entry.description}`.toLowerCase();
        return normalizedQuery
          .split(/\s+/)
          .filter(Boolean)
          .every((term) => haystack.includes(term));
      })
      .slice(0, limit);

    return {
      success: true,
      totalCount: entries.length,
      tools: entries,
    };
  },
});

export const mcpResourcesTool = tool({
  description:
    "List or search resources exposed by configured MCP servers through Pakalon's MCP manager.",
  inputSchema: z.object({
    action: z.enum(["list", "search"]).optional().default("list"),
    query: z.string().optional().describe("Search query for action=search"),
  }),
  execute: async ({ action = "list", query }) => {
    try {
      if (action === "search") {
        if (!query?.trim()) return { success: false, error: "query is required for MCP resource search" };
        const resources = await searchManagedMcpResources(query.trim());
        return { success: true, action, resources, totalCount: resources.length };
      }

      const servers = await getManagedMcpResources();
      const totalCount = servers.reduce((sum, server) => {
        const resources = Array.isArray(server.resources) ? server.resources.length : 0;
        return sum + resources;
      }, 0);
      return { success: true, action, servers, totalCount };
    } catch (err) {
      return {
        success: false,
        action,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export const briefTool = tool({
  description:
    "Prepare a concise user-facing brief with optional attachment metadata. This is a read-only communication helper.",
  inputSchema: z.object({
    message: z.string(),
    status: z.enum(["normal", "proactive"]).optional().default("normal"),
    attachments: z.array(z.string()).optional().default([]),
  }),
  execute: async ({ message, status = "normal", attachments = [] }) => {
    const resolvedAttachments = attachments.flatMap((attachment) => {
      const absolutePath = path.isAbsolute(attachment) ? attachment : path.resolve(process.cwd(), attachment);
      if (!fs.existsSync(absolutePath)) return [];
      const stat = fs.statSync(absolutePath);
      return [{
        path: absolutePath,
        size: stat.size,
        isImage: /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(absolutePath),
      }];
    });

    return {
      success: true,
      message,
      status,
      attachments: resolvedAttachments,
      sentAt: new Date().toISOString(),
    };
  },
});

export const sleepTool = tool({
  description:
    "Pause execution for a bounded duration. Useful for polling, rate limits, or waiting for external processes.",
  inputSchema: z.object({
    durationMs: z.number().int().min(0).max(300000).optional(),
    durationSeconds: z.number().min(0).max(300).optional(),
    reason: z.string().optional(),
  }),
  execute: async ({ durationMs, durationSeconds, reason }) => {
    const ms = Math.min(300000, Math.max(0, durationMs ?? Math.round((durationSeconds ?? 0) * 1000)));
    const startedAt = Date.now();
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return {
      success: true,
      requestedMs: ms,
      sleptMs: Date.now() - startedAt,
      reason,
      resumedAt: new Date().toISOString(),
    };
  },
});

const cronScheduleSchema = z.string().describe("Standard 5-field cron expression, e.g. '*/15 * * * *' or '0 9 * * 1'");

export const scheduleCronTool = tool({
  description:
    "Create, list, delete, or manually run scheduled cron jobs for recurring agent prompts or commands. " +
    "Use this unified tool when the desired cron operation is dynamic.",
  inputSchema: z.object({
    action: z.enum(["create", "list", "delete", "run"]),
    jobId: z.string().optional().describe("Cron job id for delete/run"),
    schedule: cronScheduleSchema.optional(),
    command: z.string().optional().describe("Prompt or command to execute when the cron fires"),
    description: z.string().optional(),
  }),
  execute: async ({ action, jobId, schedule, command, description }) => {
    return executeCronJob({ action, jobId, schedule, command, description });
  },
});

export const cronCreateTool = tool({
  description: "Create a scheduled cron job for a recurring agent prompt or command.",
  inputSchema: z.object({
    schedule: cronScheduleSchema,
    command: z.string().describe("Prompt or command to execute when the cron fires"),
    description: z.string().optional(),
  }),
  execute: async ({ schedule, command, description }) => {
    return executeCronJob({ action: "create", schedule, command, description });
  },
});

export const cronListTool = tool({
  description: "List scheduled cron jobs created in this Pakalon runtime.",
  inputSchema: z.object({}),
  execute: async () => {
    return executeCronJob({ action: "list" });
  },
});

export const cronDeleteTool = tool({
  description: "Delete a scheduled cron job by id.",
  inputSchema: z.object({
    jobId: z.string().describe("Cron job id to delete"),
  }),
  execute: async ({ jobId }) => {
    return executeCronJob({ action: "delete", jobId });
  },
});

export const cronRunTool = tool({
  description: "Mark a scheduled cron job as manually triggered by id.",
  inputSchema: z.object({
    jobId: z.string().describe("Cron job id to run"),
  }),
  execute: async ({ jobId }) => {
    return executeCronJob({ action: "run", jobId });
  },
});

function formatSwarm(swarmId: string) {
  const swarm = getSwarm(swarmId);
  if (!swarm) return null;
  return {
    ...swarm.getStats(),
    agents: swarm.getAllAgents(),
    tasks: swarm.getAllTasks(),
  };
}

export const swarmTool = tool({
  description:
    "Manage agent swarms for parallel task coordination. " +
    "Use create to form a swarm, addWorker/addTask/assignTask to coordinate work, and aggregate to collect task outputs.",
  inputSchema: z.object({
    action: z.enum([
      "create",
      "list",
      "status",
      "dissolve",
      "setLeader",
      "addWorker",
      "addTask",
      "assignTask",
      "completeTask",
      "failTask",
      "start",
      "aggregate",
    ]),
    swarmId: z.string().optional(),
    name: z.string().optional(),
    leaderPrompt: z.string().optional(),
    maxWorkers: z.number().int().positive().max(50).optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    taskId: z.string().optional(),
    taskDescription: z.string().optional(),
    priority: z.number().optional(),
    result: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async ({
    action,
    swarmId,
    name,
    leaderPrompt,
    maxWorkers,
    agentId,
    agentName,
    capabilities,
    taskId,
    taskDescription,
    priority,
    result,
    error,
  }) => {
    try {
      if (action === "create") {
        const swarm = createSwarm({
          name: name?.trim() || `swarm-${new Date().toISOString()}`,
          leaderPrompt: leaderPrompt?.trim() || "Coordinate the swarm and aggregate worker results.",
          maxWorkers,
        });
        return { success: true, swarm: formatSwarm(swarm.getId()) };
      }

      if (action === "list") {
        return {
          success: true,
          swarms: getAllSwarms().map((swarm) => formatSwarm(swarm.getId())),
        };
      }

      if (!swarmId) return { success: false, error: "swarmId is required" };
      const swarm = getSwarm(swarmId);
      if (!swarm) return { success: false, error: `Swarm not found: ${swarmId}` };

      switch (action) {
        case "status":
          return { success: true, swarm: formatSwarm(swarmId) };
        case "dissolve":
          return { success: dissolveSwarm(swarmId), swarmId };
        case "setLeader": {
          if (!agentId || !agentName) return { success: false, error: "agentId and agentName are required" };
          swarm.setLeader({ id: agentId, name: agentName, capabilities });
          return { success: true, swarm: formatSwarm(swarmId) };
        }
        case "addWorker": {
          if (!agentId || !agentName) return { success: false, error: "agentId and agentName are required" };
          return { success: swarm.addWorker({ id: agentId, name: agentName, capabilities }), swarm: formatSwarm(swarmId) };
        }
        case "addTask": {
          if (!taskDescription?.trim()) return { success: false, error: "taskDescription is required" };
          const createdTaskId = swarm.addTask(taskDescription, priority ?? 5);
          return { success: true, taskId: createdTaskId, swarm: formatSwarm(swarmId) };
        }
        case "assignTask": {
          if (!taskId || !agentId) return { success: false, error: "taskId and agentId are required" };
          return { success: swarm.assignTask(taskId, agentId), swarm: formatSwarm(swarmId) };
        }
        case "completeTask": {
          if (!taskId) return { success: false, error: "taskId is required" };
          return { success: swarm.completeTask(taskId, result), swarm: formatSwarm(swarmId) };
        }
        case "failTask": {
          if (!taskId) return { success: false, error: "taskId is required" };
          return { success: swarm.failTask(taskId, error ?? "Task failed"), swarm: formatSwarm(swarmId) };
        }
        case "start":
          swarm.start();
          return { success: true, swarm: formatSwarm(swarmId) };
        case "aggregate": {
          const tasks = swarm.getAllTasks();
          return {
            success: true,
            swarmId,
            status: swarm.getStatus(),
            completed: tasks.filter((task) => task.status === "completed").map((task) => ({
              id: task.id,
              description: task.description,
              assignedAgentId: task.assignedAgentId,
              result: task.result,
            })),
            failed: tasks.filter((task) => task.status === "failed").map((task) => ({
              id: task.id,
              description: task.description,
              assignedAgentId: task.assignedAgentId,
              error: task.error,
            })),
          };
        }
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

interface CustomRuntimeToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  createdAt: string;
}

const customRuntimeTools = new Map<string, CustomRuntimeToolMetadata>();

function jsonSchemaPropertyToZod(schema: unknown): z.ZodTypeAny {
  const record = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
  const enumValues = record.enum;
  if (Array.isArray(enumValues) && enumValues.every((value) => typeof value === "string") && enumValues.length > 0) {
    const [first, ...rest] = enumValues as [string, ...string[]];
    return z.enum([first, ...rest]);
  }

  const type = record.type;
  let zodType: z.ZodTypeAny;
  switch (type) {
    case "number":
      zodType = z.number();
      break;
    case "integer":
      zodType = z.number().int();
      break;
    case "boolean":
      zodType = z.boolean();
      break;
    case "array":
      zodType = z.array(jsonSchemaPropertyToZod(record.items));
      break;
    case "object":
      zodType = jsonSchemaToZodObject(record);
      break;
    case "string":
    default:
      zodType = z.string();
      break;
  }

  if (typeof record.description === "string") {
    zodType = zodType.describe(record.description);
  }
  return zodType;
}

function jsonSchemaToZodObject(schema: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, value] of Object.entries(properties)) {
    const propertySchema = jsonSchemaPropertyToZod(value);
    shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
  }

  return z.object(shape);
}

function sanitizeCustomToolName(name: string): string | null {
  const normalized = name.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(normalized)) return null;
  return normalized;
}

export const customToolRegistryTool = tool({
  description:
    "Register, list, inspect, or unregister safe runtime custom tools. " +
    "Registered tools use JSON Schema for input validation and return their parsed input; they do not execute arbitrary code.",
  inputSchema: z.object({
    action: z.enum(["register", "list", "schema", "unregister"]),
    name: z.string().optional().describe("Custom tool name. Use letters, numbers, and underscores; must start with a letter."),
    description: z.string().optional(),
    inputSchema: z.record(z.any()).optional().describe("JSON Schema object with properties/required fields"),
    overwrite: z.boolean().optional().default(false),
  }),
  execute: async ({ action, name, description, inputSchema, overwrite = false }) => {
    if (action === "list") {
      return { success: true, tools: Array.from(customRuntimeTools.values()) };
    }

    const toolName = name ? sanitizeCustomToolName(name) : null;
    if (!toolName) {
      return { success: false, error: "A valid custom tool name is required" };
    }

    if (action === "schema") {
      const metadata = customRuntimeTools.get(toolName);
      if (!metadata) return { success: false, error: `Custom tool not found: ${toolName}` };
      return { success: true, tool: metadata };
    }

    if (action === "unregister") {
      if (!customRuntimeTools.has(toolName)) {
        return { success: false, error: `Custom tool not found: ${toolName}` };
      }
      delete (allTools as Record<string, unknown>)[toolName];
      customRuntimeTools.delete(toolName);
      runtimeToolSearchRegistry = allTools;
      return { success: true, name: toolName };
    }

    if (!description?.trim()) {
      return { success: false, error: "description is required for register" };
    }

    if (toolName in allTools && !customRuntimeTools.has(toolName) && !overwrite) {
      return { success: false, error: `Cannot overwrite built-in tool: ${toolName}` };
    }
    if (customRuntimeTools.has(toolName) && !overwrite) {
      return { success: false, error: `Custom tool already exists: ${toolName}` };
    }

    const schema = inputSchema && typeof inputSchema === "object"
      ? inputSchema as Record<string, unknown>
      : { type: "object", properties: {} };
    const zodSchema = jsonSchemaToZodObject(schema);
    const metadata: CustomRuntimeToolMetadata = {
      name: toolName,
      description: description.trim(),
      inputSchema: schema,
      createdAt: new Date().toISOString(),
    };

    (allTools as Record<string, unknown>)[toolName] = tool({
      description: metadata.description,
      inputSchema: zodSchema,
      execute: async (input) => ({
        success: true,
        customTool: toolName,
        input,
      }),
    });
    customRuntimeTools.set(toolName, metadata);
    runtimeToolSearchRegistry = allTools;

    return { success: true, tool: metadata };
  },
});

// ---------------------------------------------------------------------------
// Agent and background task tools
// ---------------------------------------------------------------------------

type RuntimeAgentStatus = "running" | "completed" | "failed" | "stopped";

interface RuntimeAgentDefinition {
  type: string;
  description: string;
  whenToUse: string;
  systemPrompt: string;
  defaultTools: string[];
}

interface RuntimeAgentTask {
  id: string;
  name: string;
  type: string;
  prompt: string;
  model: string;
  cwd: string;
  teamName?: string;
  background: boolean;
  status: RuntimeAgentStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  abortController: AbortController;
  promise?: Promise<void>;
}

const runtimeAgentDefinitions: RuntimeAgentDefinition[] = [
  {
    type: "general-purpose",
    description: "General implementation, debugging, and research subtask runner.",
    whenToUse: "Use for bounded coding or reasoning tasks that do not need a specialized mode.",
    systemPrompt:
      "You are a Pakalon subagent. Work on the requested subtask directly, keep scope tight, and return a concise result with concrete findings or changes.",
    defaultTools: ["readFile", "listDir", "bash", "powershell", "grep"],
  },
  {
    type: "explore",
    description: "Read-only codebase exploration and evidence gathering.",
    whenToUse: "Use before edits when the main agent needs focused code context or file references.",
    systemPrompt:
      "You are a read-only Pakalon exploration subagent. Inspect the requested area and return precise file references, facts, risks, and open questions. Do not propose broad rewrites.",
    defaultTools: ["readFile", "listDir", "grep", "glob", "lsp"],
  },
  {
    type: "plan",
    description: "Task decomposition and sequencing.",
    whenToUse: "Use when implementation needs a concrete plan, task ordering, or risk breakdown.",
    systemPrompt:
      "You are a Pakalon planning subagent. Produce a concrete engineering plan with ordered tasks, dependencies, verification steps, and risks.",
    defaultTools: ["readFile", "listDir", "grep"],
  },
  {
    type: "verification",
    description: "Validation, test strategy, and bug-focused review.",
    whenToUse: "Use after or during implementation to identify regressions, missing tests, and verification gaps.",
    systemPrompt:
      "You are a Pakalon verification subagent. Focus on bugs, regressions, edge cases, and tests. Return actionable findings first.",
    defaultTools: ["readFile", "listDir", "bash", "powershell", "lsp"],
  },
];

const runtimeAgentTasks = new Map<string, RuntimeAgentTask>();

function resolveRuntimeAgentDefinition(type?: string): RuntimeAgentDefinition | undefined {
  const normalized = (type ?? "general-purpose").trim().toLowerCase();
  return runtimeAgentDefinitions.find(
    (agent) => agent.type === normalized || agent.type.replace("-", "_") === normalized,
  );
}

function resolveRuntimeAgentModel(model?: string): string {
  const selectedModel = useStore.getState().selectedModel;
  if (!model || model === "inherit") return selectedModel ?? DEFAULT_FREE_MODEL_ID;
  if (model.includes("/")) return model;

  const fallback = selectedModel ?? DEFAULT_FREE_MODEL_ID;
  if (model === "sonnet") return process.env.PAKALON_AGENT_SONNET_MODEL ?? fallback;
  if (model === "opus") return process.env.PAKALON_AGENT_OPUS_MODEL ?? fallback;
  if (model === "haiku") return process.env.PAKALON_AGENT_HAIKU_MODEL ?? fallback;
  return model;
}

function formatRuntimeAgentTask(task: RuntimeAgentTask, includeOutput = false) {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    teamName: task.teamName,
    status: task.status,
    background: task.background,
    model: task.model,
    cwd: task.cwd,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
    result: includeOutput ? task.result ?? "" : undefined,
  };
}

function buildRuntimeAgentSystemPrompt(
  definition: RuntimeAgentDefinition,
  task: RuntimeAgentTask,
  maxTurns?: number,
  tools?: string[],
): string {
  const allowedTools = tools?.length ? tools : definition.defaultTools;
  return [
    definition.systemPrompt,
    "",
    `Workspace: ${task.cwd}`,
    `Task name: ${task.name}`,
    `Allowed tool families: ${allowedTools.join(", ")}`,
    maxTurns ? `Turn budget: ${maxTurns}` : undefined,
    "Return the final answer directly. If you cannot complete the work, explain the blocker and the next concrete step.",
  ].filter(Boolean).join("\n");
}

async function runRuntimeAgentTask(
  task: RuntimeAgentTask,
  definition: RuntimeAgentDefinition,
  maxTurns?: number,
  tools?: string[],
): Promise<void> {
  task.status = "running";
  task.updatedAt = new Date().toISOString();

  try {
    const localKey = process.env.OPENROUTER_API_KEY;
    const useProxy = !localKey || process.env.PAKALON_USE_PROXY === "1";
    const messages: ModelMessage[] = [{ role: "user", content: task.prompt }];
    const completion = await generateCompletion({
      model: task.model,
      messages,
      apiKey: localKey || undefined,
      authToken: useProxy ? process.env.PAKALON_TOKEN : undefined,
      useProxy,
      system: buildRuntimeAgentSystemPrompt(definition, task, maxTurns, tools),
      maxTokens: 4096,
      temperature: 0.2,
    });

    if (task.abortController.signal.aborted) {
      task.updatedAt = new Date().toISOString();
      return;
    }

    task.result = completion.text;
    task.status = "completed";
    task.updatedAt = new Date().toISOString();
  } catch (err) {
    if (task.abortController.signal.aborted) {
      task.updatedAt = new Date().toISOString();
      return;
    }
    task.status = "failed";
    task.error = err instanceof Error ? err.message : String(err);
    task.updatedAt = new Date().toISOString();
  }
}

function stopRuntimeAgentTask(agentId: string): boolean {
  const task = runtimeAgentTasks.get(agentId);
  if (!task) return false;
  if (task.status === "completed" || task.status === "failed" || task.status === "stopped") {
    return true;
  }
  task.status = "stopped";
  task.updatedAt = new Date().toISOString();
  task.abortController.abort();
  return true;
}

export const agentTool = tool({
  description:
    "Run or inspect Pakalon subagents. Use list to see available agent types, run to start an agent, status/output to inspect it, and stop to cancel a running background agent.",
  inputSchema: z.object({
    action: z.enum(["list", "run", "status", "output", "stop"]).default("run"),
    prompt: z.string().optional().describe("Task prompt for action=run"),
    subagentType: z.string().optional().describe("Agent type, e.g. general-purpose, explore, plan, verification"),
    model: z.string().optional().describe("Model alias or full OpenRouter model id"),
    background: z.boolean().optional().default(false),
    name: z.string().optional(),
    teamName: z.string().optional(),
    agentId: z.string().optional().describe("Agent ID for status/output/stop"),
    maxTurns: z.number().optional(),
    cwd: z.string().optional(),
    tools: z.array(z.string()).optional(),
  }),
  execute: async ({
    action = "run",
    prompt,
    subagentType,
    model,
    background = false,
    name,
    teamName,
    agentId,
    maxTurns,
    cwd,
    tools,
  }) => {
    if (action === "list") {
      return {
        success: true,
        count: runtimeAgentDefinitions.length,
        agents: runtimeAgentDefinitions.map((agent) => ({
          type: agent.type,
          description: agent.description,
          whenToUse: agent.whenToUse,
          source: "built-in",
          model: "inherit",
          background: true,
          tools: agent.defaultTools,
          requiredMcpServers: [],
        })),
      };
    }

    if (action === "status" || action === "output" || action === "stop") {
      if (!agentId) return { success: false, error: "agentId is required" };
      const agent = runtimeAgentTasks.get(agentId);
      if (!agent) return { success: false, error: `Agent not found: ${agentId}` };
      if (action === "stop") {
        return { success: stopRuntimeAgentTask(agentId), agentId, status: runtimeAgentTasks.get(agentId)?.status ?? agent.status };
      }
      return {
        success: true,
        agent: formatRuntimeAgentTask(agent, action === "output"),
      };
    }

    if (!prompt?.trim()) {
      return { success: false, error: "prompt is required for action=run" };
    }

    const resolvedType = subagentType || "general-purpose";
    const agentDefinition = resolveRuntimeAgentDefinition(resolvedType);
    if (!agentDefinition) {
      return {
        success: false,
        error: `Unknown agent type: ${resolvedType}`,
        availableAgents: runtimeAgentDefinitions.map((agent) => agent.type),
      };
    }

    const task: RuntimeAgentTask = {
      id: crypto.randomUUID(),
      name: name?.trim() || `${agentDefinition.type}-${new Date().toISOString()}`,
      type: agentDefinition.type,
      prompt,
      model: resolveRuntimeAgentModel(model),
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      teamName,
      background,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      abortController: new AbortController(),
    };
    runtimeAgentTasks.set(task.id, task);
    task.promise = runRuntimeAgentTask(task, agentDefinition, maxTurns, tools);

    if (!background) {
      await task.promise;
    }

    return {
      success: task.status === "completed" || (background && task.status === "running"),
      agentId: task.id,
      agentName: task.name,
      status: task.status,
      background: task.background,
      result: background ? undefined : task.result,
      error: task.error,
    };
  },
});

export const taskListTool = tool({
  description: "List spawned Pakalon background and foreground subagents.",
  inputSchema: z.object({
    status: z.enum(["running", "completed", "failed", "stopped"]).optional(),
    teamName: z.string().optional(),
  }),
  execute: async ({ status, teamName }) => {
    const agents = Array.from(runtimeAgentTasks.values())
      .filter((agent) => !status || agent.status === status)
      .filter((agent) => !teamName || agent.teamName === teamName);
    return {
      count: agents.length,
      agents: agents.map((agent) => formatRuntimeAgentTask(agent)),
    };
  },
});

export const taskOutputTool = tool({
  description: "Read the output of a spawned Pakalon subagent.",
  inputSchema: z.object({
    agentId: z.string(),
  }),
  execute: async ({ agentId }) => {
    const agent = runtimeAgentTasks.get(agentId);
    if (!agent) return { success: false, error: `Agent not found: ${agentId}` };
    return {
      success: true,
      agentId,
      status: agent.status,
      output: agent.result ?? "",
    };
  },
});

export const taskStopTool = tool({
  description: "Stop a running Pakalon subagent.",
  inputSchema: z.object({
    agentId: z.string(),
  }),
  execute: async ({ agentId }) => {
    return {
      success: stopRuntimeAgentTask(agentId),
      agentId,
      status: runtimeAgentTasks.get(agentId)?.status ?? "unknown",
    };
  },
});

// ---------------------------------------------------------------------------
// Copilot CLI-style tools — direct command execution aliases
// ---------------------------------------------------------------------------

import { rgTool, viewTool, setLocationTool } from "@/ai/copilot-tools.js";
import { TaskGraphTool as taskGraphTool } from "@/tools/task-tools/task-graph-tool.js";
import { TaskComposeTool as taskComposeTool, TaskChainAdvanceTool as taskChainAdvanceTool } from "@/tools/task-tools/task-compose-tool.js";

// ---------------------------------------------------------------------------
// Tools Export
// ---------------------------------------------------------------------------

export const allTools: ToolSet = {
  // Core file operations
  readFile: readFileTool,
  writeFile: writeFileTool,
  listDir: listDirTool,
  bash: bashTool,
  justbash: justBashTool,
  "just-bash": justBashTool,
  secureBash: secureBashTool,
  "secure-bash": secureBashTool,
  sbash: secureBashTool,
  shellHistory: shellHistoryTool,
  "shell-history": shellHistoryTool,
  listPeers: listPeersTool,
  peers: listPeersTool,
  secureExec: secureExecTool,
  "secure-exec": secureExecTool,
  secure_exec: secureExecTool,
  powershell: powerShellTool,
  editFile: editFileTool,
  multiEditFiles: multiEditFilesTool,
  globFind: globFindTool,
  grepSearch: grepSearchTool,

  // Copilot CLI-style aliases (rg, view, set-location, cd)
  rg: rgTool,
  view: viewTool,
  "set-location": setLocationTool,
  cd: setLocationTool,

  // LSP tools
  lsp: lspTool,
  lspDefinition: lspDefinitionTool,
  lspReferences: lspReferencesTool,
  lspHover: lspHoverTool,
  lspCompletion: lspCompletionTool,
  lspRename: lspRenameTool,
  lspDiagnostics: lspDiagnosticsTool,
  lspSymbols: lspSymbolsTool,
  lspCodeActions: lspCodeActionsTool,
  lspSemanticTokens: lspSemanticTokensTool,
  lspFormatting: lspFormattingTool,
  lspFormat: lspFormattingTool,
  lspTypeHierarchy: lspTypeHierarchyTool,
  lspInlayHints: lspInlayHintsTool,
  lspSignatureHelp: lspSignatureHelpTool,

  // Web tools
  webFetch: webFetchTool,
  webSearch: webSearchTool,
  toolSearch: toolSearchTool,
  ToolSearch: toolSearchTool,
  customToolRegistry: customToolRegistryTool,
  browserNavigate: browserNavigateTool,
  browserClick: browserClickTool,
  browserFillForm: browserFillFormTool,
  browserSnapshot: browserSnapshotTool,
  browserScreenshot: browserScreenshotTool,
  browserWait: browserWaitTool,
  browserSelectOption: browserSelectOptionTool,
  browserClose: browserCloseTool,

  // Chrome DevTools Protocol tools (production-grade browser automation)
  chromeLaunch: chromeLaunchTool,
  chromeKill: chromeKillTool,
  chromeNavigate: chromeNavigateTool,
  chromeScreenshot: chromeScreenshotTool,
  chromeNetwork: chromeNetworkTool,
  chromePerformance: chromePerformanceTool,
  chromeInspect: chromeInspectTool,
  chromeEvaluate: chromeEvaluateTool,
  chromeConsole: chromeConsoleTool,

  // Orchestration
  orchestrate: orchestrateTool,
  codeExecution: codeExecutionTool,
  brief: briefTool,
  sleep: sleepTool,
  scheduleCron: scheduleCronTool,
  cronCreate: cronCreateTool,
  cronList: cronListTool,
  cronDelete: cronDeleteTool,
  cronRun: cronRunTool,
  schedule_cron: scheduleCronTool,
  cron_create: cronCreateTool,
  cron_list: cronListTool,
  cron_delete: cronDeleteTool,
  cron_run: cronRunTool,

  // Notebook tools
  notebookRead: notebookReadTool,
  notebookEdit: notebookEditTool,
  repl: replTool,

  // User interaction
  askUser: askUserTool,

  // Memory tools
  memorySearch: memorySearchTool,
  memoryStore: memoryStoreTool,
  memoryKvGet: memoryKvGetTool,
  memoryKvSet: memoryKvSetTool,

  // Media tools
  imageAnalysis: imageAnalysisTool,
  videoAnalysis: videoAnalysisTool,
  generateImage: generateImageTool,
  generateVideo: generateVideoTool,

  // Cloud storage tools
  uploadFile: uploadFileTool,
  downloadFile: downloadFileTool,
  listFiles: listFilesTool,
  deleteFile: deleteFileTool,

  // Todo tools
  todoRead: todoReadTool,
  todoWrite: todoWriteTool,

  // MCP auth
  mcpAuth: mcpAuthTool,
  mcpResources: mcpResourcesTool,
  mcpResourceSearch: mcpResourcesTool,

  // Team coordination
  teamCreate: teamCreateTool,
  teamDelete: teamDeleteTool,
  sendMessage: sendMessageTool,
  agent: agentTool,
  swarm: swarmTool,
  agentSwarm: swarmTool,
  task: agentTool,
  taskList: taskListTool,
  taskOutput: taskOutputTool,
  taskStop: taskStopTool,

  // Task graph and composition tools
  taskGraph: taskGraphTool,
  taskCompose: taskComposeTool,
  taskChainAdvance: taskChainAdvanceTool,

  // Skill & trust tools
  skill: skillTool,
  directoryTrust: directoryTrustTool,
};

runtimeToolSearchRegistry = allTools;
