#!/usr/bin/env node
// ADR-019 Stage 2b — dogfood harness for the TMOL decision gate.
//
// Extends benches/poc_stage_2a_causal_strip.mjs to surface the new Stage 2b
// DispatchOutcome shape (sub-plan §5 R3 Option I):
//   scrolled === true  + reason: "delivered_via_postmessage" + observation.motion: "translation"
//   scrolled === false + reason: "target_unreachable"        + observation.motion: "no_change"
//
// The natural silent-drop synthesis used here is **boundary scroll-up while at
// row A1** (Excel posts the wheel message but the visible region cannot move,
// so finalChangedFraction === 0 and Stage 2b flips the status). Plan §6 OQ #1
// allowed this as a legitimate carry-over reason for target_unreachable; the
// dogfood evidence reuses it as the deterministic silent-drop reproduction.
//
// Usage:
//   node benches/dogfood_stage_2b.mjs --target-title "Book1 - Excel" --mode real-down --cycles 30
//   node benches/dogfood_stage_2b.mjs --target-title "Book1 - Excel" --mode boundary-up --cycles 30
//   node benches/dogfood_stage_2b.mjs --target-title "Book1 - Excel" --mode boundary-up --cycles 5 --stage2b-off
//   node benches/dogfood_stage_2b.mjs --target-title "Book1 - Excel" --mode boundary-up --cycles 5 --stage2a-off

import { performance } from "node:perf_hooks";
import {
  enumWindowsInZOrder,
  getWindowRectByHwnd,
} from "../dist/engine/win32.js";
import {
  postWheelToHwnd,
} from "../dist/tools/_input-pipeline.js";
import {
  captureWindowRawWithFallback,
} from "../dist/engine/image.js";

const SCROLL_NOTCH = 3;
const INTER_CYCLE_SLEEP_MS = 200;

function parseArgs(argv) {
  const args = { targetTitle: null, cycles: 30, mode: "real-down", verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inlineVal = eq > 0 ? a.slice(eq + 1) : null;
    const nextVal = () => (inlineVal !== null ? inlineVal : argv[++i]);
    if (flag === "--target-title") args.targetTitle = nextVal();
    else if (flag === "--cycles") args.cycles = Number(nextVal());
    else if (flag === "--mode") args.mode = nextVal();
    else if (flag === "--verbose") args.verbose = true;
    else if (flag === "--stage2b-off") process.env.DESKTOP_TOUCH_STAGE2B_GATE = "0";
    else if (flag === "--stage2a-off") process.env.DESKTOP_TOUCH_STAGE2A_RING = "0";
    else if (flag === "--help" || flag === "-h") {
      console.log("Usage: --target-title TITLE [--cycles N] [--mode real-down|boundary-up|idle] [--stage2b-off] [--stage2a-off] [--verbose]");
      process.exit(0);
    }
  }
  if (!args.targetTitle) { console.error("--target-title is required"); process.exit(2); }
  if (!["real-down", "boundary-up", "idle"].includes(args.mode)) {
    console.error("--mode must be real-down|boundary-up|idle"); process.exit(2);
  }
  return args;
}

function findHwndByTitle(title) {
  const q = title.toLowerCase();
  return enumWindowsInZOrder().find((w) => w.title.toLowerCase().includes(q) && !w.isMinimized) ?? null;
}

function p(arr, q) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
function fmt(n) { return n === null ? "n/a" : (Math.round(n * 1000) / 1000).toString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv);
  const stage2aOff = process.env.DESKTOP_TOUCH_STAGE2A_RING === "0";
  const stage2bOff = process.env.DESKTOP_TOUCH_STAGE2B_GATE === "0";
  console.log(`# ADR-019 Stage 2b — dogfood harness`);
  console.log(`# target: ${JSON.stringify(args.targetTitle)}, mode: ${args.mode}, cycles: ${args.cycles}`);
  console.log(`# env: DESKTOP_TOUCH_STAGE2A_RING=${stage2aOff ? "0" : "(default on)"}, DESKTOP_TOUCH_STAGE2B_GATE=${stage2bOff ? "0" : "(default on)"}`);

  const win = findHwndByTitle(args.targetTitle);
  if (!win) {
    console.error(`# ERROR: no window matches ${JSON.stringify(args.targetTitle)}`);
    for (const w of enumWindowsInZOrder().slice(0, 20)) console.error(`#   - ${w.title}`);
    process.exit(1);
  }
  const rect = getWindowRectByHwnd(BigInt(win.hwnd));
  if (!rect) { console.error("# ERROR: getWindowRectByHwnd null"); process.exit(1); }
  console.log(`# hwnd=${win.hwnd} class=${win.className} region=${rect.width}x${rect.height}`);

  const rows = [];
  const direction = args.mode === "boundary-up" ? "up" : "down";

  // For boundary-up mode, capture preFrame ONCE per cycle (the act of
  // scrolling-up at A1 should not move pixels; the bench just exercises the
  // dispatcher to surface Stage 2b's gate decision).
  for (let cycle = 0; cycle < args.cycles; cycle++) {
    const preFrame = await captureWindowRawWithFallback(BigInt(win.hwnd), {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    }).catch(() => null);
    if (!preFrame) {
      rows.push({ cycle, error: "pre-capture-failed" });
      continue;
    }

    const t0 = performance.now();
    let dispatchOutcome = null;
    if (args.mode !== "idle") {
      try {
        dispatchOutcome = await postWheelToHwnd(BigInt(win.hwnd), { direction, notch: SCROLL_NOTCH });
      } catch (err) {
        rows.push({ cycle, error: `dispatch-threw: ${err?.message ?? err}` });
        continue;
      }
    }
    const dispatchElapsedMs = performance.now() - t0;

    const obs = dispatchOutcome?.observation ?? null;
    rows.push({
      cycle,
      dispatchOutcome: {
        kind: dispatchOutcome === null ? "null-fallthrough" : "non-null",
        scrolled: dispatchOutcome?.scrolled ?? null,
        channel: dispatchOutcome?.channel ?? null,
        reason: dispatchOutcome?.reason ?? null,
      },
      observation: obs === null ? null : {
        motion: obs.motion ?? null,
        source: obs.source ?? null,
        framesSampled: obs.framesSampled ?? null,
        totalElapsedMs: obs.totalElapsedMs ?? null,
        finalChangedFraction: obs.ringTelemetry?.finalChangedFraction ?? null,
        stableReached: obs.ringTelemetry?.stableReached ?? null,
        stripsAboveNoise: obs.ringTelemetry?.stripsAboveNoise ?? null,
      },
      dispatchElapsedMs: Math.round(dispatchElapsedMs),
    });

    if (args.verbose) console.log(`# cycle ${cycle}: ${JSON.stringify(rows[rows.length - 1])}`);
    await sleep(INTER_CYCLE_SLEEP_MS);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  const ok = rows.filter((r) => !r.error);
  const errs = rows.filter((r) => r.error);
  console.log(`\n=== Summary (n=${ok.length} ok, ${errs.length} errors) ===`);
  if (errs.length) console.log(`errors:`); for (const r of errs) console.log(`  cycle ${r.cycle}: ${r.error}`);

  // Per-field histogram
  const scrolledCounts = {};
  const reasonCounts = {};
  const motionCounts = {};
  const sourceCounts = {};
  const fcfValues = [];
  const wallclock = [];
  for (const r of ok) {
    const s = r.dispatchOutcome.scrolled === null ? "(null)" : String(r.dispatchOutcome.scrolled);
    scrolledCounts[s] = (scrolledCounts[s] ?? 0) + 1;
    const reason = r.dispatchOutcome.reason ?? "(null)";
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    const motion = r.observation?.motion ?? "(none)";
    motionCounts[motion] = (motionCounts[motion] ?? 0) + 1;
    const source = r.observation?.source ?? "(none)";
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
    if (typeof r.observation?.finalChangedFraction === "number") {
      fcfValues.push(r.observation.finalChangedFraction);
    }
    // dispatchElapsedMs already includes the ring observation time (the ring
    // runs inside postWheelToHwnd → observeViaUiaOrChainTrust). Do NOT add
    // observation.totalElapsedMs again — that would double-count.
    wallclock.push(r.dispatchElapsedMs);
  }

  console.log(`\nDispatchOutcome.scrolled  : ${JSON.stringify(scrolledCounts)}`);
  console.log(`DispatchOutcome.reason    : ${JSON.stringify(reasonCounts)}`);
  console.log(`observation.motion        : ${JSON.stringify(motionCounts)}`);
  console.log(`observation.source        : ${JSON.stringify(sourceCounts)}`);
  if (fcfValues.length > 0) {
    console.log(`finalChangedFraction p50/p90/p99: ${fmt(p(fcfValues, 0.5))} / ${fmt(p(fcfValues, 0.9))} / ${fmt(p(fcfValues, 0.99))}`);
    const nonZero = fcfValues.filter((v) => v > 0).length;
    console.log(`finalChangedFraction > 0 : ${nonZero}/${fcfValues.length}`);
  }
  console.log(`wallclock p50/p90/p99 ms : ${fmt(p(wallclock, 0.5))} / ${fmt(p(wallclock, 0.9))} / ${fmt(p(wallclock, 0.99))}`);

  console.log(`\nJSON_RESULTS=` + JSON.stringify({
    target: args.targetTitle, mode: args.mode, cycles: args.cycles,
    env: { stage2aOff, stage2bOff },
    summary: { scrolledCounts, reasonCounts, motionCounts, sourceCounts },
    rows,
  }));
}

main().catch((err) => { console.error(err); process.exit(1); });
