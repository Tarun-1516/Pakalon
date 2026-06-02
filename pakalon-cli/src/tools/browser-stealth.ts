/**
 * tools/browser-stealth.ts — stealth profiles for Playwright-based browsing.
 *
 * Built on top of `tools/agent-browser-tool.ts` (which already wires Playwright).
 * Provides:
 *   - 4 STEALTH_PRESETS (minimal, default, aggressive, paranoid)
 *   - 12 realistic user-agent strings
 *   - `applyStealthContext(page, profile)` — applies all the overrides via
 *     `page.addInitScript`
 *   - `stealthFetch(url, opts)` — a high-level fetcher that uses the
 *     Playwright APIRequestContext with stealth headers
 *   - `getRandomUserAgent()` — picks one of the 12 agents
 *
 * The overrides tackle the most common bot-detection surfaces:
 *   - `navigator.webdriver`
 *   - `navigator.plugins`
 *   - `navigator.languages`
 *   - `navigator.platform` / `navigator.hardwareConcurrency` / `navigator.deviceMemory`
 *   - `WebGLRenderingContext.prototype.getParameter` (vendor/renderer)
 *   - `Notification.permission`
 *   - `chrome.runtime` / `Permissions.query`
 */
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type APIRequestContext } from "playwright";

// ---------------------------------------------------------------------------
// User-agent list
// ---------------------------------------------------------------------------

export const USER_AGENTS: readonly string[] = [
  // Chrome (Windows)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  // Chrome (macOS)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  // Chrome (Linux)
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  // Firefox (Windows)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  // Firefox (macOS)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  // Firefox (Linux)
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  // Safari (macOS)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  // Edge (Windows)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
] as const;

export function getRandomUserAgent(): string {
  const idx = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[idx]!;
}

function randomViewport(): { width: number; height: number } {
  return {
    width: 1280 + Math.floor(Math.random() * 640),  // 1280..1920
    height: 720 + Math.floor(Math.random() * 360),   // 720..1080
  };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type StealthProfile = "minimal" | "default" | "aggressive" | "paranoid";

export interface StealthOptions {
  profile?: StealthProfile;
  /** Override the user agent (otherwise picked from USER_AGENTS). */
  userAgent?: string;
  /** Override the viewport (otherwise randomized). */
  viewport?: { width: number; height: number };
  /** Locale (e.g. "en-US"). */
  locale?: string;
  /** Timezone (e.g. "America/Los_Angeles"). */
  timezone?: string;
  /** Per-navigation UA rotation (paranoid only). */
  rotateUaPerNav?: boolean;
}

export const STEALTH_PRESETS: Record<StealthProfile, Required<Omit<StealthOptions, "userAgent" | "viewport" | "locale" | "timezone" | "rotateUaPerNav">> & {
  chromeFlags: string[];
  cdpTimezone?: string;
}> = {
  minimal: {
    profile: "minimal",
    chromeFlags: [],
    rotateUaPerNav: false,
  },
  default: {
    profile: "default",
    chromeFlags: ["--disable-blink-features=AutomationControlled"],
    rotateUaPerNav: false,
  },
  aggressive: {
    profile: "aggressive",
    chromeFlags: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
    ],
    cdpTimezone: "America/Los_Angeles",
    rotateUaPerNav: false,
  },
  paranoid: {
    profile: "paranoid",
    chromeFlags: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--hide-scrollbars",
    ],
    cdpTimezone: "America/Los_Angeles",
    rotateUaPerNav: true,
  },
};

// ---------------------------------------------------------------------------
// Init script (applied to every page via addInitScript)
// ---------------------------------------------------------------------------

function stealthInitScript(profile: StealthProfile): string {
  const ua = JSON.stringify(getRandomUserAgent());
  return `
    (() => {
      const profile = ${JSON.stringify(profile)};
      // navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // plugins (a realistic-looking list)
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
          ];
          arr.item = (i) => arr[i] || null;
          arr.namedItem = (n) => arr.find((p) => p.name === n) || null;
          arr.refresh = () => {};
          return arr;
        },
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      // WebGL vendor/renderer override
      const proto = WebGLRenderingContext.prototype;
      const origGet = proto.getParameter;
      proto.getParameter = function(p) {
        if (p === 37445) return 'Intel Inc.';
        if (p === 37446) return 'Intel Iris OpenGL Engine';
        return origGet.call(this, p);
      };
      // permissions.query for notifications
      const origQuery = navigator.permissions && navigator.permissions.query;
      if (origQuery) {
        navigator.permissions.query = (params) =>
          params && params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission, onchange: null })
            : origQuery.call(navigator.permissions, params);
      }
      // chrome.runtime absent
      if (!('chrome' in window)) {
        // @ts-ignore - we want to spoof chrome.runtime absence
        window.chrome = { runtime: {} };
      }
      // Notification permission default
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        try { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); } catch {}
      }
      ${profile === 'paranoid' || profile === 'aggressive' ? `
      // canvas fingerprint noise
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        // Add a tiny per-call noise
        const ctx = this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 400) {
            imageData.data[i] = imageData.data[i] ^ 1;
          }
          ctx.putImageData(imageData, 0, 0);
        }
        return origToDataURL.call(this);
      };
      // audio context noise
      const origCreateOscillator = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function() {
        const osc = origCreateOscillator.call(this);
        const origConnect = osc.connect.bind(osc);
        osc.connect = (dest) => {
          // small random frequency wobble
          osc.frequency.value = osc.frequency.value + (Math.random() - 0.5) * 0.0001;
          return origConnect(dest);
        };
        return osc;
      };
      ` : ''}
    })();
  `;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function applyStealthContext(page: Page, opts: StealthOptions = {}): Promise<void> {
  const profile = opts.profile ?? "default";
  const preset = STEALTH_PRESETS[profile];
  const ua = opts.userAgent ?? getRandomUserAgent();
  await page.addInitScript({ content: stealthInitScript(profile) });
  await page.setExtraHTTPHeaders({
    "Accept-Language": (opts.locale ?? "en-US") + ",en;q=0.9",
    "User-Agent": ua,
  });
  const viewport = opts.viewport ?? randomViewport();
  await page.setViewportSize(viewport);
  if (preset.cdpTimezone && opts.timezone) {
    try {
      await page.emulateTimezone(opts.timezone);
    } catch {
      // emulateTimezone is only on Chromium contexts; ignore otherwise.
    }
  }
}

export interface StealthFetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  profile?: StealthProfile;
  userAgent?: string;
  timeoutMs?: number;
  /** "html" | "json" | "text" | "buffer" — default "text". */
  responseType?: "html" | "json" | "text" | "buffer";
  /** Browser engine. Default chromium. */
  engine?: "chromium" | "firefox" | "webkit";
}

export interface StealthFetchResult {
  status: number;
  headers: Record<string, string>;
  url: string;
  body: string | Buffer;
  durationMs: number;
  /** Final URL after redirects. */
  finalUrl: string;
}

let _browser: Browser | null = null;

async function getBrowser(engine: "chromium" | "firefox" | "webkit" = "chromium"): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  const factory = engine === "chromium" ? chromium : engine === "firefox" ? firefox : webkit;
  const preset = STEALTH_PRESETS.aggressive;
  _browser = await factory.launch({ headless: true, args: preset.chromeFlags });
  return _browser;
}

/** Make a single stealth fetch using a Playwright APIRequestContext. */
export async function stealthFetch(url: string, opts: StealthFetchOpts = {}): Promise<StealthFetchResult> {
  const started = Date.now();
  const engine = opts.engine ?? "chromium";
  const browser = await getBrowser(engine);
  const ua = opts.userAgent ?? getRandomUserAgent();
  const profile = opts.profile ?? "default";
  const ctx: BrowserContext = await browser.newContext({
    userAgent: ua,
    extraHTTPHeaders: opts.headers,
  });
  try {
    const req: APIRequestContext = ctx.request;
    const res = await (async () => {
      const method = (opts.method ?? "GET").toUpperCase();
      const fetchOpts = { headers: opts.headers, data: opts.body, timeout: opts.timeoutMs ?? 15_000 };
      if (method === "GET") return req.get(url, fetchOpts);
      if (method === "POST") return req.post(url, fetchOpts);
      if (method === "PUT") return req.put(url, fetchOpts);
      if (method === "DELETE") return req.delete(url, fetchOpts);
      if (method === "PATCH") return req.patch(url, fetchOpts);
      if (method === "HEAD") return req.head(url, fetchOpts);
      // Fallback: dispatch through fetch via context.
      return req.fetch(url, { method, ...fetchOpts });
    })();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(await res.allHeaders())) headers[k] = v;
    const responseType = opts.responseType ?? "text";
    let body: string | Buffer;
    if (responseType === "buffer") {
      body = Buffer.from(await res.body());
    } else if (responseType === "json") {
      body = await res.text();
    } else {
      body = await res.text();
    }
    void profile; // preset reserved for future per-call viewport/tz
    return {
      status: res.status(),
      headers,
      url: res.url(),
      finalUrl: res.url(),
      body,
      durationMs: Date.now() - started,
    };
  } finally {
    await ctx.close();
  }
}

/** Disconnect the cached browser. */
export async function closeStealth(): Promise<void> {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
  }
}
