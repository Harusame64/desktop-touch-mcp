#!/usr/bin/env node
// Static guard: every sync `#[napi]` export under src/ must be wrapped in
// `napi_safe_call(...)` (ADR-007 §3.4 / §10 Opus review). A panic in a sync
// napi entry-point unwinds onto the libuv main thread and crashes the Node
// process; `napi_safe_call` is the catch_unwind boundary.
//
// AsyncTask returns (`-> AsyncTask<...>`) are excluded because napi-rs runs
// `compute()` on a libuv worker pool that absorbs panics into a rejected
// Promise (see UIA bridge thread.rs for the equivalent pattern).
//
// Scope: all of src/ (expanded from src/win32/ in ADR-007 P5a commit 5).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath` decodes percent-encoded URL segments (paths with spaces or
// non-ASCII characters) and normalises Windows drive prefixes — both of
// which `new URL(...).pathname` mangles.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIR = join(ROOT, "src");

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

    // Find the next non-empty, non-attribute line — that is the start of the
    // fn signature. Blank lines between `#[napi]` and `pub fn` must be
    // skipped (Codex review on PR #74).
    let j = i + 1;
    while (j < lines.length && /^(\s*$|\s*(#\[|\/\/))/.test(lines[j])) j++;
    const sigLine = lines[j] ?? "";

    // Skip non-fn (e.g. `#[napi]` on an `impl` block).
    if (!/\bfn\s+\w+/.test(sigLine)) continue;

    // Collect the full function signature up to (and including) the opening
    // brace `{`. This handles multi-line signatures like:
    //   pub fn foo(
    //     arg: Bar,
    //   ) -> AsyncTask<...> {
    // and `-> Result<AsyncTask<...>>` patterns used in the duplication module.
    let sigEndLine = j;
    while (sigEndLine < lines.length && !lines[sigEndLine].includes("{")) sigEndLine++;
    const fullSig = lines.slice(j, sigEndLine + 1).join("\n");

    // Skip AsyncTask returns (including Result<AsyncTask<...>>).
    if (/AsyncTask</.test(fullSig)) continue;

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

console.log(`[check-napi-safe] OK — all sync #[napi] exports under src/ wrap with napi_safe_call.`);
