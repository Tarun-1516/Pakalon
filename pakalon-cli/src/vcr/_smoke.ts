/**
 * Smoke test for the VCR record/replay layer.
 *
 * Uses a fresh cassette directory under PAKALON_CONFIG_DIR to avoid
 * touching the user's real cassette store.
 */
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  installVcr,
  uninstallVcr,
  replay,
  disableNetwork,
  loadCassette,
  saveCassette,
  listCassettes,
  deleteCassette,
  cassettePath,
  type Cassette,
} from "./index.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

async function main(): Promise<void> {
  const tmp = path.join(os.tmpdir(), `pakalon-vcr-smoke-${Date.now()}`);
  process.env["PAKALON_CONFIG_DIR"] = tmp;

  // 1) installVcr with mode=off patches globalThis.fetch.
  installVcr({ mode: "off" });
  assert(typeof globalThis.fetch === "function", "installVcr patches globalThis.fetch");
  uninstallVcr();
  assert(typeof (globalThis as any).fetch === "function", "uninstallVcr restores fetch");

  // 2) cassettePath joins correctly.
  assert(cassettePath("foo", tmp) === path.join(tmp, "foo.json"), "cassettePath joins correctly");

  // 3) listCassettes on an empty dir returns [].
  const initial = listCassettes(tmp);
  assert(Array.isArray(initial) && initial.length === 0, "listCassettes returns [] for empty dir");

  // 4) loadCassette returns null for a missing cassette.
  const missing = await loadCassette("does-not-exist", tmp);
  assert(missing === null, "loadCassette returns null for missing cassette");

  // 5) saveCassette / loadCassette roundtrip.
  const sample: Cassette = {
    version: 1,
    name: "sample",
    recordedAt: Date.now(),
    updatedAt: Date.now(),
    requestCount: 1,
    imports: [],
    entries: [
      {
        id: "e1",
        request: {
          method: "GET",
          url: "https://example.com/x",
          headers: {},
          startedAt: Date.now(),
        },
        response: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
          body: "hi",
          bodyEncoding: "utf8",
          durationMs: 5,
        },
        recordedAt: Date.now(),
      },
    ],
  };
  await saveCassette(sample, tmp);
  assert(listCassettes(tmp).includes("sample"), "cassette appears in list after save");
  const loaded = await loadCassette("sample", tmp);
  assert(loaded !== null, "loadCassette returns the saved cassette");
  assert(loaded?.entries.length === 1, "loaded cassette has 1 entry");
  assert(loaded?.entries[0].response.body === "hi", "loaded body roundtrips");
  assert(loaded?.entries[0].response.status === 200, "loaded status roundtrips");

  // 6) replay() in replay mode: a cached GET returns the recorded body.
  const replayResult = await replay("sample", async () => {
    const r = await fetch("https://example.com/x");
    return { status: r.status, body: await r.text() };
  }, { mode: "replay", dir: tmp });
  assert(replayResult.status === 200, "replay() returns recorded status");
  assert(replayResult.body === "hi", "replay() returns recorded body");

  // 7) replay() in strict mode throws on uncached URL.
  let blocked = false;
  try {
    await replay("sample", async () => {
      return await fetch("https://example.com/uncached");
    }, { mode: "strict", dir: tmp });
  } catch {
    blocked = true;
  }
  assert(blocked, "replay() in strict mode throws on uncached URL");

  // 8) replay() in fallback mode runs the fn even if not all calls are cached.
  let ran = false;
  await replay("sample", async () => {
    ran = true;
    return "ok";
  }, { mode: "fallback", dir: tmp });
  assert(ran, "replay() in fallback mode runs the fn");

  // 9) disableNetwork() blocks real fetches via strict mode.
  const origFetch = globalThis.fetch;
  disableNetwork();
  let netBlocked = false;
  try {
    await fetch("https://example.com/should-fail");
  } catch {
    netBlocked = true;
  }
  uninstallVcr();
  (globalThis as any).fetch = origFetch;
  assert(netBlocked, "disableNetwork() throws on real fetch");

  // 10) deleteCassette removes the file.
  const deleted = await deleteCassette("sample", tmp);
  assert(deleted, "deleteCassette returns true");
  assert(!listCassettes(tmp).includes("sample"), "cassette removed from list");
  assert((await loadCassette("sample", tmp)) === null, "loadCassette returns null after delete");

  // Cleanup.
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\nSummary: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

await main();
