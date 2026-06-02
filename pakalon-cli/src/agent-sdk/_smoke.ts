/**
 * Smoke test for PakalonAcpClient — basic instantiation and public surface.
 * Does NOT spawn a real ACP server; only exercises the SDK shape.
 */
import { EventEmitter } from "node:events";
import { PakalonAcpClient } from "./acp.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

async function main(): Promise<void> {
  // 1) The class extends EventEmitter.
  const client = new PakalonAcpClient({ bin: "echo", args: ["acp"] });
  assert(client instanceof EventEmitter, "PakalonAcpClient extends EventEmitter");

  // 2) All public methods exist.
  for (const m of [
    "connect", "disconnect", "createSession", "loadSession",
    "prompt", "cancel",
    "setMode", "setModel", "listModels", "listModes",
    "isConnected",
  ]) {
    assert(typeof (client as any)[m] === "function", `method ${m} exists`);
  }

  // 3) Initially not connected.
  assert(client.isConnected() === false, "starts disconnected");
  assert(client.currentSessionId === null, "starts with no currentSessionId");

  // 4) EventEmitter surfaces work (can subscribe without error).
  let listenerCalled = false;
  client.on("ready", () => { listenerCalled = true; });
  client.emit("ready");
  assert(listenerCalled, "EventEmitter subscription works");
  client.removeAllListeners();

  // 5) disconnect() before connect() is a no-op (no throw).
  let threw = false;
  try { await client.disconnect(); } catch { threw = true; }
  assert(!threw, "disconnect() before connect() is safe");

  console.log(`\nSummary: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

await main();
