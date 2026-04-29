#!/usr/bin/env node
// Static guard: every sync `#[napi]` export under src/win32/ must be wrapped
// in `napi_safe_call(...)` (ADR-007 §3.4 / §10 Opus review). A panic in a
// sync napi entry-point unwinds onto the libuv main thread and crashes the
// Node process; `napi_safe_call` is the catch_unwind boundary.
//
// AsyncTask returns (`-> AsyncTask<...>`) are excluded because napi-rs runs
// `compute()` on a libuv worker pool that absorbs panics into a rejected
// Promise (see UIA bridge thread.rs for the equivalent pattern).
//
// Scope today: src/win32/ (the 10 ADR-007 P1 functions). The remaining
// `compute_change_fraction` / `dhash_from_raw` / `hamming_distance` sync
// exports in src/lib.rs migrate in P5a alongside `#[napi_safe]` proc_macro
// adoption (ADR-007 §6.1, Opus review §4 scope creep list).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]):/, "$1:");
const SCAN_DIR = join(ROOT, "src", "win32");

/** Recursively collect *.rs files under `dir`. */
function rsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...rsFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

const violations = [];

for (const file of rsFiles(SCAN_DIR)) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*#\[napi\]\s*$/.test(line)) continue;

    // Find the next non-empty, non-attribute line — that is the fn signature.
    // Blank lines between `#[napi]` and `pub fn` must be skipped too;
    // otherwise sigLine becomes `""`, the `\bfn\s+\w+` test below fails, and
    // the function silently slips past the guard (Codex review on PR #74).
    let j = i + 1;
    while (j < lines.length && /^(\s*$|\s*(#\[|\/\/))/.test(lines[j])) j++;
    const sigLine = lines[j] ?? "";

    // Skip AsyncTask returns — those have implicit panic safety via napi-rs.
    if (/->\s*AsyncTask</.test(sigLine)) continue;
    // Skip non-fn (e.g. `#[napi(object)]` is a different attribute and would
    // not match the regex above, but be defensive).
    if (!/\bfn\s+\w+/.test(sigLine)) continue;

    // Read forward up to ~80 lines or until we hit the closing `}` to look
    // for `napi_safe_call(`. If absent, flag the function.
    const fnName = sigLine.match(/\bfn\s+(\w+)/)?.[1] ?? "<unknown>";
    let body = "";
    for (let k = j; k < Math.min(lines.length, j + 80); k++) {
      body += lines[k] + "\n";
      // Heuristic: a line that is just `}` at the function's indent ends body.
      if (/^\}\s*$/.test(lines[k])) break;
    }
    if (!/napi_safe_call\s*\(/.test(body)) {
      violations.push({
        file: relative(ROOT, file),
        line: j + 1,
        fn: fnName,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("\n[check-napi-safe] FAIL — sync `#[napi]` exports missing `napi_safe_call`:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  fn ${v.fn}`);
  }
  console.error("\nWrap each function body with `napi_safe_call(\"<fn_name>\", || { ... })`.");
  console.error("See src/win32/safety.rs and ADR-007 §3.4.\n");
  process.exit(1);
}

console.log(`[check-napi-safe] OK — all sync #[napi] exports under src/win32/ wrap with napi_safe_call.`);
