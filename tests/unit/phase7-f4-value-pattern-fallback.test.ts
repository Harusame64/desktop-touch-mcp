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
 * **F4-bis (PR #234 follow-up)**: extends the fallback to fire even when
 * the TextPattern path returned non-null junk text from unrelated
 * descendants (Notepad menu / title bar). The verifiable branch now
 * runs a 2nd-defense ValuePattern delta comparison whenever TextPattern
 * slicing yields `unverifiable`, and `valueBaseline` is always retained
 * regardless of whether `baselineMarker` was built. The dual-stage flow
 * helper `classifyDeliveryWithFallback` below pins the new gate logic.
 *
 * The integration glue lives inline in `src/tools/keyboard.ts` BG type
 * path (post-injection branch). Pure unit testing of the full handler
 * is heavy (mocks for spawn, win32, bg-input, perception) — these tests
 * cover the **decision logic** that the integration glue implements.
 *
 * **Semantic-equivalent invariant (Phase 7 F4 P3-1 Round 1 / P3-2 Round 2
 * review + F4-bis 2nd-defense layer)**: the `classifyValuePatternDelivery`
 * helper below MUST stay semantically equivalent to **two** sites in
 * keyboard.ts that share the same VP delta logic:
 *   1. The verifiable=false branch's outer if/else (post-fix line numbers
 *      shift; locate via `else if (verificationNeeded)` containing
 *      `getTextViaValuePattern`).
 *   2. The verifiable=true branch's 2nd-defense block (F4-bis), reached
 *      after TP slicing yields `unverifiable`. Locate via
 *      `verifiedDelivery === "unverifiable" && valueBaseline !== null`.
 * The mapping for each site is:
 *   keyboard.ts side                     → test helper return
 *   ─────────────────────────────────── → ──────────────────
 *   `verifiedDelivery = true`            → `true`
 *   `verifyReason = "read_back_unsupported"` (verifiedDelivery stays at
 *     function-default `"unverifiable"`)  → `"unverifiable"`
 *   `verifiedDelivery = false`           → `false`
 * Strictly speaking the source side mutates two variables while the test
 * helper returns a single discriminated value, so the wording "bit-equal"
 * is not literally true. Behavior at the caller boundary is identical
 * (the wrapping handler observes the same `verifiedDelivery` /
 * `verifyDelivery.reason` pair).
 * This file is a copy-test by design (avoids exporting the helper from
 * keyboard.ts and growing the public API surface for a P3-tier
 * verification path). If either keyboard.ts site is touched, mirror the
 * change in BOTH sites + here in the same PR.
 *
 * matrix doc §3.1 line 140 (BG path delivery verification) + §4.2
 * (verifyDelivery hint shape), `docs/llm-audit/phase6-dogfood-findings.md`
 * §F4 / §F4-bis.
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

/**
 * F4-bis dual-stage flow helper. Mirrors the post-fix gate logic in
 * `src/tools/keyboard.ts` BG type path's `if (verifiable)` branch:
 *   1. If TextPattern slicing decided (true / false), use that authoritatively
 *      (WT/conhost path: TP is the canonical channel, do not consult VP).
 *   2. If TP slicing was inconclusive ("unverifiable"), fall back to
 *      ValuePattern delta classification — but only when valueBaseline
 *      and postValue are both available.
 *   3. If VP also unavailable / inconclusive, settle on "unverifiable".
 *
 * Inputs model the post-injection observation pair:
 *   - `tpDecision`: outcome of `applyKeyboardSinceMarker` slicing on the
 *     post-injection TextPattern read. `true` = exact/tail match,
 *     `false` = checkText not detected (theoretically possible but the
 *     current keyboard.ts source path leaves verifiedDelivery at
 *     "unverifiable" rather than emitting false here — included for
 *     forward compatibility), `"unverifiable"` = sliced.matched=false OR
 *     postRaw=null.
 *   - `valueBaseline`: parallel-fetched ValuePattern.Value before
 *     injection (always-retained per F4-bis fix). null if VP unavailable.
 *   - `postValue`: post-injection ValuePattern.Value read. null if VP
 *     unavailable at post-read time (focus race / VP unsupported).
 *   - `checkText`: the typed substring to verify.
 */
function classifyDeliveryWithFallback(
  tpDecision: true | false | "unverifiable",
  valueBaseline: string | null,
  postValue: string | null,
  checkText: string,
): true | false | "unverifiable" {
  if (tpDecision === true || tpDecision === false) return tpDecision;
  if (valueBaseline === null || postValue === null) return "unverifiable";
  return classifyValuePatternDelivery(valueBaseline, postValue, checkText);
}

describe("Phase 7 F4-bis: dual-stage TP→VP fallback gate", () => {
  it("Notepad re-bug: TP unverifiable + VP delta>0 → delivered (primary fix target)", () => {
    // Win11 New Notepad: descendant TP returns junk → slicing fails →
    // unverifiable. ValuePattern reads focused Edit control directly →
    // post grew → delivered.
    expect(
      classifyDeliveryWithFallback("unverifiable", "", "hello world", "hello world"),
    ).toBe(true);
  });

  it("WT regression guard: TP slicing matched=true → delivered (VP not consulted)", () => {
    // Windows Terminal: TP on Custom-typed pane works, slicing matched.
    // VP would return whatever XAML host exposes (possibly empty / unrelated)
    // but is irrelevant — TP authoritative.
    expect(
      classifyDeliveryWithFallback(true, "irrelevant baseline", "irrelevant", "echo dogfood"),
    ).toBe(true);
  });

  it("conhost regression guard: TP true short-circuits VP fallback", () => {
    expect(
      classifyDeliveryWithFallback(true, null, null, "dir"),
    ).toBe(true);
  });

  it("re-type safety: TP unverifiable + VP delta=0 + baseline.includes → unverifiable", () => {
    // User re-typed identical content — both paths inconclusive, false-
    // positive guard preserves "unverifiable".
    expect(
      classifyDeliveryWithFallback("unverifiable", "hello world", "hello world", "hello world"),
    ).toBe("unverifiable");
  });

  it("replaceAll path: TP unverifiable + VP delta<0 + !baseline.includes → delivered", () => {
    // Ctrl+A then type. baseline shrunk but did not contain checkText,
    // so VP authoritatively says delivered.
    expect(
      classifyDeliveryWithFallback("unverifiable", "previous content longer", "x", "x"),
    ).toBe(true);
  });

  it("password field: TP unverifiable + VP returns '' (empty postValue, !contains) → not delivered", () => {
    // ValuePattern on Password=true control returns empty per UIA spec.
    // postValue does not include checkText → false → handler emits
    // BackgroundInputNotDelivered (silent ok:true avoided).
    expect(
      classifyDeliveryWithFallback("unverifiable", "", "", "secret"),
    ).toBe(false);
  });

  it("focus race: TP unverifiable + VP postValue null (TreeWalker reject) → unverifiable", () => {
    // getTextViaValuePattern returns null when focused element migrated
    // outside the target window during the post-read window.
    expect(
      classifyDeliveryWithFallback("unverifiable", "baseline", null, "hello"),
    ).toBe("unverifiable");
  });

  it("VP baseline missing: TP unverifiable + valueBaseline null → unverifiable", () => {
    // Initial VP read also failed (e.g. window without ValuePattern providers
    // anywhere). 2nd defense layer cannot run; settle on unverifiable.
    expect(
      classifyDeliveryWithFallback("unverifiable", null, "hello world", "hello"),
    ).toBe("unverifiable");
  });

  it("TP false short-circuits VP (forward-compat): tpDecision=false → false", () => {
    // Future-proofing: if a TP slicing path emits explicit false, do not
    // override with VP. Current keyboard.ts source leaves verifiedDelivery
    // at "unverifiable" on slicing miss rather than asserting false, but
    // the helper preserves authority for any future TP code path that
    // does emit false.
    expect(
      classifyDeliveryWithFallback(false, "baseline", "baseline", "x"),
    ).toBe(false);
  });
});
