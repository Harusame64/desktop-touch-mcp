/**
 * foreground-flash-keypress-classify.test.ts — Issue #279 (A5).
 *
 * Pins the `ForegroundFlashNotApplicableToKeyPress` typed code added to
 * `_errors.ts::classify()` + `SUGGESTS`. Before this fix, the e2e test
 * (`tests/e2e/foreground-flash-verification.test.ts:215-228`) only passed
 * because `keyboard.ts:1490` `failWith` injected an inline `suggest[]`; the
 * classify() lookup itself fell into the generic "Unknown" tail and any
 * future producer relying on classify() alone would surface an empty
 * suggest array to the LLM.
 *
 * Follows the precedent of `phase7-f3-spawn-failed-typed-code.test.ts` for
 * dedicated single-typed-code routing pins.
 */

import { describe, it, expect } from "vitest";
import { failWith, getSuggestsForCode } from "../../src/tools/_errors.js";

describe("Issue #279: ForegroundFlashNotApplicableToKeyPress typed code", () => {
  it("classify routes the bare PascalCase message to its typed code", () => {
    // Matches the production producer at keyboard.ts:1490 which throws
    // `new Error("ForegroundFlashNotApplicableToKeyPress")`. No inline
    // suggest passed → classify() must populate it.
    const result = failWith(
      new Error("ForegroundFlashNotApplicableToKeyPress"),
      "keyboard:press",
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("ForegroundFlashNotApplicableToKeyPress");
    expect(Array.isArray(body.suggest)).toBe(true);
    expect(body.suggest.length).toBeGreaterThan(0);
  });

  it("classify routes a prose-suffixed message to the same typed code", () => {
    // Defensive variant: even if a future producer appends prose to the
    // error message, the substring match in classify() should still route.
    const result = failWith(
      new Error("ForegroundFlashNotApplicableToKeyPress: clipboard paste cannot deliver a key combo"),
      "keyboard:press",
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("ForegroundFlashNotApplicableToKeyPress");
  });

  it("SUGGESTS dictionary exposes ForegroundFlashNotApplicableToKeyPress via getSuggestsForCode()", () => {
    const suggests = getSuggestsForCode("ForegroundFlashNotApplicableToKeyPress");
    expect(suggests.length).toBeGreaterThan(0);
    // Recovery hints must name a concrete recoverable call so the LLM can
    // act without re-deriving the recipe. e2e test asserts the same shape
    // via inline suggest; this guards the classify() fallback path.
    const joined = suggests.join(" ");
    expect(joined).toMatch(/keyboard:type|terminal:send/);
    expect(joined).toMatch(/keyboard\(.*action:.*press.*method:.*foreground/);
  });

  it("Sequence variant is unaffected (no substring poaching between the pair)", () => {
    // The two ForegroundFlashNotApplicableTo* codes share a long prefix but
    // mutually-exclusive suffixes. Pin that adding the KeyPress arm did not
    // regress the existing Sequence arm.
    const result = failWith(
      new Error("ForegroundFlashNotApplicableToSequence"),
      "keyboard:sequence",
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("ForegroundFlashNotApplicableToSequence");
  });
});
