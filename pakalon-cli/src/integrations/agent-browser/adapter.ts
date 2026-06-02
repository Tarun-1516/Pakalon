/**
 * Adapter that wraps the `agent-browser` CLI (Rust binary) behind a
 * typed TypeScript API.
 *
 * If the binary is not installed, every method throws a clear error
 * instructing the user how to install it.
 */

import { spawn, execFileSync } from "child_process";
import logger from "@/utils/logger.js";
import type {
  AgentBrowserClient,
  AgentBrowserOptions,
  ActAction,
  ActResult,
  ExtractOptions,
  ExtractResult,
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotOptions,
  SnapshotResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveBin(opts: AgentBrowserOptions): string {
  return opts.bin ?? "agent-browser";
}

function buildBaseArgs(opts: AgentBrowserOptions): string[] {
  const args: string[] = [];
  if (opts.session) args.push("--session", opts.session);
  if (opts.profile) args.push("--profile", opts.profile);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

function isBinaryAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], {
      stdio: "pipe",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an agent-browser CLI command and return stdout as a string.
 * Throws with a helpful message if the binary is missing.
 */
function runCommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      env: { ...process.env, AGENT_BROWSER_JSON: "1" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const msg = stderr.trim() || stdout.trim() || `agent-browser exited with code ${code}`;
        reject(new Error(`agent-browser error: ${msg}`));
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            'agent-browser is not installed. Run "npm install -g agent-browser && agent-browser install" to enable it.',
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

class AgentBrowserClientImpl implements AgentBrowserClient {
  private readonly bin: string;
  private readonly baseArgs: string[];
  private readonly timeout: number;

  constructor(opts: AgentBrowserOptions) {
    this.bin = resolveBin(opts);
    this.baseArgs = buildBaseArgs(opts);
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  async navigate(opts: NavigateOptions): Promise<NavigateResult> {
    const args = [...this.baseArgs, "open", opts.url];
    if (opts.waitUntil) {
      args.push("--wait-until", opts.waitUntil);
    }
    const raw = await runCommand(this.bin, args, this.timeout);
    const parsed = tryParseJson(raw) as Record<string, unknown> | string;

    if (typeof parsed === "object" && parsed !== null) {
      return {
        url: String(parsed.url ?? opts.url),
        title: String(parsed.title ?? ""),
      };
    }

    return { url: opts.url, title: String(parsed) };
  }

  async act(action: ActAction): Promise<ActResult> {
    const args = [...this.baseArgs];

    switch (action.type) {
      case "click":
        args.push("click", action.selector);
        break;
      case "dblclick":
        args.push("dblclick", action.selector);
        break;
      case "fill":
        args.push("fill", action.selector, action.value);
        break;
      case "type":
        args.push("type", action.selector, action.value);
        break;
      case "press":
        args.push("press", action.key);
        break;
      case "select":
        args.push("select", action.selector, action.value);
        break;
      case "check":
        args.push("check", action.selector);
        break;
      case "uncheck":
        args.push("uncheck", action.selector);
        break;
      case "hover":
        args.push("hover", action.selector);
        break;
      case "scroll":
        args.push("scroll", action.direction);
        if (action.pixels !== undefined) {
          args.push(String(action.pixels));
        }
        break;
    }

    const raw = await runCommand(this.bin, args, this.timeout);
    return { success: true, message: raw };
  }

  async extract(opts: ExtractOptions): Promise<ExtractResult> {
    const kind = opts.kind ?? "text";
    const args = [...this.baseArgs];

    switch (kind) {
      case "text":
        args.push("get", "text", opts.selector);
        break;
      case "html":
        args.push("get", "html", opts.selector);
        break;
      case "value":
        args.push("get", "value", opts.selector);
        break;
      case "attr":
        args.push("get", "attr", opts.selector, opts.attr ?? "");
        break;
      case "count":
        args.push("get", "count", opts.selector);
        break;
      case "box":
        args.push("get", "box", opts.selector);
        break;
    }

    const raw = await runCommand(this.bin, args, this.timeout);
    const parsed = tryParseJson(raw);
    return { value: parsed };
  }

  async screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    const args = [...this.baseArgs, "screenshot"];
    if (opts?.path) args.push(opts.path);
    if (opts?.fullPage) args.push("--full");
    if (opts?.annotate) args.push("--annotate");
    if (opts?.format) args.push("--screenshot-format", opts.format);
    if (opts?.quality !== undefined) args.push("--screenshot-quality", String(opts.quality));

    const raw = await runCommand(this.bin, args, this.timeout);
    const parsed = tryParseJson(raw) as Record<string, unknown> | string;

    if (typeof parsed === "object" && parsed !== null && typeof parsed.path === "string") {
      return { path: parsed.path };
    }

    // Try to extract a path from the output text
    const pathMatch = String(parsed).match(/(?:saved to|wrote|screenshot)\s+(.+\.(?:png|jpg|jpeg))/i);
    if (pathMatch) {
      return { path: pathMatch[1].trim() };
    }

    return { path: opts?.path ?? "" };
  }

  async snapshot(opts?: SnapshotOptions): Promise<SnapshotResult> {
    const args = [...this.baseArgs, "snapshot"];
    if (opts?.interactive) args.push("-i");
    if (opts?.urls) args.push("--urls");
    if (opts?.compact) args.push("-c");
    if (opts?.depth !== undefined) args.push("-d", String(opts.depth));
    if (opts?.selector) args.push("-s", opts.selector);

    const raw = await runCommand(this.bin, args, this.timeout);
    return { tree: raw };
  }

  async evaluate(script: string): Promise<unknown> {
    const args = [...this.baseArgs, "eval", script];
    const raw = await runCommand(this.bin, args, this.timeout);
    return tryParseJson(raw);
  }

  async close(): Promise<void> {
    try {
      await runCommand(this.bin, [...this.baseArgs, "close"], 5_000);
    } catch (err) {
      logger.warn(`[agent-browser] close failed: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an `AgentBrowserClient` that communicates with the
 * `agent-browser` CLI binary.
 *
 * Throws immediately if the binary is not found on PATH.
 */
export function createAgentBrowser(opts: AgentBrowserOptions = {}): AgentBrowserClient {
  const bin = resolveBin(opts);

  if (!isBinaryAvailable(bin)) {
    throw new Error(
      'agent-browser is not installed. Run "npm install -g agent-browser && agent-browser install" to enable it.',
    );
  }

  logger.info("[agent-browser] Creating client (bin=%s)", bin);
  return new AgentBrowserClientImpl(opts);
}

export type {
  AgentBrowserClient,
  AgentBrowserOptions,
  ActAction,
  ActResult,
  ExtractOptions,
  ExtractResult,
  NavigateOptions,
  NavigateResult,
  ScreenshotOptions,
  ScreenshotResult,
  SnapshotOptions,
  SnapshotResult,
} from "./types.js";
