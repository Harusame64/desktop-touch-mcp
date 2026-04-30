#!/usr/bin/env node
// ADR-008 D2-B-4 — MCP transport bench for `desktop_state`.
//
// Spawns the production server (`dist/server-windows.js`) over **stdio
// MCP transport**, opens a real `@modelcontextprotocol/sdk` Client, and
// measures the latency of `tools/call desktop_state` end-to-end:
//
//   client → JSON-RPC stringify → stdio pipe → server router →
//   desktop_state handler (view-first focus path, D2-B-2) →
//   JSON-RPC stringify back → stdio pipe → client parse
//
// This is the production read latency that an agent observes — the
// previous bench (`d1_ts_baseline.mjs`) measures only the napi UIA call
// in-process, which is the lower bound, not the production gap.
//
// Steady-state coverage (followups §2.4): repeated `desktop_state` calls
// with focus held in this terminal. The view should hit on most
// iterations (`hints.focusedElementSource === "view"`) once focus_pump
// has populated the latest_focus view from real OS focus events. We
// histogram the source distribution at the end so the report tells you
// empirically which path each call took.
//
// "Real L1 input ベース" focus-induced bench (followups §2.3): out of
// scope here — that requires programmatic focus changes (alt+tab via
// keybd_event or window switching) and is best handled either by an
// operator-driven manual bench or as a follow-up. The view path's
// update latency under L1 ring load is already covered by the Rust
// criterion bench (`d1_view_latency::view_update_latency`).
//
// Usage:
//   node benches/d2_desktop_state_roundtrip.mjs            # 1000 iters (default)
//   node benches/d2_desktop_state_roundtrip.mjs 5000       # custom iter count
//
// Requirements:
//   - Windows session with at least one focused application
//   - `npm run build` (TS) and `npm run build:rs` (native addon) completed
//   - `dist/server-windows.js` present
//
// Output: text report on stdout — count, mean, p50/p95/p99 in
// microseconds, plus the `hints.focusedElementSource` distribution.

import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_ITERATIONS = 1000;
const WARMUP_ITERATIONS = 100;

const iterations = Number(process.argv[2] ?? DEFAULT_ITERATIONS);
if (!Number.isFinite(iterations) || iterations < 100) {
  console.error("usage: node d2_desktop_state_roundtrip.mjs [iterations >= 100]");
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const serverPath = resolve(repoRoot, "dist", "server-windows.js");
if (!existsSync(serverPath)) {
  console.error(`server entry not found: ${serverPath} — run \`npm run build\``);
  process.exit(2);
}

// AUTO_GUARD=0 disables the lensId precondition on action tools — `desktop_state`
// itself doesn't need it but the production server logs a startup banner under
// guard mode that adds noise to the cold-start hop. (See feedback memory
// `pre_v0_12_e2e_autoguard.md`.)
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DESKTOP_TOUCH_AUTO_GUARD: "0" },
  stderr: "pipe",
});

const client = new Client({ name: "d2-bench", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const callDesktopState = async () => {
  const result = await client.callTool({ name: "desktop_state", arguments: {} });
  return result;
};

// Warmup: prime the UIA thread, populate the latest_focus view via focus_pump,
// page in cold paths on both the client and server side.
for (let i = 0; i < WARMUP_ITERATIONS; i++) {
  await callDesktopState();
}

const samplesUs = new Float64Array(iterations);
const sourceCounts = new Map(); // hints.focusedElementSource → count
let parseErrors = 0;

for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  const result = await callDesktopState();
  const t1 = performance.now();
  samplesUs[i] = (t1 - t0) * 1000; // ms → µs

  // Diagnose which focus path each iteration took. Server returns
  // structured content (newer SDK) or a content[0].text JSON blob
  // (older SDK / fallback) — handle both.
  let payload = result?.structuredContent;
  if (!payload && Array.isArray(result?.content)) {
    const text = result.content.find((c) => c?.type === "text")?.text;
    if (typeof text === "string") {
      try {
        payload = JSON.parse(text);
      } catch {
        parseErrors++;
      }
    }
  }
  const source = payload?.hints?.focusedElementSource ?? "(unset)";
  sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
}

await client.close();

const sorted = Array.from(samplesUs).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;

const fmt = (us) => `${us.toFixed(2)} µs`;

console.log(`# d2_desktop_state_roundtrip — MCP stdio transport (${iterations} iters)`);
console.log(`mean : ${fmt(mean)}`);
console.log(`p50  : ${fmt(pct(0.50))}`);
console.log(`p95  : ${fmt(pct(0.95))}`);
console.log(`p99  : ${fmt(pct(0.99))}`);
console.log(`max  : ${fmt(sorted[sorted.length - 1])}`);
console.log("");
console.log("# focusedElementSource distribution (view path = D2-B-2 hit):");
for (const [source, count] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const pctOfTotal = ((count / iterations) * 100).toFixed(1);
  console.log(`#   ${source.padEnd(10)} : ${count} (${pctOfTotal}%)`);
}
if (parseErrors > 0) {
  console.log(`#   parse errors: ${parseErrors}`);
}
console.log("");

// `latest_focus` populates only after focus_pump receives at least one
// `UiaFocusChanged` event. If the operator runs the bench while focus
// stays in this terminal, the L1 ring sees no focus change and the
// view stays empty — every iteration falls through to the UIA fallback
// (`hints.focusedElementSource = "uia"`). The numbers are still useful
// (they reflect the production MCP transport + UIA fallback path) but
// the view path is not exercised. Walk the operator through inducing
// one focus change so the second run also covers the view path.
const viewHitCount = sourceCounts.get("view") ?? 0;
if (viewHitCount === 0) {
  console.log("# OPERATOR NOTE: view path was NOT exercised in this run.");
  console.log("#   The latest_focus view only populates after focus_pump receives");
  console.log("#   at least one UIA focus event. To measure the view path:");
  console.log("#     1. Start this bench from a terminal");
  console.log("#     2. While warmup is running, alt+tab to a different window");
  console.log("#        and back — that emits two focus events");
  console.log("#     3. Re-read the source distribution above");
  console.log("");
}

console.log("# Acceptance gate (ADR-008 D2 §11, OQ #16 — judged after this number is in):");
console.log("#   desktop_state MCP round-trip p99  <  TS with-point baseline p99 / N");
console.log("#   (N = 5 or 10, decided post-bench based on production gap)");
console.log("#");
console.log("# Compare against:");
console.log("#   node benches/d1_ts_baseline.mjs --with-point-query");
