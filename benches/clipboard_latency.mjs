#!/usr/bin/env node
// ADR-033 P1-5 — clipboard write+verify / read latency: the native addon path
// against the PowerShell path it replaces.
//
//   node benches/clipboard_latency.mjs latency [iterations]   # default 20
//   node benches/clipboard_latency.mjs sizes   [iterations]   # default 10
//
// Requires a compiled addon (`npm run build:rs`); it calls the exports directly
// rather than going through `src/tools/clipboard.ts`, so the numbers are the two
// implementations' own costs with no dispatch or envelope overhead in between.
//
// SIDE EFFECTS, both of which matter:
//   1. It REPLACES the machine's clipboard, repeatedly. The text on the
//      clipboard at start is read back and restored at the end — best effort: a
//      non-text payload (image, file selection) cannot be put back.
//   2. The PowerShell leg spawns the exact command line Microsoft Defender
//      scored as `Trojan:Win32/Commando.A!ml`. On a machine with real-time
//      protection enabled it may be blocked, or may kill this process. Results
//      are printed per row as they complete so a kill does not lose the rows
//      already measured, and the two modes are separate invocations for the
//      same reason.
//
// The `latency` output table is the same shape as the ADR-033 spike's, so the
// two are directly comparable.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32ClipboardReadText, win32ClipboardWriteTextVerified } from "../index.js";

const execFileAsync = promisify(execFile);

// ── The two implementations ─────────────────────────────────────────────────

/** Native: one addon call, no process spawn. */
function nativeWriteVerify(text) {
  const r = win32ClipboardWriteTextVerified(Buffer.from(text, "utf16le"));
  return { ok: r.ok, reason: r.reason };
}

function nativeRead() {
  const r = win32ClipboardReadText();
  return r.hasText ? Buffer.from(r.bytes).toString("utf16le") : "";
}

/** PowerShell: the fallback in `src/tools/clipboard.ts`, verbatim. */
async function powershellWriteVerify(text) {
  const b64 = Buffer.from(text, "utf16le").toString("base64");
  const script =
    `$b=[System.Convert]::FromBase64String('${b64}');` +
    `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
    `Set-Clipboard -Value $t;` +
    `$r=Get-Clipboard -Raw;` +
    `if($r -eq $null){Write-Output ''}else{` +
    `[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($r))` +
    `}`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
  );
  const expected = Buffer.from(text, "utf16le");
  const out = stdout.trim();
  const actual = out ? Buffer.from(out, "base64") : Buffer.alloc(0);
  const ok = expected.equals(actual);
  return { ok, reason: ok ? undefined : "readback_mismatch" };
}

async function powershellRead() {
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
    "$t=Get-Clipboard -Raw;" +
    "if($t -eq $null){Write-Output ''}else{" +
    "[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($t))" +
    "}";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
  );
  const b64 = stdout.trim();
  return b64 ? Buffer.from(b64, "base64").toString("utf16le") : "";
}

// ── Stats ───────────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  // Nearest-rank: the smallest sample at or above the p-th percentile.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summarise(label, samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    label,
    n: s.length,
    min: +s[0].toFixed(3),
    p50: +percentile(s, 50).toFixed(3),
    p95: +percentile(s, 95).toFixed(3),
    max: +s[s.length - 1].toFixed(3),
  };
}

/** One warm-up call outside the sample set: the first PowerShell spawn pays
 *  JIT / page-cache costs no steady-state caller sees, and counting it would
 *  flatter the native path rather than measure it. */
async function measure(label, iterations, call) {
  const samples = [];
  let failures = 0;
  await call(0);
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    const r = await call(i + 1);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
    if (r && r.ok === false) failures++;
  }
  const row = summarise(label, samples);
  if (failures > 0) row.verifyFailures = failures;
  console.log(JSON.stringify(row));
  return row;
}

function printTable(rows) {
  console.log("\n| path | n | min ms | p50 ms | p95 ms | max ms |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.label} | ${r.n} | ${r.min} | ${r.p50} | ${r.p95} | ${r.max} |`);
  }
}

// ── Modes ───────────────────────────────────────────────────────────────────

const PAYLOAD = "adr-033 latency payload — 日本語 / 😀 / line1\r\nline2";

async function latency(iterations) {
  const saved = nativeRead();
  const rows = [];
  rows.push(await measure("native write+verify", iterations, (i) => nativeWriteVerify(`${PAYLOAD} #${i}`)));
  rows.push(await measure("powershell write+verify", iterations, (i) => powershellWriteVerify(`${PAYLOAD} #${i}`)));
  rows.push(await measure("native read", iterations, () => nativeRead()));
  rows.push(await measure("powershell read", iterations, () => powershellRead()));
  printTable(rows);
  if (saved) nativeWriteVerify(saved);
}

/** Payload-size sweep, native only: the PowerShell path cannot reach the upper
 *  sizes at all (its base64 command line stops at ~12 150 characters — the
 *  pre-existing bug ADR-033 removes), so a comparison table would be empty on
 *  two of three rows. */
async function sizes(iterations) {
  const saved = nativeRead();
  const rows = [];
  for (const chars of [11, 12_000, 100_000]) {
    const text = "x".repeat(chars);
    rows.push(await measure(`native write+verify — ${chars} chars`, iterations, () => nativeWriteVerify(text)));
  }
  printTable(rows);
  if (saved) nativeWriteVerify(saved);
}

const mode = process.argv[2] ?? "latency";
if (mode === "latency") await latency(Number(process.argv[3] ?? 20));
else if (mode === "sizes") await sizes(Number(process.argv[3] ?? 10));
else {
  console.error(`unknown mode: ${mode} (expected "latency" or "sizes")`);
  process.exit(1);
}
