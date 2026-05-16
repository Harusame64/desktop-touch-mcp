#!/usr/bin/env node
// ADR-019 Stage 2a — PoC for stop-detection + causal strip filtering.
//
// User-prompted design refinement (2026-05-16): instead of fixed
// `[30, 60, 120, 240] ms` sample ring, poll until visual stability is
// detected (2 consecutive sub-threshold frames), then compute strip-wise
// changedFraction between preFrame and the stable frame, with strips
// oriented along the EXPECTED MOTION AXIS (scroll-down → horizontal
// strips; the expected pattern is "all strips change" because content
// shifts across them; caret blink → 1 strip changes; spinner → small
// region changes). The PoC validates 5 hypotheses on real apps before
// the production wiring commits.
//
// Hypotheses (per docs/adr-019-stage-2a-plan.md handoff):
//   H1 — real scroll: stripsAboveNoise ≥ 3 (allowing frozen header row in Excel)
//   H2 — caret-blink-only Notepad: stripsAboveNoise ≤ 1
//   H3 — stable reached within 700 ms p99 (Excel + Word + Notepad)
//   H4 — GPU staleness absorbed by minWaitMs = 50 (no first-poll == pre case)
//   H5 — frozen-region apps need per-app threshold (data calibration)
//
// Usage:
//   node benches/poc_stage_2a_causal_strip.mjs --target-title "Book1 - Excel" --cycles 30
//   node benches/poc_stage_2a_causal_strip.mjs --target-title "Notepad" --baseline=idle --cycles 10
//
// Requirements:
//   - Native engine built (`npm run build:rs`) and `npm run build` for dist/
//   - The target window must be openable and focusable

import { performance } from "node:perf_hooks";
import {
  captureWindowRawWithFallback,
} from "../dist/engine/image.js";
import {
  computeChangeFraction,
} from "../dist/engine/layer-buffer.js";
import {
  enumWindowsInZOrder,
  getWindowRectByHwnd,
} from "../dist/engine/win32.js";
import {
  postWheelToHwnd,
} from "../dist/tools/_input-pipeline.js";

// ─── Tunable PoC parameters (locked at the end of the PoC, hard-coded
// here so each run is reproducible from the script alone) ───────────────────
const POLL_INTERVAL_MS = 30;          // ~2 DWM frames @ 60 Hz
const MIN_WAIT_MS = 50;                // GPU staleness guard (~3 DWM frames)
const STABLE_THRESHOLD = 0.002;        // 0.2 % block diff
const STRIP_NOISE_THRESHOLD = 0.01;    // 1 % per-strip block diff
const CONSECUTIVE_STABLE = 2;          // Playwright pattern
const BUDGET_MS = 700;                 // covers caret cycle (530 ms) + safety
const STRIP_COUNT = 4;                 // horizontal strips for vertical scroll
const SCROLL_NOTCH = 3;                // 3 wheel notches per dispatch

// ─── Arg parsing ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    targetTitle: null,
    cycles: 30,
    baseline: null, // null = real scroll; "idle" = no dispatch; "round-trip" = scroll then reverse
    direction: "down",
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    // Support both `--flag value` and `--flag=value` forms.
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inlineVal = eq > 0 ? a.slice(eq + 1) : null;
    const nextVal = () => (inlineVal !== null ? inlineVal : argv[++i]);
    if (flag === "--target-title") args.targetTitle = nextVal();
    else if (flag === "--cycles") args.cycles = Number(nextVal());
    else if (flag === "--baseline") args.baseline = nextVal();
    else if (flag === "--direction") args.direction = nextVal();
    else if (flag === "--verbose") args.verbose = true;
    else if (flag === "--help" || flag === "-h") {
      console.log(
        "Usage: node benches/poc_stage_2a_causal_strip.mjs --target-title TITLE [--cycles N] [--baseline idle|round-trip] [--direction down|up|left|right] [--verbose]",
      );
      process.exit(0);
    }
  }
  if (!args.targetTitle) {
    console.error("--target-title is required");
    process.exit(2);
  }
  if (args.baseline !== null && args.baseline !== "idle" && args.baseline !== "round-trip") {
    console.error("--baseline must be 'idle' or 'round-trip'");
    process.exit(2);
  }
  if (!["down", "up", "left", "right"].includes(args.direction)) {
    console.error("--direction must be down|up|left|right");
    process.exit(2);
  }
  return args;
}

// ─── HWND resolution ────────────────────────────────────────────────────────
function findHwndByTitle(title) {
  const q = title.toLowerCase();
  const wins = enumWindowsInZOrder();
  return wins.find((w) => w.title.toLowerCase().includes(q) && !w.isMinimized) ?? null;
}

// ─── Strip-wise changedFraction ─────────────────────────────────────────────
// Horizontal strips (rows partitioned top→bottom) for vertical-axis scroll.
// Vertical strips (columns partitioned left→right) for horizontal-axis scroll.
function stripChangedFractions(pre, post, axis, stripCount) {
  if (pre.width !== post.width || pre.height !== post.height || pre.channels !== post.channels) {
    return { fractions: new Array(stripCount).fill(1.0), sizeMismatch: true };
  }
  const { width, height, channels } = pre;
  const fractions = [];
  if (axis === "vertical") {
    // horizontal strips: pre.rawPixels and post.rawPixels are row-major.
    const bytesPerRow = width * channels;
    const stripHeight = Math.floor(height / stripCount);
    if (stripHeight <= 0) {
      return { fractions: [computeChangeFraction(pre.rawPixels, post.rawPixels, width, height, channels)], sizeMismatch: false };
    }
    for (let i = 0; i < stripCount; i++) {
      const rowStart = i * stripHeight;
      // Last strip absorbs any leftover rows (floor division remainder).
      const rowEnd = (i === stripCount - 1) ? height : (i + 1) * stripHeight;
      const sliceH = rowEnd - rowStart;
      const byteStart = rowStart * bytesPerRow;
      const byteEnd = rowEnd * bytesPerRow;
      const prePixels = pre.rawPixels.subarray(byteStart, byteEnd);
      const postPixels = post.rawPixels.subarray(byteStart, byteEnd);
      fractions.push(
        computeChangeFraction(prePixels, postPixels, width, sliceH, channels),
      );
    }
  } else {
    // Vertical strips: each strip is a column range. We have to extract
    // columns out of row-major data, which requires a copy. For PoC this
    // is acceptable; production would prefer per-strip SIMD inside Rust.
    const stripWidth = Math.floor(width / stripCount);
    if (stripWidth <= 0) {
      return { fractions: [computeChangeFraction(pre.rawPixels, post.rawPixels, width, height, channels)], sizeMismatch: false };
    }
    for (let i = 0; i < stripCount; i++) {
      const colStart = i * stripWidth;
      const colEnd = (i === stripCount - 1) ? width : (i + 1) * stripWidth;
      const sliceW = colEnd - colStart;
      const sliceBytes = sliceW * channels * height;
      const preStrip = Buffer.alloc(sliceBytes);
      const postStrip = Buffer.alloc(sliceBytes);
      for (let y = 0; y < height; y++) {
        const srcOff = (y * width + colStart) * channels;
        const dstOff = y * sliceW * channels;
        pre.rawPixels.copy(preStrip, dstOff, srcOff, srcOff + sliceW * channels);
        post.rawPixels.copy(postStrip, dstOff, srcOff, srcOff + sliceW * channels);
      }
      fractions.push(
        computeChangeFraction(preStrip, postStrip, sliceW, height, channels),
      );
    }
  }
  return { fractions, sizeMismatch: false };
}

// ─── Stop-detection polling ─────────────────────────────────────────────────
async function captureUntilStable(hwnd, region) {
  const start = performance.now();
  // minWaitMs: give the receiver time for the first DWM composition cycle
  // post-dispatch before we sample. Without this, we risk capturing 2
  // consecutive pre-paint cached frames and declaring stable on a state
  // that hasn't yet rendered (GPU staleness false-stable).
  await sleep(MIN_WAIT_MS);

  const frames = [];
  let prev = await captureWindowRawWithFallback(BigInt(hwnd), region).catch(() => null);
  if (prev === null) {
    return { frames: [], deltas: [], stableReached: false, framesToStability: null, totalElapsedMs: performance.now() - start };
  }
  frames.push(prev);
  const deltas = [];
  let consecutiveStable = 0;
  let framesToStability = null;
  let stableReached = false;

  while (performance.now() - start < BUDGET_MS) {
    await sleep(POLL_INTERVAL_MS);
    const now = await captureWindowRawWithFallback(BigInt(hwnd), region).catch(() => null);
    if (now === null) continue;
    const delta =
      now.width === prev.width && now.height === prev.height && now.channels === prev.channels
        ? computeChangeFraction(prev.rawPixels, now.rawPixels, now.width, now.height, now.channels)
        : 1.0;
    deltas.push(delta);
    frames.push(now);
    if (delta < STABLE_THRESHOLD) {
      consecutiveStable++;
      if (consecutiveStable >= CONSECUTIVE_STABLE) {
        stableReached = true;
        framesToStability = frames.length;
        break;
      }
    } else {
      consecutiveStable = 0;
    }
    prev = now;
  }
  return {
    frames,
    deltas,
    stableReached,
    framesToStability,
    totalElapsedMs: performance.now() - start,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Statistics ─────────────────────────────────────────────────────────────
function p(arr, q) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}
function fmt(n) { return n === null ? "n/a" : (Math.round(n * 1000) / 1000).toString(); }

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  console.log(`# ADR-019 Stage 2a PoC — causal strip filter + stop-detection`);
  console.log(`# target: ${JSON.stringify(args.targetTitle)}, cycles: ${args.cycles}, baseline: ${args.baseline ?? "real-scroll"}, direction: ${args.direction}`);
  console.log(`# config: poll=${POLL_INTERVAL_MS}ms, minWait=${MIN_WAIT_MS}ms, stable<${STABLE_THRESHOLD}, stripNoise>${STRIP_NOISE_THRESHOLD}, budget=${BUDGET_MS}ms, strips=${STRIP_COUNT}`);

  const win = findHwndByTitle(args.targetTitle);
  if (win === null) {
    console.error(`# ERROR: no window matches title ${JSON.stringify(args.targetTitle)}`);
    console.error(`# enumWindowsInZOrder visible titles:`);
    for (const w of enumWindowsInZOrder().slice(0, 20)) console.error(`#   - ${w.title}`);
    process.exit(1);
  }
  console.log(`# resolved hwnd: ${win.hwnd}, class: ${win.className}, region: ${win.region.width}x${win.region.height}`);

  // FOCUS: ensure the window is foreground so wheel posts hit-test correctly.
  // We don't use focus_window MCP tool here — just rely on enumWindowsInZOrder
  // returning the visible window. Excel cell scroll works via PostMessage
  // regardless of foreground when retargeted to EXCEL7 leaf (PR #307).
  const rect = getWindowRectByHwnd(BigInt(win.hwnd));
  if (rect === null) {
    console.error(`# ERROR: getWindowRectByHwnd returned null for hwnd ${win.hwnd}`);
    process.exit(1);
  }
  // Region: use the full client area as approximated by the window rect.
  const region = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };

  const axis = (args.direction === "down" || args.direction === "up") ? "vertical" : "horizontal";

  // Telemetry accumulators per cycle
  const rows = [];

  for (let cycle = 0; cycle < args.cycles; cycle++) {
    // Pre-frame BEFORE dispatch (T_pre per ADR-019 §2.1.1)
    const preFrame = await captureWindowRawWithFallback(BigInt(win.hwnd), region).catch(() => null);
    if (preFrame === null) {
      console.error(`# cycle ${cycle}: preFrame capture FAILED`);
      rows.push({ cycle, error: "pre-capture-failed" });
      continue;
    }

    // Dispatch
    let dispatchOutcome = null;
    if (args.baseline === "idle") {
      // No scroll dispatch; just capture and observe noise floor.
    } else if (args.baseline === "round-trip") {
      await postWheelToHwnd(BigInt(win.hwnd), { direction: args.direction, notch: SCROLL_NOTCH });
      const reverse = args.direction === "down" ? "up" : args.direction === "up" ? "down" : args.direction === "left" ? "right" : "left";
      dispatchOutcome = await postWheelToHwnd(BigInt(win.hwnd), { direction: reverse, notch: SCROLL_NOTCH });
    } else {
      dispatchOutcome = await postWheelToHwnd(BigInt(win.hwnd), { direction: args.direction, notch: SCROLL_NOTCH });
    }
    const dispatchOk = args.baseline === "idle" ? true : dispatchOutcome !== null;

    // Stop-detection polling
    const ring = await captureUntilStable(win.hwnd, region);
    const finalFrame = ring.frames[ring.frames.length - 1];
    if (!finalFrame) {
      console.error(`# cycle ${cycle}: no post frames captured`);
      rows.push({ cycle, error: "no-post-frames" });
      continue;
    }

    // Strip-wise diff between preFrame and final stable frame
    const stripResult = stripChangedFractions(preFrame, finalFrame, axis, STRIP_COUNT);
    const stripsAboveNoise = stripResult.fractions.filter((f) => f > STRIP_NOISE_THRESHOLD).length;
    const fullChangedFraction = computeChangeFraction(
      preFrame.rawPixels,
      finalFrame.rawPixels,
      preFrame.width,
      preFrame.height,
      preFrame.channels,
    );

    // H4 check: first post-frame should differ from preFrame (or be sufficiently close to it ONLY if no dispatch happened in idle mode)
    const firstPostDelta = ring.frames.length >= 2
      ? computeChangeFraction(preFrame.rawPixels, ring.frames[1].rawPixels, preFrame.width, preFrame.height, preFrame.channels)
      : null;

    rows.push({
      cycle,
      dispatchOk,
      dispatchChannel: dispatchOutcome ? dispatchOutcome.channel : null,
      stableReached: ring.stableReached,
      framesToStability: ring.framesToStability,
      totalElapsedMs: Math.round(ring.totalElapsedMs),
      stripFractions: stripResult.fractions.map((f) => Math.round(f * 1000) / 1000),
      stripsAboveNoise,
      fullChangedFraction: Math.round(fullChangedFraction * 1000) / 1000,
      firstPostDelta: firstPostDelta === null ? null : Math.round(firstPostDelta * 1000) / 1000,
      sizeMismatch: stripResult.sizeMismatch,
    });

    if (args.verbose) {
      console.log(`# cycle ${cycle}: ${JSON.stringify(rows[rows.length - 1])}`);
    }
    // Inter-cycle pause to let the window settle from any residual motion
    await sleep(200);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  const ok = rows.filter((r) => !r.error);
  const wallclocks = ok.map((r) => r.totalElapsedMs);
  const stableCount = ok.filter((r) => r.stableReached).length;
  const stripsAboveNoiseDist = ok.map((r) => r.stripsAboveNoise);
  const fullChangedFractions = ok.map((r) => r.fullChangedFraction);

  console.log(`\n=== Summary (n=${ok.length} successful cycles, ${rows.length - ok.length} errors) ===`);
  console.log(`stable reached: ${stableCount}/${ok.length} (${(100 * stableCount / Math.max(1, ok.length)).toFixed(1)}%)`);
  console.log(`wallclock ms: p50=${fmt(p(wallclocks, 0.5))} p90=${fmt(p(wallclocks, 0.9))} p99=${fmt(p(wallclocks, 0.99))} max=${fmt(Math.max(...wallclocks))}`);

  console.log(`stripsAboveNoise histogram:`);
  const histo = [0, 0, 0, 0, 0]; // indices 0..STRIP_COUNT
  for (const n of stripsAboveNoiseDist) histo[n]++;
  for (let i = 0; i <= STRIP_COUNT; i++) {
    const bar = "#".repeat(histo[i]);
    console.log(`  ${i}: ${histo[i].toString().padStart(3)} ${bar}`);
  }
  console.log(`stripsAboveNoise: p50=${fmt(p(stripsAboveNoiseDist, 0.5))} p90=${fmt(p(stripsAboveNoiseDist, 0.9))}`);
  console.log(`fullChangedFraction: p50=${fmt(p(fullChangedFractions, 0.5))} p90=${fmt(p(fullChangedFractions, 0.9))} p99=${fmt(p(fullChangedFractions, 0.99))}`);

  // H4 check (interpretation depends on baseline)
  const firstDeltas = ok.map((r) => r.firstPostDelta).filter((x) => x !== null);
  if (firstDeltas.length > 0) {
    const tinyFirst = firstDeltas.filter((d) => d < 0.001).length;
    const expected = args.baseline === "idle" ? "EXPECTED (idle = no motion)" : "BAD (real scroll should show motion)";
    console.log(`H4 first-post-delta < 0.001 count: ${tinyFirst}/${firstDeltas.length} — for ${args.baseline ?? "real-scroll"}: ${expected}`);
  }

  // Dispatch verification (real-scroll / round-trip only)
  if (args.baseline !== "idle") {
    const dispatchFailed = ok.filter((r) => !r.dispatchOk).length;
    const channels = {};
    for (const r of ok) {
      const c = r.dispatchChannel ?? "null";
      channels[c] = (channels[c] ?? 0) + 1;
    }
    console.log(`postWheelToHwnd: ${ok.length - dispatchFailed} ok, ${dispatchFailed} returned null; channels: ${JSON.stringify(channels)}`);
  }

  // Raw JSON dump (last line) so analysis scripts can re-parse
  console.log(`\nJSON_RESULTS=` + JSON.stringify({
    target: args.targetTitle,
    cycles: args.cycles,
    baseline: args.baseline,
    direction: args.direction,
    config: {
      pollIntervalMs: POLL_INTERVAL_MS,
      minWaitMs: MIN_WAIT_MS,
      stableThreshold: STABLE_THRESHOLD,
      stripNoiseThreshold: STRIP_NOISE_THRESHOLD,
      consecutiveStable: CONSECUTIVE_STABLE,
      budgetMs: BUDGET_MS,
      stripCount: STRIP_COUNT,
    },
    summary: {
      n: ok.length,
      errors: rows.length - ok.length,
      stableCount,
      wallclockP50: p(wallclocks, 0.5),
      wallclockP90: p(wallclocks, 0.9),
      wallclockP99: p(wallclocks, 0.99),
      stripsAboveNoiseHistogram: histo,
      stripsAboveNoiseP50: p(stripsAboveNoiseDist, 0.5),
      stripsAboveNoiseP90: p(stripsAboveNoiseDist, 0.9),
      fullChangedFractionP50: p(fullChangedFractions, 0.5),
      fullChangedFractionP90: p(fullChangedFractions, 0.9),
      fullChangedFractionP99: p(fullChangedFractions, 0.99),
    },
    rows,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
