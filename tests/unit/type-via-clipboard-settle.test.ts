/**
 * type-via-clipboard-settle.test.ts — ADR-033 PR-2 (I-32).
 *
 * The delay between the paste keystroke and putting the user's clipboard back
 * exists for one reason: the target application has to finish READING the
 * clipboard before it is taken away. Cut it too short and the symptom is a
 * paste that intermittently delivers the user's PREVIOUS clipboard content, on
 * slower targets, on someone else's machine — about as hard to trace as a bug
 * gets.
 *
 * There are two obvious ways to lose it, and this file blocks both:
 *
 *   1. The two backends drift. `type_via_clipboard.rs` sleeps its own constant
 *      and the PowerShell fallback in `keyboard.ts` sleeps another; nothing in
 *      the type system connects them, so they are compared here as source text.
 *   2. Someone factors the paste chord together with `foreground_flash`'s and
 *      inherits ITS 30ms settle. That number answers a different question —
 *      when is it safe to send the NEXT keystroke to Windows Terminal — and it
 *      is only a third of this one. So the difference is asserted, not just the
 *      value: a "unification" that made both 30 would satisfy an equality check
 *      alone.
 *
 * Measured (ADR-033 P2-0 Q5): pasting into a local EDIT control reflects in p50
 * 4.4ms, 30/30 under 30ms. That is deliberately NOT taken as licence to lower
 * this — an EDIT handles WM_PASTE synchronously and in-process, which is the
 * best case, while the population the delay exists for (another process, an app
 * that reads the clipboard over async IPC, a session over RDP) is exactly the
 * one that measurement cannot reach.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The single number a `const NAME = <digits>` declaration binds. */
function constant(source: string, pattern: RegExp, label: string): number {
  const m = source.match(pattern);
  expect(m, `${label} not found — the declaration moved or was renamed`).not.toBeNull();
  return Number(m![1]);
}

describe("ADR-033 I-32 — the paste settle", () => {
  const rust = read("src/win32/type_via_clipboard.rs");
  const ts = read("src/tools/keyboard.ts");
  const flash = read("src/win32/foreground_flash.rs");

  const native = constant(rust, /const PASTE_SETTLE_MS: u64 = (\d+);/, "PASTE_SETTLE_MS (Rust)");
  const fallback = constant(ts, /const PASTE_SETTLE_MS = (\d+);/, "PASTE_SETTLE_MS (TypeScript)");
  const flashDelay = constant(
    flash,
    /const PASTE_REFLECT_DELAY_MS: u64 = (\d+);/,
    "PASTE_REFLECT_DELAY_MS (foreground_flash)",
  );

  it("is 120ms in the addon", () => {
    expect(native).toBe(120);
  });

  it("is the same 120ms in the PowerShell fallback", () => {
    // Whichever backend serves the call, the target gets the same amount of
    // time to read the clipboard.
    expect(fallback).toBe(native);
  });

  it("is NOT foreground_flash's 30ms", () => {
    expect(flashDelay).toBe(30);
    expect(native).not.toBe(flashDelay);
    expect(native).toBeGreaterThan(flashDelay);
  });

  it("is the value the addon reports to its caller", () => {
    // `settleMs` is echoed in the result so a caller can see which delay was
    // applied without reading this file. A hard-coded echo would make the field
    // a decoration rather than a report.
    expect(rust).toMatch(/settle_ms: PASTE_SETTLE_MS as u32/);
  });
});
