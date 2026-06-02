/**
 * Smoke test for typed-yield: register schemas, submit, read, prune.
 */
import { z } from "zod";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
  defineYield,
  submitYield,
  readYield,
  readLatestYield,
  listYieldsFor,
  deleteYield,
  getSchema,
  listYields,
} from "./typed-yield.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

function main(): void {
  // Isolate the test to a temp dir.
  const tmp = path.join(os.tmpdir(), `pakalon-yields-smoke-${Date.now()}`);
  process.env["PAKALON_CONFIG_DIR"] = tmp;

  // 1) Builtins registered at module load.
  assert(getSchema("review.findings") !== undefined, "review.findings builtin registered");
  assert(getSchema("audit.summary") !== undefined, "audit.summary builtin registered");
  assert(getSchema("phase.complete") !== undefined, "phase.complete builtin registered");

  // 2) defineYield accepts (name, schema, opts).
  const ticketSchema = z.object({
    ticketId: z.string().min(1),
    summary: z.string(),
    priority: z.enum(["low", "med", "high"]),
    tags: z.array(z.string()).default([]),
  });
  defineYield("support.ticket", ticketSchema, { description: "Customer support ticket" });
  assert(getSchema("support.ticket") === ticketSchema, "custom yield registered");

  // 3) Submit + read roundtrip.
  const written = submitYield("support.ticket", {
    ticketId: "T-1",
    summary: "Login fails on Safari 17",
    priority: "high",
    tags: ["safari", "auth"],
  });
  assert(written.ok === true, "submit returns ok=true for valid payload");
  assert(typeof written.id === "string" && written.id.length > 0, "submit returns an id");
  if (written.ok && written.id) {
    const back = readYield<{ id: string; name: string; createdAt: string; value: { ticketId: string; summary: string } }>(
      "support.ticket", written.id,
    );
    assert(back !== null, "readYield finds the written record");
    assert(back?.value.ticketId === "T-1", "readYield returns the same payload");
  }

  // 4) Invalid payload is rejected with ok=false and an error.
  const bad = submitYield("support.ticket", { ticketId: "", summary: "x", priority: "low" });
  assert(bad.ok === false, "submit rejects invalid payload");
  assert(typeof bad.error === "string" && bad.error.length > 0, "submit returns error message");

  // 5) Unknown yield name is rejected.
  const unknown = submitYield("does.not.exist", { x: 1 });
  assert(unknown.ok === false, "submit rejects unknown yield name");
  assert(unknown.error?.includes("unknown yield") === true, "error message names the unknown yield");

  // 6) readLatestYield returns the most recent.
  const second = submitYield("support.ticket", {
    ticketId: "T-2",
    summary: "Second ticket",
    priority: "med",
    tags: [],
  });
  const latest = readLatestYield<{ id: string; value: { ticketId: string } }>("support.ticket");
  assert(latest !== null, "readLatestYield returns a record");
  if (second.ok && latest) {
    assert(latest.value.ticketId === "T-2", "readLatestYield returns the most recent");
  }

  // 7) listYieldsFor enumerates.
  const list = listYieldsFor("support.ticket");
  assert(list.length >= 2, "listYieldsFor returns all records");

  // 8) deleteYield removes.
  if (written.ok && written.id) {
    const ok = deleteYield("support.ticket", written.id);
    assert(ok, "deleteYield returns true");
    assert(readYield("support.ticket", written.id) === null, "deleted record is gone");
  }

  // 9) listYields returns registered names.
  const registered = listYields();
  assert(registered.length >= 4, "listYields returns at least 4 entries (3 builtins + 1 custom)");
  assert(registered.some((y) => y.name === "support.ticket"), "listYields includes custom yield");
  assert(registered.some((y) => y.name === "review.findings"), "listYields includes builtin");

  // Cleanup.
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\nSummary: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main();
