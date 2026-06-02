/**
 * Smoke test for specialized query handlers.
 *
 * Verifies the registry, handler shape, and the searchAll/healthAll
 * convenience functions. Each handler is allowed to be offline —
 * we only assert the public surface and that exceptions are caught.
 */
import {
  getHandler,
  listHandlers,
  searchAll,
  healthAll,
  type HandlerId,
} from "./index.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

async function main(): Promise<void> {
  const handlers = listHandlers();
  assert(handlers.length >= 4, "registry has at least 4 handlers");
  assert(handlers.some((h) => h.id === "github"), "github handler registered");
  assert(handlers.some((h) => h.id === "npm"), "npm handler registered");
  assert(handlers.some((h) => h.id === "arxiv"), "arxiv handler registered");
  assert(handlers.some((h) => h.id === "stack-overflow"), "stack-overflow handler registered");

  for (const entry of handlers) {
    assert(typeof entry.id === "string", `entry has id=${entry.id}`);
    assert(typeof entry.label === "string" && entry.label.length > 0, `${entry.id} has label`);
    const h = getHandler(entry.id);
    assert(h !== undefined, `getHandler(${entry.id}) returns the handler`);
    if (h) {
      assert(h.id === entry.id, `handler.id === "${entry.id}"`);
      assert(typeof h.search === "function", `${entry.id}.search is a function`);
      assert(typeof h.fetch === "function", `${entry.id}.fetch is a function`);
      assert(typeof h.format === "function", `${entry.id}.format is a function`);
      assert(typeof h.health === "function", `${entry.id}.health is a function`);
      const health = await h.health();
      assert(typeof health === "object", `${entry.id}.health returns an object`);
      assert(typeof health.ok === "boolean", `${entry.id}.health.ok is boolean`);
    }
  }

  // searchAll is a function that returns an array. We don't actually
  // invoke it here because it makes real network calls; smoke tests
  // stay offline. The signature is verified by the registry checks
  // above and the per-handler format() / health() checks below.
  assert(typeof searchAll === "function", "searchAll is exported as a function");
  assert(typeof healthAll === "function", "healthAll is exported as a function");

  // healthAll returns a record keyed by handler id.
  const healthMap = await healthAll();
  assert(typeof healthMap === "object" && healthMap !== null, "healthAll returns a record");
  assert(healthMap.npm !== undefined, "healthMap has npm");
  assert(healthMap.github !== undefined, "healthMap has github");
  assert(healthMap.arxiv !== undefined, "healthMap has arxiv");
  assert(healthMap["stack-overflow"] !== undefined, "healthMap has stack-overflow");
  for (const id of ["github", "npm", "arxiv", "stack-overflow"] as const) {
    const entry = healthMap[id];
    assert(typeof entry.ok === "boolean", `healthMap.${id}.ok is boolean`);
    assert(typeof entry.latencyMs === "number", `healthMap.${id}.latencyMs is number`);
  }

  // Per-handler: format() works on a synthetic result.
  const npm = getHandler("npm");
  if (npm) {
    const formatted = npm.format({
      id: "react",
      title: "React",
      url: "https://www.npmjs.com/package/react",
      snippet: "A declarative, efficient JavaScript library for building UIs.",
      score: 0.95,
      metadata: { version: "18.0.0", author: "facebook" },
    });
    assert(typeof formatted === "string" && formatted.length > 0, "npm.format returns a string");
    assert(formatted.includes("React"), "npm.format includes the title");
  }

  console.log(`\nSummary: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

await main();
