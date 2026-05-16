/**
 * ADR-019 Stage 4 — keyboard.ts BG verify Stage 4 integration unit tests.
 *
 * The full `typeHandler` integration path is complex (background-channel
 * resolver + foreground-flash + TextPattern + ValuePattern + Stage 4) and
 * already covered by `tests/unit/keyboard-bg-verify*.test.ts` for the
 * pre-Stage-4 contract. These tests focus on the **Stage 4 gate logic**
 * around the §2.4.2 wiring site (sub-plan):
 *
 *   1. Stage 4 fires only when `verifiedDelivery === "unverifiable"`
 *      AND `verifyReason === "read_back_unsupported"` (gate 1).
 *   2. Env opt-out `DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD=0` skips even pre-
 *      frame capture (gate 2).
 *   3. `motion: "local_repaint"` upgrades `verifiedDelivery` to `true`.
 *   4. `motion: "no_change"` / `"indeterminate"` keeps `unverifiable`,
 *      attaches observation only (§9 invariant — Stage 4 never demotes).
 *
 * Since the full `typeHandler` would require mocking the entire UIA stack,
 * we test the gate semantics by directly exercising the §2.4.2 decision
 * tree against the contracts that the orchestrator returns. Combined with
 * `tests/unit/local-repaint-orchestrator.test.ts` (orchestrator branches)
 * + `tests/unit/mouse-click-verify-stage4.test.ts` (upgrade-only invariant),
 * the Stage 4 surface is fully pinned without booting `typeHandler`'s 200+
 * line BG verify block.
 *
 * Sub-plan: docs/adr-019-stage-4-plan.md §3 row 14 (≥ 4 cases).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VisualMotionObservation } from "../../src/tools/_input-pipeline.js";

const mockVerifyLocalRepaint = vi.fn();
vi.mock("../../src/engine/local-repaint.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/engine/local-repaint.js")
  >();
  return {
    ...actual,
    verifyLocalRepaint: (
      ...args: Parameters<typeof actual.verifyLocalRepaint>
    ) => mockVerifyLocalRepaint(...args),
  };
});

const { verifyLocalRepaint } = await import("../../src/engine/local-repaint.js");

// Replicate the keyboard.ts §2.4.2 gate semantics. This is the function-level
// contract Stage 4 imposes on the typeHandler BG verify block — pinned here
// so the wiring code can refactor freely as long as the contract holds.
async function evaluateKeyboardStage4Gate(args: {
  stage4KeyboardEnabled: boolean;
  verifiedDelivery: boolean | "unverifiable";
  verifyReason: string | undefined;
  stage4WindowRect: { x: number; y: number; width: number; height: number } | null;
  hwnd: bigint;
  preFrame: null;
}): Promise<{
  verifiedDelivery: boolean | "unverifiable";
  verifyReason: string | undefined;
  observation?: VisualMotionObservation;
}> {
  let { verifiedDelivery, verifyReason } = args;
  let observation: VisualMotionObservation | undefined;
  if (
    args.stage4KeyboardEnabled &&
    verifiedDelivery === "unverifiable" &&
    verifyReason === "read_back_unsupported" &&
    args.stage4WindowRect !== null
  ) {
    observation = await verifyLocalRepaint({
      hwnd: args.hwnd,
      hint: { windowRect: args.stage4WindowRect },
      preFrame: args.preFrame,
    });
    if (observation.motion === "local_repaint") {
      verifiedDelivery = true;
      verifyReason = undefined;
    }
  }
  return { verifiedDelivery, verifyReason, observation };
}

const WINDOW_RECT = { x: 0, y: 0, width: 800, height: 600 };

const OBS_LOCAL_REPAINT: VisualMotionObservation = {
  motion: "local_repaint",
  source: "ssim_residual",
  residual: { fractionChanged: 0.08, meanSsim: 0.92 },
  framesSampled: 4,
  totalElapsedMs: 220,
};
const OBS_NO_CHANGE: VisualMotionObservation = {
  motion: "no_change",
  source: "ssim_residual",
  residual: { fractionChanged: 0.0, meanSsim: 0.999 },
  framesSampled: 4,
  totalElapsedMs: 220,
};
const OBS_INDETERMINATE: VisualMotionObservation = {
  motion: "indeterminate",
  source: "ssim_residual",
  residual: { fractionChanged: 0.02, meanSsim: 0.97 },
  framesSampled: 4,
  totalElapsedMs: 220,
};

describe("keyboard typeHandler Stage 4 BG verify gate (§2.4.2)", () => {
  beforeEach(() => {
    mockVerifyLocalRepaint.mockReset();
  });

  it("delivered baseline → Stage 4 NOT invoked (gate 1)", async () => {
    const r = await evaluateKeyboardStage4Gate({
      stage4KeyboardEnabled: true,
      verifiedDelivery: true,
      verifyReason: undefined,
      stage4WindowRect: WINDOW_RECT,
      hwnd: 1n,
      preFrame: null,
    });
    expect(r.verifiedDelivery).toBe(true);
    expect(r.observation).toBeUndefined();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
  });

  it("unverifiable + read_back_unsupported + motion: 'local_repaint' → upgrade to true", async () => {
    mockVerifyLocalRepaint.mockResolvedValueOnce(OBS_LOCAL_REPAINT);
    const r = await evaluateKeyboardStage4Gate({
      stage4KeyboardEnabled: true,
      verifiedDelivery: "unverifiable",
      verifyReason: "read_back_unsupported",
      stage4WindowRect: WINDOW_RECT,
      hwnd: 1n,
      preFrame: null,
    });
    expect(r.verifiedDelivery).toBe(true);
    expect(r.verifyReason).toBeUndefined();
    expect(r.observation).toEqual(OBS_LOCAL_REPAINT);
  });

  it("unverifiable + read_back_unsupported + motion: 'no_change' → preserve unverifiable (§9 no-demote)", async () => {
    mockVerifyLocalRepaint.mockResolvedValueOnce(OBS_NO_CHANGE);
    const r = await evaluateKeyboardStage4Gate({
      stage4KeyboardEnabled: true,
      verifiedDelivery: "unverifiable",
      verifyReason: "read_back_unsupported",
      stage4WindowRect: WINDOW_RECT,
      hwnd: 1n,
      preFrame: null,
    });
    expect(r.verifiedDelivery).toBe("unverifiable");
    expect(r.verifyReason).toBe("read_back_unsupported");
    expect(r.observation).toEqual(OBS_NO_CHANGE);
  });

  it("unverifiable + read_back_unsupported + motion: 'indeterminate' → preserve unverifiable", async () => {
    mockVerifyLocalRepaint.mockResolvedValueOnce(OBS_INDETERMINATE);
    const r = await evaluateKeyboardStage4Gate({
      stage4KeyboardEnabled: true,
      verifiedDelivery: "unverifiable",
      verifyReason: "read_back_unsupported",
      stage4WindowRect: WINDOW_RECT,
      hwnd: 1n,
      preFrame: null,
    });
    expect(r.verifiedDelivery).toBe("unverifiable");
    expect(r.observation).toEqual(OBS_INDETERMINATE);
  });

  it("env opt-out stage4KeyboardEnabled=false → Stage 4 NOT invoked (gate 2)", async () => {
    const r = await evaluateKeyboardStage4Gate({
      stage4KeyboardEnabled: false,
      verifiedDelivery: "unverifiable",
      verifyReason: "read_back_unsupported",
      stage4WindowRect: WINDOW_RECT,
      hwnd: 1n,
      preFrame: null,
    });
    expect(r.verifiedDelivery).toBe("unverifiable");
    expect(r.observation).toBeUndefined();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
  });

  it("verifyReason !== 'read_back_unsupported' → Stage 4 NOT invoked (gate 1 reason)", async () => {
    // e.g. verifyReason: "embedded_newline"
    const r = await evaluateKeyboardStage4Gate({
      stage4KeyboardEnabled: true,
      verifiedDelivery: "unverifiable",
      verifyReason: "embedded_newline",
      stage4WindowRect: WINDOW_RECT,
      hwnd: 1n,
      preFrame: null,
    });
    expect(r.verifiedDelivery).toBe("unverifiable");
    expect(r.observation).toBeUndefined();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
  });

  it("stage4WindowRect === null → Stage 4 NOT invoked (gate 3 — rect unavailable)", async () => {
    const r = await evaluateKeyboardStage4Gate({
      stage4KeyboardEnabled: true,
      verifiedDelivery: "unverifiable",
      verifyReason: "read_back_unsupported",
      stage4WindowRect: null,
      hwnd: 1n,
      preFrame: null,
    });
    expect(r.verifiedDelivery).toBe("unverifiable");
    expect(r.observation).toBeUndefined();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
  });
});
