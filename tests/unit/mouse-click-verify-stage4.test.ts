/**
 * ADR-019 Stage 4 — `classifyDeliveryWithLocalRepaint` wrapper logic tests.
 *
 * Sub-plan: docs/adr-019-stage-4-plan.md §3 row 13 (≥ 4 cases). Drives the
 * §2.4.1 activation rules + §9 upgrade-only invariant by mocking
 * `verifyLocalRepaint` to return each of the three motion outputs and
 * asserting the wrapper preserves / upgrades the upstream
 * `classifyDelivery` result correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MouseVerifySnapshot } from "../../src/tools/_mouse-verify.js";
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

const mouseVerify = await import("../../src/tools/_mouse-verify.js");
const { classifyDeliveryWithLocalRepaint } = mouseVerify;

// Helpers to build snapshots that drive `classifyDelivery` to specific outcomes.
function snapWithFocus(name: string): MouseVerifySnapshot {
  return {
    elementAtPoint: { name: "elem", controlType: "Button" },
    focusedElement: { name, controlType: "Pane" },
    foregroundHwnd: 1n,
    verticalScrollPos: null,
  };
}

function snapNoUia(): MouseVerifySnapshot {
  return {
    elementAtPoint: null,
    focusedElement: null,
    foregroundHwnd: 1n,
    verticalScrollPos: null,
  };
}

const STAGE4_INPUT = {
  hwnd: 1n,
  hint: {
    point: { x: 100, y: 100 },
    windowRect: { x: 0, y: 0, width: 800, height: 600 },
  },
  preFrame: null, // verifyLocalRepaint is mocked so this is unused.
};

const OBS_LOCAL_REPAINT: VisualMotionObservation = {
  motion: "local_repaint",
  source: "ssim_residual",
  residual: { fractionChanged: 0.12, meanSsim: 0.85 },
  framesSampled: 3,
  totalElapsedMs: 200,
};
const OBS_NO_CHANGE: VisualMotionObservation = {
  motion: "no_change",
  source: "ssim_residual",
  residual: { fractionChanged: 0.0, meanSsim: 0.999 },
  framesSampled: 3,
  totalElapsedMs: 200,
};
const OBS_INDETERMINATE: VisualMotionObservation = {
  motion: "indeterminate",
  source: "ssim_residual",
  residual: { fractionChanged: 0.02, meanSsim: 0.96 },
  framesSampled: 3,
  totalElapsedMs: 200,
};

describe("classifyDeliveryWithLocalRepaint (ADR-019 Stage 4 wrapper)", () => {
  const ORIGINAL_ENV = process.env.DESKTOP_TOUCH_STAGE4_SSIM;

  beforeEach(() => {
    mockVerifyLocalRepaint.mockReset();
    if (ORIGINAL_ENV === undefined) delete process.env.DESKTOP_TOUCH_STAGE4_SSIM;
    else process.env.DESKTOP_TOUCH_STAGE4_SSIM = ORIGINAL_ENV;
  });

  it("delivered baseline → Stage 4 NOT invoked (sub-plan §2.4.1 gate 2)", async () => {
    // Element-at-point changed → classifyDelivery returns `delivered`.
    const pre = snapWithFocus("a");
    const post: MouseVerifySnapshot = {
      ...pre,
      elementAtPoint: { name: "differs", controlType: "Button" },
    };
    const hint = await classifyDeliveryWithLocalRepaint(
      pre,
      post,
      "send_input",
      STAGE4_INPUT,
    );
    expect(hint.status).toBe("delivered");
    expect(hint.observation).toBeUndefined();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
  });

  it("focus_only + motion: 'local_repaint' → upgrade to delivered (§9 upgrade)", async () => {
    mockVerifyLocalRepaint.mockResolvedValueOnce(OBS_LOCAL_REPAINT);
    const pre = snapWithFocus("a");
    const post = snapWithFocus("a"); // No change → classifyDelivery returns focus_only.
    const hint = await classifyDeliveryWithLocalRepaint(
      pre,
      post,
      "send_input",
      STAGE4_INPUT,
    );
    expect(hint.status).toBe("delivered");
    expect(hint.observation).toEqual(OBS_LOCAL_REPAINT);
    // No `reason` on the upgraded delivered status.
    expect(hint.reason).toBeUndefined();
  });

  it("focus_only + motion: 'no_change' → preserve focus_only + attach observation (§9 no-demote)", async () => {
    mockVerifyLocalRepaint.mockResolvedValueOnce(OBS_NO_CHANGE);
    const pre = snapWithFocus("a");
    const post = snapWithFocus("a");
    const hint = await classifyDeliveryWithLocalRepaint(
      pre,
      post,
      "send_input",
      STAGE4_INPUT,
    );
    expect(hint.status).toBe("focus_only");
    expect(hint.reason).toBe("no_observable_change");
    expect(hint.observation).toEqual(OBS_NO_CHANGE);
  });

  it("focus_only + motion: 'indeterminate' → preserve focus_only + attach observation", async () => {
    mockVerifyLocalRepaint.mockResolvedValueOnce(OBS_INDETERMINATE);
    const pre = snapWithFocus("a");
    const post = snapWithFocus("a");
    const hint = await classifyDeliveryWithLocalRepaint(
      pre,
      post,
      "send_input",
      STAGE4_INPUT,
    );
    expect(hint.status).toBe("focus_only");
    expect(hint.observation).toEqual(OBS_INDETERMINATE);
  });

  it("unverifiable + motion: 'local_repaint' → upgrade to delivered", async () => {
    mockVerifyLocalRepaint.mockResolvedValueOnce(OBS_LOCAL_REPAINT);
    const pre = snapNoUia();
    const post = snapNoUia();
    const hint = await classifyDeliveryWithLocalRepaint(
      pre,
      post,
      "send_input",
      STAGE4_INPUT,
    );
    expect(hint.status).toBe("delivered");
    expect(hint.observation).toEqual(OBS_LOCAL_REPAINT);
  });

  it("env opt-out DESKTOP_TOUCH_STAGE4_SSIM=0 → wrapper returns baseline unchanged", async () => {
    process.env.DESKTOP_TOUCH_STAGE4_SSIM = "0";
    const pre = snapWithFocus("a");
    const post = snapWithFocus("a");
    const hint = await classifyDeliveryWithLocalRepaint(
      pre,
      post,
      "send_input",
      STAGE4_INPUT,
    );
    expect(hint.status).toBe("focus_only");
    expect(hint.observation).toBeUndefined();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
  });

  it("stage4 === null → wrapper returns baseline classifyDelivery unchanged (G4-3 regression gate)", async () => {
    const pre = snapWithFocus("a");
    const post = snapWithFocus("a");
    const hint = await classifyDeliveryWithLocalRepaint(
      pre,
      post,
      "send_input",
      null,
    );
    expect(hint.status).toBe("focus_only");
    expect(hint.observation).toBeUndefined();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
  });
});
