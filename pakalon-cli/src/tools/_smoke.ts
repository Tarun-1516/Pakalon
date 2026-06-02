/**
 * Smoke test for browser-stealth: pickers, presets, and the init-script
 * shape. Does NOT actually launch a browser.
 */
import {
  STEALTH_PRESETS,
  getRandomUserAgent,
  USER_AGENTS,
  type StealthProfile,
} from "./browser-stealth.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

function main(): void {
  // 1) UA pool is non-empty and contains at least 12 distinct entries.
  assert(USER_AGENTS.length >= 12, "UA pool has at least 12 entries");
  const distinct = new Set(USER_AGENTS);
  assert(distinct.size === USER_AGENTS.length, "UA pool has all-distinct entries");

  // 2) Random picker returns a valid UA from the pool.
  for (let i = 0; i < 10; i++) {
    const ua = getRandomUserAgent();
    assert(USER_AGENTS.includes(ua), `random pick ${i} is from pool`);
  }

  // 3) Presets exist and have the expected shape.
  for (const name of ["minimal", "default", "aggressive", "paranoid"] as const) {
    const p = STEALTH_PRESETS[name];
    assert(p !== undefined, `preset ${name} exists`);
    assert(p.profile === name, `preset ${name}.profile === "${name}"`);
    assert(Array.isArray(p.chromeFlags), `preset ${name}.chromeFlags is array`);
    assert(typeof p.rotateUaPerNav === "boolean", `preset ${name}.rotateUaPerNav is boolean`);
  }

  // 4) Preset escalation adds more chrome flags.
  assert(
    STEALTH_PRESETS.default.chromeFlags.length > STEALTH_PRESETS.minimal.chromeFlags.length,
    "default adds more flags than minimal",
  );
  assert(
    STEALTH_PRESETS.aggressive.chromeFlags.length > STEALTH_PRESETS.default.chromeFlags.length,
    "aggressive adds more flags than default",
  );
  assert(
    STEALTH_PRESETS.paranoid.chromeFlags.length > STEALTH_PRESETS.aggressive.chromeFlags.length,
    "paranoid adds more flags than aggressive",
  );

  // 5) Paranoid sets timezone + UA rotation.
  assert(STEALTH_PRESETS.paranoid.cdpTimezone === "America/Los_Angeles", "paranoid has cdpTimezone");
  assert(STEALTH_PRESETS.paranoid.rotateUaPerNav === true, "paranoid rotates UA per nav");

  // 6) All four presets are valid StealthProfile keys.
  for (const name of Object.keys(STEALTH_PRESETS)) {
    const ok = ["minimal", "default", "aggressive", "paranoid"].includes(name);
    assert(ok, `preset key ${name} is a valid StealthProfile`);
  }

  // 7) UA pool covers Chrome, Firefox, Safari, Edge.
  const hasChrome = USER_AGENTS.some((u) => u.includes("Chrome/") && !u.includes("Edg/"));
  const hasFirefox = USER_AGENTS.some((u) => u.includes("Firefox/"));
  const hasSafari = USER_AGENTS.some((u) => u.includes("Safari/") && !u.includes("Chrome/"));
  const hasEdge = USER_AGENTS.some((u) => u.includes("Edg/"));
  assert(hasChrome, "UA pool includes Chrome");
  assert(hasFirefox, "UA pool includes Firefox");
  assert(hasSafari, "UA pool includes Safari");
  assert(hasEdge, "UA pool includes Edge");

  // 8) All UAs are well-formed (contain "Mozilla/").
  assert(USER_AGENTS.every((u) => u.startsWith("Mozilla/")), "all UAs start with Mozilla/");

  // 9) Type-narrowed check on StealthProfile union.
  const profiles: StealthProfile[] = ["minimal", "default", "aggressive", "paranoid"];
  for (const p of profiles) {
    assert(p in STEALTH_PRESETS, `StealthProfile ${p} resolves to a preset`);
  }

  console.log(`\nSummary: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main();
