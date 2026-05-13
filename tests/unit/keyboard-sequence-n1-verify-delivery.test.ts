/**
 * keyboard-sequence-n1-verify-delivery.test.ts — Issue #278.
 *
 * Pins option (a) from the issue: `keyboard(action:'sequence')` emits a single
 * verifyDelivery contract (`status:'focus_only'`, `reason:'menu_state_not_observable'`)
 * for **all N including N=1**. The 1-step case is observationally similar to
 * `keyboard:press` (one combo) but is kept under the sequence contract so the
 * tool exposes one rule per tool rather than a step-count-conditional one.
 *
 * The handler invocation path is heavy (focus acquisition, withKeyboardLock,
 * native SendInput), so this is a **source-structural pin** — same precedent as
 * `tests/unit/issue-211-classify-branch-producer-pin.test.ts`. It guards two
 * things:
 *   1. The success-path verifyDelivery emit literal is unconditional
 *      `focus_only` / `menu_state_not_observable` / `sendinput` with no
 *      step-count gating in or above the emit block.
 *   2. The schema descriptor for `steps` documents the N=1 rule so the LLM
 *      cannot read it as an unrelated edge case.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KEYBOARD_FILE = join(process.cwd(), "src/tools/keyboard.ts");
const MATRIX_DOC_FILE = join(process.cwd(), "docs/operation-verification-matrix.md");

describe("Issue #278: keyboard(action:'sequence') verifyDelivery is focus_only for all N (incl. N=1)", () => {
  it("the sequence success-path emits an unconditional focus_only verifyDelivery", () => {
    const src = readFileSync(KEYBOARD_FILE, "utf8");

    // Locate the sequence handler start marker (kept in sync with
    // keyboard.ts:1782 comment header).
    const handlerStart = src.indexOf(
      "// keyboard(action='sequence') — atomic menu-navigation handler",
    );
    expect(handlerStart).toBeGreaterThan(0);

    // The verifyDelivery emit follows the loop and post-action focus check.
    // We pin (a) the literal emit shape, (b) absence of step-count gating
    // between the success sentinel and the emit.
    const tail = src.slice(handlerStart);

    // (a) Literal shape — these three fields together are the contract.
    expect(tail).toMatch(/status:\s*"focus_only"/);
    expect(tail).toMatch(/reason:\s*"menu_state_not_observable"/);
    expect(tail).toMatch(/channel:\s*"sendinput"/);

    // (b) No step-count conditional gating the emit. If a future refactor
    //     special-cases N=1 (e.g. `if (steps.length === 1)` followed by a
    //     different verifyDelivery shape), this pin trips. The window we
    //     scan is from the success sentinel (`failedIndex = -1`) to the
    //     emit itself.
    const sentinelIdx = tail.indexOf("failedIndex = -1");
    const emitIdx = tail.indexOf('status: "focus_only"');
    expect(sentinelIdx).toBeGreaterThan(0);
    expect(emitIdx).toBeGreaterThan(sentinelIdx);
    const between = tail.slice(sentinelIdx, emitIdx);
    expect(between).not.toMatch(/steps\.length\s*===\s*1/);
    expect(between).not.toMatch(/steps\.length\s*<\s*2/);
    expect(between).not.toMatch(/N\s*===\s*1/);
  });

  it("the sequence steps schema descriptor documents the N=1 contract rule", () => {
    const src = readFileSync(KEYBOARD_FILE, "utf8");
    // Schema descriptor for the `steps` array (around keyboard.ts:2209).
    // We pin the descriptor text mentions both N=1 and the focus_only path
    // so the LLM-facing docstring stays aligned with the matrix doc rule.
    expect(src).toMatch(/N=1[^"]*focus_only/);
  });

  it("matrix doc §3.1 sequence row pins the N=1 rule", () => {
    const src = readFileSync(MATRIX_DOC_FILE, "utf8");
    // The sequence row at docs/operation-verification-matrix.md:147
    // pins option (a): one rule for every N. We assert the doc contains
    // both the issue reference and the explicit N=1 phrasing so the SoT
    // does not silently regress.
    expect(src).toMatch(/keyboard.*action:.*sequence/);
    expect(src).toMatch(/N=1[^|]*focus_only/);
    expect(src).toMatch(/#278/);
  });
});
