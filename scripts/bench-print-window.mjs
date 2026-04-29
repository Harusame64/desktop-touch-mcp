#!/usr/bin/env node
// ADR-007 P2 baseline bench. Measures `win32PrintWindowToBuffer` on the
// largest available monitor (= dev machine's actual screen size — Opus
// review §11.9 settled the 4K question this way; we don't fake a 4K window
// because PrintWindow only renders real on-screen windows).
//
// The bench surfaces enough numbers to detect regressions in:
//   - the GDI capture pipeline (GetWindowRect → CreateCompatibleDC →
//     PrintWindow → GetDIBits)
//   - the BGRA→RGBA scalar swap (the largest CPU cost after PrintWindow)
//
// Usage: node scripts/bench-print-window.mjs

import {
  win32EnumMonitors,
  win32EnumTopLevelWindows,
  win32GetForegroundWindow,
  win32GetWindowRect,
  win32GetWindowText,
  win32IsWindowVisible,
  win32PrintWindowToBuffer,
} from "../index.js";

const ITERATIONS = 100;

// Pick the foreground window if it's reasonably sized; otherwise scan for
// the largest visible window with a title — that gives us a stable target
// with non-trivial pixel count, mirroring the OCR / screenshot use case.
function pickTargetHwnd() {
  const fg = win32GetForegroundWindow();
  if (fg !== null) {
    const r = win32GetWindowRect(fg);
    if (r && r.right - r.left >= 800 && r.bottom - r.top >= 600) return fg;
  }
  const hwnds = win32EnumTopLevelWindows();
  let best = null;
  let bestArea = 0;
  for (const h of hwnds) {
    if (!win32IsWindowVisible(h)) continue;
    if (!win32GetWindowText(h)) continue;
    const r = win32GetWindowRect(h);
    if (!r) continue;
    const area = (r.right - r.left) * (r.bottom - r.top);
    if (area > bestArea) {
      best = h;
      bestArea = area;
    }
  }
  return best;
}

const target = pickTargetHwnd();
if (target === null) {
  console.error("[bench-print-window] no suitable target window found");
  process.exit(1);
}

const rect = win32GetWindowRect(target);
const title = win32GetWindowText(target).slice(0, 40);
const w = rect.right - rect.left;
const h = rect.bottom - rect.top;

// Warm-up: 5 captures to amortize first-DC creation, JIT, V8 buffer alloc.
for (let i = 0; i < 5; i++) win32PrintWindowToBuffer(target, 2);

const samples = new Float64Array(ITERATIONS);
const rssBefore = process.memoryUsage().rss;
for (let i = 0; i < ITERATIONS; i++) {
  const start = process.hrtime.bigint();
  const r = win32PrintWindowToBuffer(target, 2);
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  samples[i] = elapsed;
  // touch the buffer length so V8 can't dead-code-eliminate the call
  if (r.data.length === 0) throw new Error("empty buffer");
}
const rssAfter = process.memoryUsage().rss;

samples.sort();
const p50 = samples[Math.floor(ITERATIONS * 0.5)];
const p95 = samples[Math.floor(ITERATIONS * 0.95)];
const p99 = samples[Math.floor(ITERATIONS * 0.99)];
const min = samples[0];
const max = samples[ITERATIONS - 1];
const mean = samples.reduce((a, b) => a + b, 0) / ITERATIONS;

const monitors = win32EnumMonitors();
const largestMon = monitors.reduce((a, b) => {
  const aArea = (a.boundsRight - a.boundsLeft) * (a.boundsBottom - a.boundsTop);
  const bArea = (b.boundsRight - b.boundsLeft) * (b.boundsBottom - b.boundsTop);
  return aArea >= bArea ? a : b;
});
const monW = largestMon.boundsRight - largestMon.boundsLeft;
const monH = largestMon.boundsBottom - largestMon.boundsTop;

console.log("\nADR-007 P2 baseline: win32PrintWindowToBuffer (100 iterations)\n");
const rows = [
  ["Largest monitor", `${monW}x${monH} @ ${largestMon.dpi} DPI`],
  ["Window target", `${title}…`],
  ["Window size (px)", `${w} x ${h}`],
  ["Pixels per call", String(w * h)],
  ["min (ms)", min.toFixed(3)],
  ["p50 (ms)", p50.toFixed(3)],
  ["p95 (ms)", p95.toFixed(3)],
  ["p99 (ms)", p99.toFixed(3)],
  ["max (ms)", max.toFixed(3)],
  ["mean (ms)", mean.toFixed(3)],
  ["RSS delta (MB)", ((rssAfter - rssBefore) / (1024 * 1024)).toFixed(2)],
];
const width = Math.max(...rows.map(([k]) => k.length));
for (const [k, v] of rows) console.log("  " + k.padEnd(width + 2) + v);
console.log("");
