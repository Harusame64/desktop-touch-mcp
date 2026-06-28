#!/usr/bin/env node
// ADR-027 Phase 4 — WGC vs PrintWindow capture-latency bench harness.
//
// Measures the per-capture latency of the two window-capture backends that the
// ADR-027 ladder uses, head-to-head on the SAME live window:
//   - WGC          (win32WgcCaptureWindow, worker thread + reused D3D device)
//   - PrintWindow  (win32_print_window_to_buffer, flag 2 = PW_RENDERFULLCONTENT)
//
// Two ADR-027 acceptance points this baselines:
//   - AC2  : WGC runs on a worker thread with a REUSED device — so the first
//            capture pays the one-time D3D device build and later captures are
//            much faster. The harness reports cold (1st) vs warm (median of the
//            rest) to make the reuse effect visible.
//   - R2   : WGC must not become a blanket primary on the hot path — this prints
//            the WGC/PrintWindow ratio so the "WGC only for background / black
//            rescue" placement decision (D3) stays evidence-based.
//
// This bench is NON-HERMETIC: it needs a live, visible, DWM-composited window
// (the WGC D3 gate rejects minimized / hidden / cloaked windows). It is a local
// dogfood tool only and is NOT run in CI (no live desktop on the 2-core runner).
//
// Usage:
//   npm run build && node benches/wgc_latency.mjs            # auto-pick a window
//   node benches/wgc_latency.mjs <hwnd>                      # target a specific HWND
//   node benches/wgc_latency.mjs <hwnd> <iterations>         # default 20 iterations
//
// Output: a text report with cold/warm/mean/median (ms) for each backend, the
// device-reuse speedup, and the WGC-vs-PrintWindow ratio.

import {
  enumWindowsInZOrder,
  canCaptureWindowViaWgc,
  captureWindowWgc,
  printWindowToBuffer,
} from "../dist/engine/win32.js";

const argHwnd = process.argv[2] ? BigInt(process.argv[2]) : null;
const ITER = Math.max(3, Number(process.argv[3] ?? 20) || 20);

function pickWindow() {
  if (argHwnd !== null) return { hwnd: argHwnd, title: "(explicit hwnd)" };
  const wins = enumWindowsInZOrder();
  // Prefer a GPU-composited window (Chromium/Edge/Electron, Windows Terminal,
  // WinUI) that passes the WGC D3 gate.
  const candidate = wins.find((w) => {
    if (w.isMinimized || w.isCloaked) return false;
    const c = (w.className || "").toLowerCase();
    const isGpu =
      c.includes("chrome_widgetwin") || c.includes("cascadia") ||
      c.includes("applicationframewindow") || c.includes("qt");
    return isGpu && canCaptureWindowViaWgc(w.hwnd);
  }) ?? wins.find((w) => !w.isMinimized && !w.isCloaked && canCaptureWindowViaWgc(w.hwnd));
  return candidate ? { hwnd: candidate.hwnd, title: candidate.title } : null;
}

function ms(ns) { return Number(ns) / 1e6; }
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function timeWgc(hwnd, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    const r = await captureWindowWgc(hwnd);
    samples.push(ms(process.hrtime.bigint() - t0));
    if (i === 0 && (!r.data || r.width <= 0)) throw new Error("WGC returned no frame");
  }
  return samples;
}

function timePrintWindow(hwnd, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    printWindowToBuffer(hwnd, 2); // PW_RENDERFULLCONTENT
    samples.push(ms(process.hrtime.bigint() - t0));
  }
  return samples;
}

const target = pickWindow();
if (!target) {
  console.error("No WGC-eligible window found. Open a visible browser / terminal, or pass an HWND.");
  process.exit(1);
}
console.log(`\nADR-027 WGC latency bench — target: "${String(target.title).slice(0, 60)}" (hwnd=${target.hwnd}), ${ITER} iterations\n`);

const wgc = await timeWgc(target.hwnd, ITER);
const pw = timePrintWindow(target.hwnd, ITER);

const wgcWarm = stats(wgc.slice(1)); // exclude the cold device-build capture
const wgcAll = stats(wgc);
const pwStats = stats(pw);

const fmt = (s) => `mean=${s.mean.toFixed(1)}ms median=${s.median.toFixed(1)}ms min=${s.min.toFixed(1)} max=${s.max.toFixed(1)}`;
console.log(`WGC  cold (1st)     : ${wgc[0].toFixed(1)}ms  (one-time D3D device build)`);
console.log(`WGC  warm (rest)    : ${fmt(wgcWarm)}   <- device reused (AC2)`);
console.log(`WGC  all            : ${fmt(wgcAll)}`);
console.log(`PrintWindow (flag 2): ${fmt(pwStats)}`);
console.log(`\nDevice-reuse speedup: cold/warm = ${(wgc[0] / wgcWarm.median).toFixed(2)}x faster after the first capture`);
console.log(`WGC warm / PrintWindow ratio (median): ${(wgcWarm.median / pwStats.median).toFixed(2)}x  (R2: keep WGC off the hot-path primary unless > PrintWindow value)`);
console.log("");
process.exit(0);
