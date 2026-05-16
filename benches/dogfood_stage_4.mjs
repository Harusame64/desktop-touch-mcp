#!/usr/bin/env node
// ADR-019 Stage 4 — dogfood harness for the local_repaint primitive (SSIM).
//
// Mirrors benches/dogfood_stage_2b.mjs structure but exercises
// `verifyLocalRepaint` on real apps that hit the Stage 4 motivating cases:
//   - custom-paint canvases (MSPaint, Paint.NET, Photoshop, Blender)
//   - TextPattern-silent text input (VS Code editor surface)
//
// Stage 4 activation gates (production):
//   mouse_click — `classifyDelivery` returned `focus_only` / `unverifiable`
//                 AND `DESKTOP_TOUCH_STAGE4_SSIM !== "0"`
//   keyboard:type — BG verify reached `unverifiable + read_back_unsupported`
//                   AND `DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD !== "0"`
//
// The harness bypasses these gates and invokes `verifyLocalRepaint` directly
// against the same pre/post frame pair the production path would have used.
// This validates Stage 4's algorithmic correctness on real Windows apps
// independent of whether the connected MCP server has the Stage 4 wiring
// (this dogfood ships against the v1.6.0 server which does NOT have Stage 4
// in mouseClickHandler / typeHandler yet — Stage 4 wires up post-v1.6.0).
//
// Usage:
//   node benches/dogfood_stage_4.mjs --target-title "ペイント"   --mode click --cycles 30
//   node benches/dogfood_stage_4.mjs --target-title "ペイント"   --mode idle  --cycles 30
//   node benches/dogfood_stage_4.mjs --target-title "Visual Studio Code" --mode click --cycles 10

import { performance } from "node:perf_hooks";
import {
  captureFrame,
} from "../dist/engine/layer-buffer.js";
import {
  verifyLocalRepaint,
  resolveLocalRepaintRect,
} from "../dist/engine/local-repaint.js";
import {
  enumWindowsInZOrder,
  getWindowRectByHwnd,
} from "../dist/engine/win32.js";
import { mouse, Button, Point } from "@nut-tree-fork/nut-js";

const INTER_CYCLE_SLEEP_MS = 250;
const PRE_CAPTURE_SETTLE_MS = 80;   // give DWM a moment after focus transitions
const POST_CLICK_SETTLE_BEFORE_VERIFY_MS = 30;

function parseArgs(argv) {
  const args = {
    targetTitle: null,
    cycles: 30,
    mode: "click",
    clickOffsetX: null,
    clickOffsetY: null,
    jitter: 0,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inlineVal = eq > 0 ? a.slice(eq + 1) : null;
    const nextVal = () => (inlineVal !== null ? inlineVal : argv[++i]);
    if (flag === "--target-title") args.targetTitle = nextVal();
    else if (flag === "--cycles") args.cycles = Number(nextVal());
    else if (flag === "--mode") args.mode = nextVal();
    else if (flag === "--offset-x") args.clickOffsetX = Number(nextVal());
    else if (flag === "--offset-y") args.clickOffsetY = Number(nextVal());
    else if (flag === "--jitter") args.jitter = Number(nextVal());
    else if (flag === "--verbose") args.verbose = true;
    else if (flag === "--help" || flag === "-h") {
      console.log("Usage: --target-title TITLE [--cycles N] [--mode click|idle] [--offset-x N] [--offset-y N] [--jitter PX] [--verbose]");
      process.exit(0);
    }
  }
  if (!args.targetTitle) { console.error("--target-title is required"); process.exit(2); }
  if (!["click", "idle"].includes(args.mode)) { console.error("--mode must be click|idle"); process.exit(2); }
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
  console.log(`# ADR-019 Stage 4 — dogfood harness (local_repaint primitive)`);
  console.log(`# target: ${JSON.stringify(args.targetTitle)}, mode: ${args.mode}, cycles: ${args.cycles}`);

  const win = findHwndByTitle(args.targetTitle);
  if (!win) {
    console.error(`# ERROR: no window matches ${JSON.stringify(args.targetTitle)}`);
    for (const w of enumWindowsInZOrder().slice(0, 20)) console.error(`#   - ${w.title}`);
    process.exit(1);
  }
  const rect = getWindowRectByHwnd(BigInt(win.hwnd));
  if (!rect) { console.error("# ERROR: getWindowRectByHwnd null"); process.exit(1); }

  // Click point defaults to window centre; override via --offset-x / --offset-y
  // (interpreted as offset from window top-left in screen coords).
  // --jitter PX adds random ±PX per cycle so repeated clicks land at fresh
  // pixels (needed for tools like Paint.NET brush that produce stable canvas
  // state — without jitter, cycle N's pre frame already contains cycle N-1's
  // paint, so SSIM reports no_change).
  const baseClickX = rect.x + (args.clickOffsetX ?? Math.floor(rect.width / 2));
  const baseClickY = rect.y + (args.clickOffsetY ?? Math.floor(rect.height / 2));
  console.log(`# hwnd=${win.hwnd} class=${win.className} region=${rect.width}x${rect.height} baseClickPoint=(${baseClickX},${baseClickY}) jitter=${args.jitter}`);
  if (baseClickX < rect.x || baseClickX > rect.x + rect.width || baseClickY < rect.y || baseClickY > rect.y + rect.height) {
    console.error(`# ERROR: clickPoint outside windowRect`);
    process.exit(2);
  }

  // Configure nut-js for fast cursor positioning + button clicks. Default
  // mouse.config.mouseSpeed is 1000 px/sec which adds visible lag; bump to
  // teleport-like for the dogfood.
  mouse.config.autoDelayMs = 0;
  mouse.config.mouseSpeed = 10_000;

  const rows = [];
  for (let cycle = 0; cycle < args.cycles; cycle++) {
    // Stage 4's `captureFrame` always uses the SAME windowRect for both pre
    // and post (Codex Round 2 P1 fix in local-repaint.ts), so we capture pre
    // at windowRect geometry to match the orchestrator's expectations.
    await sleep(PRE_CAPTURE_SETTLE_MS);
    const preFrame = await captureFrame(BigInt(win.hwnd), {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    });
    if (!preFrame) { rows.push({ cycle, error: "pre-capture-failed" }); continue; }

    // Per-cycle click point — apply jitter if requested. Clamp to windowRect.
    let cycleClickX = baseClickX;
    let cycleClickY = baseClickY;
    if (args.jitter > 0) {
      cycleClickX = Math.max(rect.x + 1, Math.min(rect.x + rect.width - 1,
        baseClickX + Math.floor((Math.random() * 2 - 1) * args.jitter)));
      cycleClickY = Math.max(rect.y + 1, Math.min(rect.y + rect.height - 1,
        baseClickY + Math.floor((Math.random() * 2 - 1) * args.jitter)));
    }

    const tDispatch = performance.now();
    let clickErr = null;
    if (args.mode === "click") {
      try {
        await mouse.setPosition(new Point(cycleClickX, cycleClickY));
        await mouse.click(Button.LEFT);
      } catch (err) {
        clickErr = String(err?.message ?? err);
      }
    }
    const dispatchElapsedMs = performance.now() - tDispatch;

    if (clickErr) { rows.push({ cycle, error: `click-failed: ${clickErr}` }); continue; }

    await sleep(POST_CLICK_SETTLE_BEFORE_VERIFY_MS);

    // Run the production verifyLocalRepaint with the captured pre-frame.
    // The orchestrator captures post itself via capturePostFrameUntilStable.
    const hint = {
      point: args.mode === "click" ? { x: cycleClickX, y: cycleClickY } : undefined,
      windowRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    const resolved = resolveLocalRepaintRect(hint);

    const tVerify = performance.now();
    let observation;
    try {
      observation = await verifyLocalRepaint({ hwnd: BigInt(win.hwnd), hint, preFrame });
    } catch (err) {
      rows.push({ cycle, error: `verify-threw: ${err?.message ?? err}` });
      continue;
    }
    const verifyElapsedMs = performance.now() - tVerify;

    rows.push({
      cycle,
      mode: args.mode,
      clickPoint: args.mode === "click" ? { x: cycleClickX, y: cycleClickY } : null,
      rectSource: resolved.rectSource,
      resolvedRect: resolved.rect,
      observation: {
        motion: observation.motion,
        source: observation.source,
        framesSampled: observation.framesSampled,
        totalElapsedMs: Math.round(observation.totalElapsedMs ?? 0),
        residual: observation.residual ?? null,
      },
      dispatchElapsedMs: Math.round(dispatchElapsedMs),
      verifyElapsedMs: Math.round(verifyElapsedMs),
    });

    if (args.verbose) console.log(`# cycle ${cycle}: ${JSON.stringify(rows[rows.length - 1])}`);
    await sleep(INTER_CYCLE_SLEEP_MS);
  }

  const ok = rows.filter((r) => !r.error);
  const errs = rows.filter((r) => r.error);
  console.log(`\n=== Summary (n=${ok.length} ok, ${errs.length} errors) ===`);
  for (const r of errs) console.log(`  cycle ${r.cycle}: ${r.error}`);

  const motionCounts = {};
  const sourceCounts = {};
  const rectSourceCounts = {};
  const fractionChangedValues = [];
  const meanSsimValues = [];
  const verifyTimes = [];
  for (const r of ok) {
    motionCounts[r.observation.motion] = (motionCounts[r.observation.motion] ?? 0) + 1;
    sourceCounts[r.observation.source] = (sourceCounts[r.observation.source] ?? 0) + 1;
    rectSourceCounts[r.rectSource] = (rectSourceCounts[r.rectSource] ?? 0) + 1;
    if (r.observation.residual?.fractionChanged != null) fractionChangedValues.push(r.observation.residual.fractionChanged);
    if (r.observation.residual?.meanSsim != null) meanSsimValues.push(r.observation.residual.meanSsim);
    verifyTimes.push(r.verifyElapsedMs);
  }

  console.log(`\nobservation.motion         : ${JSON.stringify(motionCounts)}`);
  console.log(`observation.source         : ${JSON.stringify(sourceCounts)}`);
  console.log(`rectSource (resolver)      : ${JSON.stringify(rectSourceCounts)}`);
  if (fractionChangedValues.length > 0) {
    console.log(`fractionChanged p50/p90/p99: ${fmt(p(fractionChangedValues, 0.5))} / ${fmt(p(fractionChangedValues, 0.9))} / ${fmt(p(fractionChangedValues, 0.99))}`);
  }
  if (meanSsimValues.length > 0) {
    console.log(`meanSsim p50/p90/p99       : ${fmt(p(meanSsimValues, 0.5))} / ${fmt(p(meanSsimValues, 0.9))} / ${fmt(p(meanSsimValues, 0.99))}`);
  }
  console.log(`verifyElapsedMs p50/p90/p99: ${fmt(p(verifyTimes, 0.5))} / ${fmt(p(verifyTimes, 0.9))} / ${fmt(p(verifyTimes, 0.99))}`);

  console.log(`\nJSON_RESULTS=` + JSON.stringify({
    target: args.targetTitle, mode: args.mode, cycles: args.cycles,
    summary: { motionCounts, sourceCounts, rectSourceCounts },
    rows,
  }));
}

main().catch((err) => { console.error(err); process.exit(1); });
