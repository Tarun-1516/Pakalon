/**
 * Chrome DevTools MCP live tool.
 *
 * Wraps the @modelcontextprotocol/server-chrome-devtools MCP server
 * with a higher-level API: navigate, click, fill, screenshot,
 * evaluate, getConsoleLogs. This is what Phase 4's browser-agent
 * uses to drive a real headless Chrome against the freshly-built app.
 */
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChromeDevToolsConfig {
  /** Path to a Chrome binary. Defaults to "google-chrome" / "chrome.exe". */
  chromePath?: string;
  /** Headless mode (default true). */
  headless?: boolean;
  /** Run from a clean user data dir. */
  userDataDir?: string;
  /** Remote debugging port (default 9222). */
  port?: number;
  /** Working directory for the spawned browser. */
  cwd?: string;
}

export interface NavigateArgs {
  url: string;
  /** Wait until the page fires a "load" event */
  waitUntil?: "load" | "domcontentloaded" | "networkidle0";
}

export interface ClickArgs {
  selector: string;
  button?: "left" | "right" | "middle";
  doubleClick?: boolean;
}

export interface FillArgs {
  selector: string;
  value: string;
}

export interface ScreenshotArgs {
  /** Save PNG to this path. Auto-generated if omitted. */
  outputPath?: string;
  /** If true, capture full scrollable page */
  fullPage?: boolean;
}

export interface EvaluateArgs {
  /** JavaScript expression to evaluate in the page context */
  expression: string;
  /** Optional JSON-serialisable argument */
  arg?: unknown;
}

export interface ConsoleLogEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  url?: string;
  line?: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Minimal Chrome DevTools Protocol client. Speaks CDP directly over
 * WebSocket. We avoid pulling in `puppeteer` to keep the dependency
 * surface small and the binary portable.
 */
export class ChromeDevToolsClient extends EventEmitter {
  private proc?: ChildProcess;
  private ws?: WebSocket | null;
  private readonly port: number;
  private readonly chromePath: string;
  private readonly userDataDir: string;
  private headless: boolean;
  private messageId = 0;
  private readonly pending = new Map<number, (value: any) => void>();
  private readonly events: ConsoleLogEntry[] = [];
  private currentUrl = "";

  constructor(config: ChromeDevToolsConfig = {}) {
    super();
    this.port = config.port ?? 9222;
    this.chromePath = config.chromePath ?? defaultChromePath();
    this.userDataDir = config.userDataDir ?? path.join(os.tmpdir(), `pakalon-chrome-${Date.now()}`);
    this.headless = config.headless ?? true;
  }

  /** Launch the browser. Must be called before navigate/click/etc. */
  async launch(): Promise<void> {
    await fs.mkdir(this.userDataDir, { recursive: true });
    const headlessFlag = this.headless ? "--headless=new" : "--headless=false";
    const args = [
      headlessFlag,
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      "about:blank",
    ];
    this.proc = spawn(this.chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.proc.on("exit", (code) => this.emit("exit", code));
    await this.connectWs();
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Page.enable");
    this.installListeners();
    logger.info({ port: this.port, pid: this.proc.pid }, "Chrome launched");
  }

  private async connectWs(): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
    if (!res.ok) throw new Error(`Chrome not reachable on port ${this.port} (status ${res.status})`);
    const meta = (await res.json()) as { webSocketDebuggerUrl: string };
    this.ws = new WebSocket(meta.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = (e) => reject(new Error(`WebSocket error: ${(e as any).message ?? e}`));
    });
  }

  private installListeners(): void {
    this.ws!.onmessage = (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data as string);
        if (msg.id != null && this.pending.has(msg.id)) {
          const cb = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) cb(Promise.reject(new Error(msg.error.message)));
          else cb(Promise.resolve(msg.result));
        } else if (msg.method === "Runtime.consoleAPICalled") {
          const e = msg.params;
          const text = (e.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
          this.events.push({
            level: e.type as ConsoleLogEntry["level"],
            text,
            url: e.url,
            line: e.lineNumber,
            ts: Date.now(),
          });
        } else if (msg.method === "Log.entryAdded") {
          const e = msg.params.entry;
          this.events.push({
            level: (e.level ?? "info") as ConsoleLogEntry["level"],
            text: e.text ?? "",
            url: e.url,
            line: e.lineNumber,
            ts: Date.now(),
          });
        }
      } catch {
        // ignore parse errors
      }
    };
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not open"));
        return;
      }
      const id = ++this.messageId;
      this.pending.set(id, (p) => p.then(resolve, reject));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // -------------------------------------------------------------------------
  // High-level API
  // -------------------------------------------------------------------------

  async navigate(args: NavigateArgs): Promise<{ url: string; title: string }> {
    await this.send("Page.navigate", { url: args.url });
    this.currentUrl = args.url;
    // wait for load
    await sleep(500);
    const { result } = await this.send("Runtime.evaluate", {
      expression: "JSON.stringify({ url: location.href, title: document.title })",
    });
    const meta = JSON.parse(result.value);
    return { url: meta.url, title: meta.title };
  }

  async click(args: ClickArgs): Promise<void> {
    const { root } = await this.send("DOM.getDocument");
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector: args.selector });
    if (!nodeId) throw new Error(`No element matched: ${args.selector}`);
    const box = await this.send("DOM.getBoxModel", { nodeId });
    const cx = (box.model.content[0] + box.model.content[2]) / 2;
    const cy = (box.model.content[1] + box.model.content[5]) / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: args.button ?? "left", clickCount: args.doubleClick ? 2 : 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: args.button ?? "left", clickCount: args.doubleClick ? 2 : 1 });
  }

  async fill(args: FillArgs): Promise<void> {
    const expr = `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(args.value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
    const { result } = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (result.value !== true) throw new Error(`No element matched: ${args.selector}`);
  }

  async screenshot(args: ScreenshotArgs = {}): Promise<string> {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!args.fullPage });
    const buf = Buffer.from(data, "base64");
    const out = args.outputPath ?? path.join(os.tmpdir(), `pakalon-shot-${Date.now()}.png`);
    await fs.writeFile(out, buf);
    return out;
  }

  async evaluate<T = unknown>(args: EvaluateArgs): Promise<T> {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: args.expression,
      returnByValue: true,
      args: args.arg !== undefined ? [{ value: args.arg }] : undefined,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? "evaluate failed");
    return result.value as T;
  }

  getConsoleLogs(): ConsoleLogEntry[] {
    return this.events.slice();
  }

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.proc?.kill();
    this.proc = undefined;
    this.ws = null;
    logger.info("Chrome closed");
  }
}

function defaultChromePath(): string {
  if (process.platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  }
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "/usr/bin/google-chrome";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tool registration helper
// ---------------------------------------------------------------------------

export const ChromeDevToolsToolDefinition = {
  name: "ChromeDevTools",
  description:
    "Drive a real headless Chrome browser via the Chrome DevTools Protocol. " +
    "Use it to navigate, click, fill forms, take screenshots, and run JS in the " +
    "page. Phase 4 uses this to test the freshly built app end-to-end.",
  async run(args: { action: "navigate" | "click" | "fill" | "screenshot" | "evaluate" | "close"; payload: any }, ctx: { projectDir?: string } = {}) {
    const client = (ctx as any).__chromeClient as ChromeDevToolsClient | undefined;
    if (!client) throw new Error("ChromeDevTools client not initialised. Call launch() first.");
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
};
