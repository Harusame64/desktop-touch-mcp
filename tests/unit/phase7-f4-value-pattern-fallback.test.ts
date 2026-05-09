/**
 * phase7-f4-value-pattern-fallback.test.ts — Phase 7 F4 unit tests.
 *
 * Pins the Phase 6 dogfood F4 fix: when `getTextViaTextPattern` is
 * unavailable on the focused element (Win11 New Notepad RichEditD2DPT
 * implements ValuePattern but not TextPattern), the keyboard:type BG
 * verifyDelivery path now falls back to `getTextViaValuePattern` for
 * delta-based delivery verification (instead of returning
 * `unverifiable / read_back_unsupported`).
 *
 * The integration glue lives inline in `src/tools/keyboard.ts` BG type
 * path (post-injection branch). Pure unit testing of the full handler
 * is heavy (mocks for spawn, win32, bg-input, perception) — these tests
 * cover the **decision logic** that the integration glue implements.
 *
 * matrix doc §3.1 line 140 (BG path delivery verification) + §4.2
 * (verifyDelivery hint shape), `docs/llm-audit/phase6-dogfood-findings.md` §F4.
 */

import { describe, it, expect } from "vitest";

/**
 * Pure helper mirroring the inline ValuePattern fallback logic in
 * keyboard.ts BG type path. Extracted as a pure function so the
 * branching can be unit tested independently of the heavy handler
 * surroundings (spawn / win32 / bg-input / perception mocks).
 *
 * Returns:
 *  - true       — delivered (postValue includes checkText AND length grew
 *                 OR baseline did not previously contain checkText)
 *  - false      — not delivered (postValue does NOT include checkText)
 *  - "unverifiable" — both sides contain checkText with no length change
 *                 (corner case: user re-typed same content; treat as undetermined)
 */
function classifyValuePatternDelivery(
  valueBaseline: string,
  postValue: string,
  checkText: string,
): true | false | "unverifiable" {
  const containsText = postValue.includes(checkText);
  const delta = postValue.length - valueBaseline.length;
  if (containsText) {
    if (delta > 0 || !valueBaseline.includes(checkText)) {
      return true;
    }
    return "unverifiable";
  }
  return false;
}

describe("Phase 7 F4: ValuePattern fallback delivery classification", () => {
  it("empty baseline + checkText appended → delivered (Win11 Notepad common case)", () => {
    // Win11 New Notepad scenario: TextPattern returns null, ValuePattern works.
    // baseline = "" (empty buffer), post = "hello world" (typed text).
    expect(classifyValuePatternDelivery("", "hello world", "hello world")).toBe(true);
  });

  it("non-empty baseline + checkText appended → delivered (length grew)", () => {
    expect(classifyValuePatternDelivery("existing\n", "existing\nhello world", "hello world")).toBe(true);
  });

  it("replaceAll case (baseline replaced by checkText) → delivered (baseline did not contain text)", () => {
    // Ctrl+A then type "hello world" replaces previous content. delta < 0
    // (length shrunk), but baseline did not contain "hello world".
    expect(classifyValuePatternDelivery("existing", "hello world", "hello world")).toBe(true);
  });

  it("postValue does not contain checkText → not delivered (BackgroundInputNotDelivered)", () => {
    // Buffer unchanged or unrelated content remained — surface
    // BackgroundInputNotDelivered to caller.
    expect(classifyValuePatternDelivery("existing", "existing", "hello world")).toBe(false);
  });

  it("postValue partially contains checkText (delivery dropped chars) → not delivered", () => {
    // Caller sent "hello world", post-state shows "hell" — clearly partial.
    expect(classifyValuePatternDelivery("", "hell", "hello world")).toBe(false);
  });

  it("baseline already contains checkText AND length unchanged → unverifiable (corner case)", () => {
    // User re-typed exactly what was already there. Cannot disambiguate
    // delivery from no-op without an edit-event observer.
    expect(classifyValuePatternDelivery("hello world", "hello world", "hello world")).toBe("unverifiable");
  });

  it("baseline already contains checkText AND length grew → delivered (re-type, content appended)", () => {
    // Defensive: even if baseline contained checkText, growth means new
    // content was actually appended somewhere.
    expect(classifyValuePatternDelivery("hello world", "hello worldhello world", "hello world")).toBe(true);
  });

  it("checkText with embedded substring of baseline (no growth) → unverifiable", () => {
    // baseline = "hello", post = "hello", checkText = "hello" — same value.
    // Cannot tell if the user pressed Backspace then re-typed "hello" or
    // just kept the original. Mark unverifiable rather than false-positive.
    expect(classifyValuePatternDelivery("hello", "hello", "hello")).toBe("unverifiable");
  });

  it("multi-line growth with checkText included → delivered", () => {
    expect(classifyValuePatternDelivery("line1\n", "line1\nhello world\nmore", "hello world")).toBe(true);
  });
});

describe("Phase 7 F4: getTextViaValuePattern shape", () => {
  it("uia-bridge exports getTextViaValuePattern", async () => {
    const mod = await import("../../src/engine/uia-bridge.js");
    expect(typeof mod.getTextViaValuePattern).toBe("function");
  });
});
