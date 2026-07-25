/**
 * ADR-029 OQ8 — recovery advice must reach the root `suggest`.
 *
 * `failWith`'s third argument is a context record, so a `suggest` key in it
 * lands at `context.suggest` while the root stays whatever `classify` produced.
 * Fourteen call sites had drifted into that shape and five of them classified
 * to the generic `ToolError`, which has no SUGGESTS entry — so those failures
 * shipped with no advice at all in the place the server instructions tell the
 * model to read.
 *
 * The fix was to classify the code each producer already names in its message
 * and let SUGGESTS carry the advice (the same move SpawnFailed made earlier).
 * These tests pin that, plus the substring ordering the four new arms depend on.
 */
import { describe, it, expect } from "vitest";
import { failWith } from "../../src/tools/_errors.js";

const render = (message: string, context?: Record<string, unknown>) =>
  JSON.parse(failWith(new Error(message), "t", context).content[0]!.text);

describe("OQ8 — codes that used to fall through to ToolError", () => {
  const cases: [string, string][] = [
    ["ForegroundFlashRequiresTarget", "ForegroundFlashRequiresTarget"],
    ["ForegroundFlashUnsupported", "ForegroundFlashUnsupported"],
    ["TabDragBlocked", "TabDragBlocked: drag starts in the tab-strip area of a tabbed application"],
    ["CrossWindowDragBlocked", "CrossWindowDragBlocked: start hwnd=1 → end hwnd=2. Pass allowCrossWindowDrag:true."],
  ];

  it.each(cases)("%s classifies to its own code with root advice", (code, message) => {
    const body = render(message);
    expect(body.code).toBe(code);
    expect(Array.isArray(body.suggest)).toBe(true);
    expect(body.suggest.length).toBeGreaterThan(0);
  });

  // The producers write `ForegroundFlash…` messages for four different codes.
  // The two `NotApplicableTo*` arms are longer and more specific, so they must
  // keep matching ahead of the bare `foregroundflashunsupported` arm.
  it("does not let the shorter foreground-flash arm poach the longer ones", () => {
    expect(render("ForegroundFlashNotApplicableToKeyPress").code).toBe(
      "ForegroundFlashNotApplicableToKeyPress",
    );
    expect(render("ForegroundFlashNotApplicableToSequence").code).toBe(
      "ForegroundFlashNotApplicableToSequence",
    );
    expect(render("ForegroundFlashRequiresTarget").code).toBe("ForegroundFlashRequiresTarget");
    expect(render("ForegroundFlashUnsupported").code).toBe("ForegroundFlashUnsupported");
  });
});

describe("OQ8 — the context record stays one level deep", () => {
  it("renders caller keys directly under context", () => {
    const body = render("ForegroundFlashUnsupported", { reason: "chromium", windowTitle: "Chrome" });
    expect(body.context).toEqual({ reason: "chromium", windowTitle: "Chrome" });
  });

  // What the 21 flattened call sites used to do. Kept as a characterisation of
  // the trap rather than as an endorsement: the lint rule now rejects it at the
  // call site, and this shows what the wire looked like when it slipped through.
  it("nests a `context` key one level further, which is why the rule bans it", () => {
    const body = render("ForegroundFlashUnsupported", { context: { reason: "chromium" } });
    expect(body.context).toEqual({ context: { reason: "chromium" } });
  });

  it("keeps hoisted keys at the root", () => {
    const body = render("ForegroundFlashUnsupported", { hints: { a: 1 }, reason: "x" });
    expect(body.hints).toEqual({ a: 1 });
    expect(body.context).toEqual({ reason: "x" });
  });
});
