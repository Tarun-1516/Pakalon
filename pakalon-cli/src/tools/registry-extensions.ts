/**
 * Tool registrations for the new tools added during the
 * comparison.md implementation cycle (June 2026).
 *
 * Wraps each helper module into a ToolDefinition so the Vercel AI
 * SDK can expose it to the agent.
 */
import { z } from "zod";
import type { ToolDefinition } from "./executor.js";
import logger from "@/utils/logger.js";

import { registerTool } from "./registry-new.js";

import {
  AskUserQuestionToolDefinition,
  askUserQuestionInputSchema,
} from "./AskUserQuestionTool/AskUserQuestionTool.js";

import { writeHeapDump } from "./heap-dump.js";
import { startRecording } from "./asciicast.js";
import { runAllSecurityScans, type SecurityScanOptions } from "./security-tools-runner.js";

/**
 * AskUserQuestionTool — multi-choice Q&A for the agentic loop.
 * Already exported as a ToolDefinition by its module, so we just
 * forward it.
 */
function registerAskUserQuestionTool() {
  registerTool({
    name: AskUserQuestionToolDefinition.name,
    description: AskUserQuestionToolDefinition.description,
    parameters: askUserQuestionInputSchema as never,
    requiresPermission: false,
    execute: AskUserQuestionToolDefinition.execute as never,
  });
  logger.info('[registry-new] Registered AskUserQuestionTool');
}

/**
 * Chrome DevTools Protocol live integration. The transport client
 * is created on demand to avoid starting a CDP socket at import time.
 */
function registerChromeDevToolsTool() {
  registerTool({
    name: "chrome_devtools",
    description:
      "Drive a real Chrome instance via the Chrome DevTools Protocol. Supports navigate, click, fill, screenshot, evaluate JS, and close.",
    parameters: z.object({
      action: z.enum(["navigate", "click", "fill", "screenshot", "evaluate", "close"]),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
    requiresPermission: true,
    execute: async (args) => {
      // Lazy-load the tool so the CDP client is only constructed on use.
      const mod = await import("./chrome-devtools-tool.js");
      const client = mod.getChromeDevToolsClient();
      switch (args.action) {
        case "navigate":
          return client.navigate(args.payload);
        case "click":
          return client.click(args.payload);
        case "fill":
          return client.fill(args.payload);
        case "screenshot":
          return client.screenshot(args.payload);
        case "evaluate":
          return client.evaluate(args.payload);
        case "close":
          return client.close();
      }
    },
  });
  logger.info('[registry-new] Registered chrome_devtools');
}

/**
 * Heap dump tool — V8 snapshot to disk.
 */
function registerHeapDumpTool() {
  registerTool({
    name: "heap_dump",
    description: "Write a V8 heap snapshot to .pakalon/diagnostics/ for memory-leak investigation.",
    parameters: z.object({
      projectDir: z.string(),
      filename: z.string().optional(),
    }),
    requiresPermission: false,
    execute: async (args) => writeHeapDump(args),
  });
  logger.info('[registry-new] Registered heap_dump');
}

/**
 * Asciicast — start recording a session replay file.
 */
function registerAsciicastTool() {
  registerTool({
    name: "asciicast",
    description: "Start a session recording that can be replayed via asciinema (https://asciinema.org).",
    parameters: z.object({
      outFile: z.string(),
      width: z.number().int().positive().default(120),
      height: z.number().int().positive().default(32),
    }),
    requiresPermission: false,
    execute: async (args) => {
      const rec = await startRecording(args.outFile, args.width, args.height);
      return { started: true, outFile: args.outFile };
    },
  });
  logger.info('[registry-new] Registered asciicast');
}

/**
 * Security tools runner — orchestrates semgrep/gitleaks/bandit/zap
 * /nikto/sqlmap/wapiti/xsstrike via real subprocess execution.
 */
function registerSecurityToolsRunner() {
  registerTool({
    name: "security_scan",
    description:
      "Run the bundled security toolchain (semgrep, gitleaks, bandit, zap, nikto, sqlmap, wapiti, xsstrike). Returns normalized findings.",
    parameters: z.object({
      projectDir: z.string(),
      tools: z.array(z.string()).optional().describe("Subset of tools to run. Defaults to all."),
      severityThreshold: z.enum(["info", "low", "medium", "high", "critical"]).default("low"),
    }),
    requiresPermission: true,
    execute: async (args) => {
      const opts: SecurityScanOptions = {
        projectDir: args.projectDir,
        tools: args.tools,
        severityThreshold: args.severityThreshold,
      };
      return runAllSecurityScans(opts);
    },
  });
  logger.info('[registry-new] Registered security_scan');
}

/**
 * Register all new tools in one call.
 */
export function registerNewTools() {
  registerAskUserQuestionTool();
  registerChromeDevToolsTool();
  registerHeapDumpTool();
  registerAsciicastTool();
  registerSecurityToolsRunner();
  logger.info(`[registry-new] Registered ${5} new tools`);
}
