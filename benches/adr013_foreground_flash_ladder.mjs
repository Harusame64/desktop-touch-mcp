#!/usr/bin/env node
// ADR-013 Phase 2 — Production-like ladder success rate bench.
//
// Spawns the production MCP server (`dist/index.js`) over **stdio MCP
// transport**, opens a real `@modelcontextprotocol/sdk` Client, and
// invokes `keyboard:type` with `method: 'foreground_flash'` against a
// **manually-launched Windows Terminal** window 50 times.
//
// For each iteration, parses `hints.foregroundStealMethod` and the typed
// failure reason, aggregates per-stage success counts, and reports:
//
//   - Stage 1 (`AttachThreadInput`) success count
//   - Stage 2 (`alt_unlock`) success count
//   - `already_foreground` skip count (target was already foreground)
//   - Failure counts per typed reason (`foreground_steal_denied` /
//     `focus_wait_timeout` / `clipboard_lock_contention` /
//     `foreground_restore_failed` / `wt_paste_warning_intercepted` /
//     `send_input_failed` / unknown)
//   - Total ladder success rate (Stage 1 + 2 + already_foreground / total)
//
// **R1 acceptance gate** (plan v3 §6.2): total ladder success >= 80%.
// Sub-80% exits with code 1 + suggests design review (LowLevel hook
// default ON, Option F priority shift, etc.).
//
// ## Operator setup (重要)
//
// 1. Build native + TS:
//      npm run build:rs && npm run build
// 2. **Launch Windows Terminal manually** (bench does NOT auto-spawn WT
//    because the spawn process is the foreground steal target — a process
//    that just spawned WT typically owns foreground rights and would
//    skew Stage 1 measurement to artificially high success).
// 3. Click any other window briefly so caller (this Node process) does
//    NOT have foreground (= production-like condition).
// 4. Run bench:
//      node benches/adr013_foreground_flash_ladder.mjs --window-title=<title>
//    or to pick the most recent WT window automatically:
//      node benches/adr013_foreground_flash_ladder.mjs
//
// Optional flags:
//   --iters=<N>        — iteration count (default 50, min 10)
//   --window-title=<s> — windowTitle substring (default first WT match)
//   --press-enter      — pass pressEnter:true to flash (terminal-style)
//
// Output: text report on stdout. exit code 0 = >= 80% ladder success,
// 1 = sub-80% (R1 mitigation review required).

import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── CLI args ────────────────────────────────────────────────────────────────

const DEFAULT_ITERS = 50;
const MIN_ITERS = 10;
const LADDER_SUCCESS_GATE = 0.8;
const POST_INJECT_DELAY_MS = 50; // brief settle so 50 consecutive injects don't overlap

const args = process.argv.slice(2);
let iters = DEFAULT_ITERS;
let windowTitle = null;
let pressEnter = false;
const usage =
  "usage: node adr013_foreground_flash_ladder.mjs [--iters=N] [--window-title=substring] [--press-enter]";

for (const a of args) {
  if (a.startsWith("--iters=")) {
    iters = Number(a.slice(8));
    if (!Number.isFinite(iters) || iters < MIN_ITERS) {
      console.error(`error: --iters must be >= ${MIN_ITERS}`);
      console.error(usage);
      process.exit(2);
    }
  } else if (a.startsWith("--window-title=")) {
    windowTitle = a.slice(15);
    if (!windowTitle) {
      console.error("error: --window-title cannot be empty");
      process.exit(2);
    }
  } else if (a === "--press-enter") {
    pressEnter = true;
  } else if (a === "--help" || a === "-h") {
    console.log(usage);
    process.exit(0);
  } else {
    console.error(`error: unrecognised argument: ${a}`);
    console.error(usage);
    process.exit(2);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const serverPath = resolve(repoRoot, "dist", "index.js");
if (!existsSync(serverPath)) {
  console.error(
    `error: server entry not found: ${serverPath}\n` +
      `Run \`npm run build\` (and \`npm run build:rs\`) before invoking this bench.`,
  );
  process.exit(2);
}

// ─── Validate --window-title BEFORE MCP server spawn (Round 1 P2-2 + Round 2 P3-1)
// connect 前に check することで無駄な MCP server spawn を回避。WT の HWND
// title は active tab title (PowerShell / pwsh / etc) で変動するため明示必須化。
if (!windowTitle) {
  console.error(
    "error: --window-title is required.\n" +
      "  WT の HWND title は active tab title (PowerShell / pwsh / etc) で変動するため、\n" +
      "  bench 実行前に WT を起動 + active tab を確認し、その partial title を渡すこと。\n" +
      "  例: --window-title=\"PowerShell\" や --window-title=\"pwsh\" など。",
  );
  console.error(usage);
  process.exit(2);
}

// ─── MCP client setup ────────────────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DESKTOP_TOUCH_AUTO_GUARD: "0" },
  stderr: "pipe",
});
const client = new Client(
  { name: "adr013-ff-ladder-bench", version: "0.0.0" },
  { capabilities: {} },
);
await client.connect(transport);

console.log(
  `# adr013_foreground_flash_ladder — ${iters} iters against windowTitle="${windowTitle}", pressEnter=${pressEnter}`,
);
console.log(
  `# OPERATOR NOTE: ensure caller does NOT have foreground (click WT or another window briefly before run)`,
);
console.log("");

// ─── Helper: parse keyboard:type response payload ──────────────────────────

const parsePayload = (result) => {
  let payload = result?.structuredContent;
  if (!payload && Array.isArray(result?.content)) {
    const text = result.content.find((c) => c?.type === "text")?.text;
    if (typeof text === "string") {
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, code: "ParseError", rawText: text };
      }
    }
  }
  return payload ?? { ok: false, code: "MissingPayload" };
};

// ─── Run iterations ────────────────────────────────────────────────────────

const stealCounts = {
  AttachThreadInput: 0,
  alt_unlock: 0,
  already_foreground: 0,
};
const failureCounts = new Map(); // typed reason → count
let successTotal = 0;
let failureTotal = 0;
let parseErrors = 0;
const flashDurationsMs = [];

for (let i = 0; i < iters; i++) {
  const tag = `ff-bench-${i}-${Date.now().toString(36)}`;
  let result;
  try {
    const t0 = performance.now();
    result = await client.callTool({
      name: "keyboard",
      arguments: {
        action: "type",
        text: tag,
        method: "foreground_flash",
        windowTitle,
      },
    });
    const t1 = performance.now();
    void t1;
    void t0;
  } catch (e) {
    failureTotal++;
    const key = `transport_error:${e?.message ?? String(e)}`;
    failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
    continue;
  }

  const payload = parsePayload(result);
  if (payload.code === "ParseError") {
    parseErrors++;
    failureTotal++;
    continue;
  }

  if (payload.ok === true) {
    successTotal++;
    const method = payload?.hints?.foregroundStealMethod;
    if (method && stealCounts[method] !== undefined) {
      stealCounts[method]++;
    }
    if (typeof payload?.hints?.flashDurationMs === "number") {
      flashDurationsMs.push(payload.hints.flashDurationMs);
    }
  } else {
    failureTotal++;
    // Typed reason は context.reason (handler 経由で snake_case で透過)
    const reason = payload?.context?.reason ?? payload?.code ?? "unknown";
    failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
  }

  await sleep(POST_INJECT_DELAY_MS);
}

await client.close();

// ─── Stats ───────────────────────────────────────────────────────────────────

const totalLadderSuccess =
  stealCounts.AttachThreadInput + stealCounts.alt_unlock + stealCounts.already_foreground;
const ladderSuccessRate = totalLadderSuccess / iters;

const computeFlashStats = (samples) => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { n: sorted.length, mean, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) };
};
const flashStats = computeFlashStats(flashDurationsMs);

// ─── Output ──────────────────────────────────────────────────────────────────

console.log("## ladder success counts");
console.log(`Stage 1 (AttachThreadInput) : ${stealCounts.AttachThreadInput}`);
console.log(`Stage 2 (alt_unlock)        : ${stealCounts.alt_unlock}`);
console.log(`already_foreground (skip)   : ${stealCounts.already_foreground}`);
console.log(`Total ladder success        : ${totalLadderSuccess}/${iters} (${(ladderSuccessRate * 100).toFixed(1)}%)`);
console.log("");

console.log("## failures (typed reason → count)");
if (failureCounts.size === 0) {
  console.log("(none)");
} else {
  const sortedReasons = [...failureCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    console.log(`${reason.padEnd(48, " ")}: ${count}`);
  }
}
console.log("");

if (flashStats) {
  console.log("## flash duration (success-only, ms)");
  console.log(`n    : ${flashStats.n}`);
  console.log(`mean : ${flashStats.mean.toFixed(2)} ms`);
  console.log(`p50  : ${flashStats.p50.toFixed(2)} ms`);
  console.log(`p95  : ${flashStats.p95.toFixed(2)} ms`);
  console.log(`p99  : ${flashStats.p99.toFixed(2)} ms`);
  console.log("");
}

// ─── Sanity totals (operator integrity check) ──────────────────────────────
console.log("## sanity totals");
console.log(`success : ${successTotal} / ${iters}`);
console.log(`failure : ${failureTotal} / ${iters}`);
console.log(`(success + failure should equal iters)`);
console.log("");

if (parseErrors > 0) {
  console.log(`# WARNING: ${parseErrors} payload(s) failed to parse`);
}

// ─── Acceptance gate (plan v3 §6.2) ────────────────────────────────────────

console.log(`## R1 acceptance gate (plan v3 §6.2): >= ${(LADDER_SUCCESS_GATE * 100).toFixed(0)}%`);
if (ladderSuccessRate >= LADDER_SUCCESS_GATE) {
  console.log(`PASS — ${(ladderSuccessRate * 100).toFixed(1)}% >= ${(LADDER_SUCCESS_GATE * 100).toFixed(0)}%`);
  process.exit(0);
} else {
  console.log(`FAIL — ${(ladderSuccessRate * 100).toFixed(1)}% < ${(LADDER_SUCCESS_GATE * 100).toFixed(0)}%`);
  console.log(
    "Design review required:\n" +
      "  - Consider DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1 (default ON for typing leak mitigation)\n" +
      "  - Consider Option F (Cooperative in-pane bridge) priority shift\n" +
      "  - Re-evaluate Option E ROI vs cost",
  );
  process.exit(1);
}
