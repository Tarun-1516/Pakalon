/**
 * i18n/loader.ts — minimal i18n loader for pakalon-cli.
 *
 * - Locales are JSON files under `./locales/<lang>.json`
 * - Interpolation uses `{name}` placeholders
 * - Pluralisation uses `{count, plural, one {…} other {…}}` (subset of ICU)
 * - Lookup walks up the namespace tree (`a.b.c`) then falls back to the
 *   default locale (`en`) then to the key itself.
 *
 * No external deps; reads via `node:fs` and is sync. Designed for the CLI
 * where locale files are bundled at build time.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Locale = string; // BCP 47-ish, e.g. "en", "en-US", "es", "hi"

export type PluralForms = {
  [form: string]: string; // "one" | "other" | "few" | "many" | ...
};

export type TranslationValue =
  | string
  | { [k: string]: TranslationValue }
  | PluralForms;

export type Catalog = { [key: string]: TranslationValue };

export interface LoaderOptions {
  /** Directory containing `<lang>.json` files. Defaults to `./locales`. */
  localesDir?: string;
  /** Default locale to fall back to. Defaults to `"en"`. */
  defaultLocale?: Locale;
  /** Override the clock for tests. */
  now?: () => Date;
}

export class I18n {
  private readonly localesDir: string;
  private readonly defaultLocale: Locale;
  private readonly now: () => Date;
  private cache = new Map<Locale, Catalog>();
  private current: Locale;

  constructor(initial: Locale = "en", opts: LoaderOptions = {}) {
    this.current = initial;
    this.defaultLocale = opts.defaultLocale ?? "en";
    this.now = opts.now ?? (() => new Date());
    this.localesDir = opts.localesDir ?? defaultLocalesDir();
    // Pre-warm default locale so a missing key never crashes.
    this.load(this.defaultLocale);
  }

  /** Returns the active locale. */
  get locale(): Locale {
    return this.current;
  }

  /** Switch active locale and pre-warm its catalog. */
  setLocale(lang: Locale): void {
    this.current = lang;
    this.load(lang);
  }

  /** Load (and cache) a catalog. Returns the empty catalog on miss. */
  load(lang: Locale): Catalog {
    const cached = this.cache.get(lang);
    if (cached) return cached;
    const path = join(this.localesDir, `${lang}.json`);
    if (!existsSync(path)) {
      const empty: Catalog = {};
      this.cache.set(lang, empty);
      return empty;
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = safeParse(raw);
    this.cache.set(lang, parsed);
    return parsed;
  }

  /** Get a translation for `key`. `vars` is used for `{name}` interpolation. */
  t(key: string, vars?: Record<string, string | number>, locale?: Locale): string {
    const lang = locale ?? this.current;
    const catalog = this.load(lang);
    const value = lookup(catalog, key);
    if (value !== undefined) return render(value, vars);
    const fallback = this.load(this.defaultLocale);
    const def = lookup(fallback, key);
    if (def !== undefined) return render(def, vars);
    return key; // Missing key — surface it visibly.
  }

  /** Convenience: pick the plural form for `count`. */
  tn(key: string, count: number, vars?: Record<string, string | number>, locale?: Locale): string {
    return this.t(key, { ...(vars ?? {}), count }, locale);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultLocalesDir(): string {
  // Resolve `./locales` relative to this file regardless of CJS/ESM.
  // Bun + tsx both work with `import.meta.url`.
  try {
    // @ts-ignore - import.meta.url may be undefined in some CJS contexts
    const url = import.meta.url;
    if (typeof url === "string") {
      const here = dirname(fileURLToPath(url));
      return resolve(here, "locales");
    }
  } catch {
    // ignore
  }
  return resolve(process.cwd(), "src/i18n/locales");
}

function safeParse(raw: string): Catalog {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Catalog;
    return {};
  } catch {
    return {};
  }
}

function lookup(catalog: Catalog, key: string): TranslationValue | undefined {
  const parts = key.split(".");
  let cur: TranslationValue | undefined = catalog;
  for (const p of parts) {
    if (cur && typeof cur === "object" && !Array.isArray(cur) && p in cur) {
      cur = (cur as Record<string, TranslationValue>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function isPluralObject(v: unknown): v is PluralForms {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  // Heuristic: a plural object has no nested objects and at least one
  // of the standard plural keys.
  const obj = v as Record<string, unknown>;
  const standardKeys = new Set(["zero", "one", "two", "few", "many", "other"]);
  let sawStandard = false;
  for (const k of Object.keys(obj)) {
    const val = obj[k];
    if (typeof val !== "string") return false;
    if (standardKeys.has(k)) sawStandard = true;
  }
  return sawStandard;
}

function render(value: TranslationValue, vars?: Record<string, string | number>): string {
  if (typeof value === "string") return interpolate(value, vars);
  if (isPluralObject(value)) {
    const count = Number(vars?.["count"] ?? 0);
    const form = pickPluralForm(count);
    const template = value[form] ?? value["other"] ?? Object.values(value)[0] ?? "";
    return interpolate(template, vars);
  }
  return JSON.stringify(value);
}

function pickPluralForm(count: number): string {
  // English-style "one" / "other". Other locales can override via the catalog
  // by including `"other"` and other forms.
  const rules = new Intl.PluralRules("en-US");
  return rules.select(count);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return String(vars[name]);
    }
    return m;
  });
}

/** Default singleton. */
let _default: I18n | null = null;
export function getI18n(): I18n {
  if (!_default) _default = new I18n(detectLocale());
  return _default;
}

export function detectLocale(): Locale {
  const env = process.env["PAKALON_LANG"]
    || process.env["LANG"]
    || process.env["LC_ALL"]
    || process.env["LC_MESSAGES"]
    || "";
  const lang = env.split(/[.:]/)[0]?.toLowerCase() ?? "";
  if (lang.startsWith("es")) return "es";
  if (lang.startsWith("hi")) return "hi";
  if (lang.startsWith("en")) return "en";
  return "en";
}
