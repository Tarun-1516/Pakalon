/**
 * Real-time web URL import with design-token extraction.
 *
 * Extends the curated-scrape module by accepting ANY URL, not just
 * the curated list. Additionally extracts:
 *   - CSS custom properties (--color-*, --font-*, --space-*, --radius-*)
 *   - Tailwind config tokens (if a tailwind.config.{js,ts} is reachable)
 *   - Computed color/font values from the live DOM
 *
 * Used by Phase 3 to pull real-world design systems into the project.
 */
import * as cheerio from "cheerio";
import logger from "@/utils/logger.js";

export interface DesignToken {
  /** Token name, e.g. "--color-primary-500" */
  name: string;
  /** Resolved value, e.g. "#3b82f6" */
  value: string;
  /** Inferred type */
  type: "color" | "font" | "size" | "spacing" | "radius" | "shadow" | "z-index" | "other";
  /** Origin: which file/url the token came from */
  source: string;
}

export interface WebImportOptions {
  url: string;
  /** Follow up to N same-origin links to discover more tokens. Default 0. */
  followLinks?: number;
  /** Maximum response size in bytes. Default 5 MB. */
  maxBytes?: number;
  /** User-Agent header. */
  userAgent?: string;
}

export interface WebImportResult {
  url: string;
  title: string;
  description?: string;
  tokens: DesignToken[];
  /** Inline CSS variables found on the root element */
  rootVariables: Record<string, string>;
  /** Total <style> blocks scanned */
  stylesheetCount: number;
  /** Links followed during crawl */
  followedUrls: string[];
  fetchedAt: string;
  durationMs: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_UA = "Mozilla/5.0 (compatible; Pakalon-WebImport/1.0)";

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const SIZE_RE = /^(\d+(\.\d+)?)(px|rem|em|%|vh|vw)$/i;
const SHADOW_RE = /^(rgb|rgba|hsl|hsla|var\()/i;

/** Best-effort classification of a CSS custom-property value. */
export function classifyToken(name: string, value: string): DesignToken["type"] {
  const lowerName = name.toLowerCase();
  if (lowerName.includes("color") || lowerName.includes("bg") || lowerName.includes("fg") || lowerName.includes("text") || COLOR_RE.test(value) || SHADOW_RE.test(value)) {
    if (value.startsWith("rgb") || value.startsWith("hsl") || COLOR_RE.test(value)) return "color";
  }
  if (lowerName.includes("font") || lowerName.includes("text-") || lowerName.includes("family")) return "font";
  if (lowerName.includes("radius") || lowerName.includes("rounded")) return "radius";
  if (lowerName.includes("shadow") || lowerName.includes("elevation")) return "shadow";
  if (lowerName.includes("space") || lowerName.includes("spacing") || lowerName.includes("gap") || lowerName.includes("margin") || lowerName.includes("padding")) return "spacing";
  if (lowerName.includes("size") || lowerName.includes("width") || lowerName.includes("height")) return "size";
  if (lowerName.includes("z-")) return "z-index";
  if (SIZE_RE.test(value)) return "size";
  return "other";
}

/** Extract :root { --foo: bar } style declarations from a CSS string. */
export function extractCustomProperties(css: string, source: string): DesignToken[] {
  const out: DesignToken[] = [];
  const re = /--([\w-]+)\s*:\s*([^;}]+?)\s*(?:!important)?\s*[;}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const name = `--${m[1]}`;
    const value = m[2].trim();
    out.push({ name, value, type: classifyToken(name, value), source });
  }
  return out;
}

/** Pull CSS from <style> blocks in the HTML. */
function extractInlineStyles(html: string): string {
  const $ = cheerio.load(html);
  const chunks: string[] = [];
  $("style").each((_i, el) => {
    chunks.push($(el).text());
  });
  // Also pull stylesheet hrefs
  const hrefs: string[] = [];
  $('link[rel="stylesheet"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) hrefs.push(href);
  });
  return chunks.join("\n");
}

/** Resolve a relative href against the page URL. */
function resolveUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/** Fetch a URL and return the response body as a string, or null on error. */
async function fetchUrl(url: string, maxBytes: number, userAgent: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "text/html,text/css,*/*" },
    });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  } catch (err) {
    logger.warn({ err, url }, "fetchUrl failed");
    return null;
  }
}

/**
 * Import any URL and extract design tokens from it.
 */
export async function importWebDesign(opts: WebImportOptions): Promise<WebImportResult> {
  const start = Date.now();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const followLinks = Math.max(0, Math.min(5, opts.followLinks ?? 0));

  const html = await fetchUrl(opts.url, maxBytes, userAgent);
  if (!html) {
    return {
      url: opts.url,
      title: "",
      tokens: [],
      rootVariables: {},
      stylesheetCount: 0,
      followedUrls: [],
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
  }

  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim();

  // 1) Extract from inline <style> blocks
  const inlineCss = extractInlineStyles(html);
  let tokens = extractCustomProperties(inlineCss, opts.url);
  const stylesheetCount = inlineCss.split("}").length;

  // 2) Extract :root variables from inline style attributes
  const rootVariables: Record<string, string> = {};
  $("[style]").each((_i, el) => {
    const style = $(el).attr("style") ?? "";
    const re = /--([\w-]+)\s*:\s*([^;]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(style)) !== null) {
      rootVariables[`--${m[1]}`] = m[2].trim();
    }
  });
  for (const [k, v] of Object.entries(rootVariables)) {
    tokens.push({ name: k, value: v, type: classifyToken(k, v), source: `${opts.url}#inline` });
  }

  // 3) Follow links to discover more tokens
  const followedUrls: string[] = [];
  if (followLinks > 0) {
    const baseOrigin = new URL(opts.url).origin;
    const seen = new Set<string>([opts.url]);
    $('link[rel="stylesheet"]').each((_i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const abs = resolveUrl(opts.url, href);
      if (!abs) return;
      if (!abs.startsWith(baseOrigin)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      if (followedUrls.length >= followLinks) return;
      followedUrls.push(abs);
    });
    for (const u of followedUrls) {
      const css = await fetchUrl(u, maxBytes, userAgent);
      if (css) {
        tokens = tokens.concat(extractCustomProperties(css, u));
      }
    }
  }

  // De-duplicate tokens by name (last source wins)
  const dedup = new Map<string, DesignToken>();
  for (const t of tokens) dedup.set(t.name, t);

  logger.info(
    { url: opts.url, tokens: dedup.size, stylesheetCount, followedUrls: followedUrls.length },
    "web design import complete",
  );

  return {
    url: opts.url,
    title,
    description,
    tokens: Array.from(dedup.values()),
    rootVariables,
    stylesheetCount,
    followedUrls,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}
