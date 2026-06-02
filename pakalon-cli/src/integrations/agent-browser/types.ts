/**
 * TypeScript types for the vercel-labs/agent-browser integration.
 *
 * Mirrors the CLI API surface of `agent-browser` (the Rust binary)
 * and exposes it through a typed programmatic interface.
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AgentBrowserOptions {
  /** Path to the agent-browser binary (default: "agent-browser") */
  bin?: string;
  /** Session name for isolated browser instances */
  session?: string;
  /** Chrome profile name or persistent directory path */
  profile?: string;
  /** Extra CLI flags forwarded to every agent-browser invocation */
  extraArgs?: string[];
  /** Timeout per CLI call in milliseconds (default: 30_000) */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Navigate
// ---------------------------------------------------------------------------

export interface NavigateOptions {
  /** URL to navigate to */
  url: string;
  /** Wait strategy: "load" | "domcontentloaded" | "networkidle" */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface NavigateResult {
  url: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Act (click / fill / type / press / select)
// ---------------------------------------------------------------------------

export type ActAction =
  | { type: "click"; selector: string }
  | { type: "dblclick"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "type"; selector: string; value: string }
  | { type: "press"; key: string }
  | { type: "select"; selector: string; value: string }
  | { type: "check"; selector: string }
  | { type: "uncheck"; selector: string }
  | { type: "hover"; selector: string }
  | { type: "scroll"; direction: "up" | "down" | "left" | "right"; pixels?: number }
  | { type: "hover"; selector: string };

export interface ActResult {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** CSS selector, @eN ref, or semantic locator */
  selector: string;
  /** What to extract: "text" | "html" | "value" | "attr" | "count" | "box" */
  kind?: "text" | "html" | "value" | "attr" | "count" | "box";
  /** Attribute name when kind is "attr" */
  attr?: string;
}

export interface ExtractResult {
  value: unknown;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export interface ScreenshotOptions {
  /** Output file path (omit for auto-generated temp path) */
  path?: string;
  /** Capture the full scrollable page (default: viewport only) */
  fullPage?: boolean;
  /** Annotate interactive elements with numbered labels */
  annotate?: boolean;
  /** Output format: "png" | "jpeg" */
  format?: "png" | "jpeg";
  /** JPEG quality 0-100 (only when format is "jpeg") */
  quality?: number;
}

export interface ScreenshotResult {
  path: string;
}

// ---------------------------------------------------------------------------
// Snapshot (accessibility tree)
// ---------------------------------------------------------------------------

export interface SnapshotOptions {
  /** Only interactive elements */
  interactive?: boolean;
  /** Include URLs for link elements */
  urls?: boolean;
  /** Compact mode: remove empty structural elements */
  compact?: boolean;
  /** Limit tree depth */
  depth?: number;
  /** Scope to CSS selector */
  selector?: string;
}

export interface SnapshotResult {
  tree: string;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface AgentBrowserClient {
  /** Navigate to a URL */
  navigate(opts: NavigateOptions): Promise<NavigateResult>;

  /** Perform a browser action (click, fill, type, press, etc.) */
  act(action: ActAction): Promise<ActResult>;

  /** Extract content from the page */
  extract(opts: ExtractOptions): Promise<ExtractResult>;

  /** Take a screenshot */
  screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult>;

  /** Get the accessibility tree snapshot */
  snapshot(opts?: SnapshotOptions): Promise<SnapshotResult>;

  /** Run arbitrary JavaScript in the page */
  evaluate(script: string): Promise<unknown>;

  /** Close the browser session */
  close(): Promise<void>;
}
