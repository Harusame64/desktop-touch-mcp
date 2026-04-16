/**
 * tests/unit/modal-predicate.test.ts
 *
 * Unit tests for the evaluateModalAbove helper in sensors-win32.
 * These tests use synthetic WindowZInfo arrays — no Win32 calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateModalAbove } from "../../src/engine/perception/sensors-win32.js";
import type { WindowZInfo } from "../../src/engine/win32.js";

// ── Win32 helpers called as fallback inside evaluateModalAbove ────────────────
// (only invoked when className / exStyle are absent from the WindowZInfo)
vi.mock("../../src/engine/win32.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/win32.js")>("../../src/engine/win32.js");
  return {
    ...actual,
    getWindowClassName: vi.fn().mockReturnValue(""),
    isWindowTopmost: vi.fn().mockReturnValue(false),
  };
});

// ── Helper ───────────────────────────────────────────────────────────────────

function makeWindow(
  hwnd: bigint,
  zOrder: number,
  overrides: Partial<WindowZInfo> = {}
): WindowZInfo {
  return {
    hwnd,
    title: "Test Window",
    region: { x: 100, y: 100, width: 800, height: 600 },
    zOrder,
    isMinimized: false,
    isMaximized: false,
    isActive: false,
    exStyle: 0,
    ownerHwnd: null,
    className: "",
    isCloaked: false,
    isEnabled: true,
    ...overrides,
  };
}

/** Target window at zOrder=5, all defaults enabled/visible */
const TARGET_HWND = 1000n;
function makeTarget(overrides: Partial<WindowZInfo> = {}): WindowZInfo {
  return makeWindow(TARGET_HWND, 5, { title: "Main App", isActive: true, ...overrides });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluateModalAbove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns isModal:false when no windows are above the target", () => {
    const target = makeTarget();
    // Only window below the target (higher zOrder)
    const below = makeWindow(2000n, 10);
    const result = evaluateModalAbove(target, [target, below]);
    expect(result.isModal).toBe(false);
  });

  it("returns isModal:true (0.93) when target is disabled — classic modal pattern", () => {
    const target = makeTarget({ isEnabled: false });
    const dialog = makeWindow(2000n, 2); // above target (zOrder < 5)
    const result = evaluateModalAbove(target, [target, dialog]);
    expect(result.isModal).toBe(true);
    expect(result.confidence).toBeCloseTo(0.93, 2);
  });

  it("returns isModal:true (0.88) when candidate is directly owned by the target", () => {
    const target = makeTarget(); // enabled
    const ownedDialog = makeWindow(2000n, 2, { ownerHwnd: TARGET_HWND });
    const result = evaluateModalAbove(target, [target, ownedDialog]);
    expect(result.isModal).toBe(true);
    expect(result.confidence).toBeCloseTo(0.88, 2);
  });

  it("returns isModal:true (0.80) for a #32770 dialog class cross-process window", () => {
    const target = makeTarget();
    const win32Dialog = makeWindow(3000n, 1, { className: "#32770" });
    const result = evaluateModalAbove(target, [target, win32Dialog]);
    expect(result.isModal).toBe(true);
    expect(result.confidence).toBeCloseTo(0.80, 2);
  });

  it("returns isModal:true (0.75) for a floating topmost window with no ownership", () => {
    const target = makeTarget();
    const toast = makeWindow(4000n, 3, { exStyle: 0x00000008 }); // WS_EX_TOPMOST
    const result = evaluateModalAbove(target, [target, toast]);
    expect(result.isModal).toBe(true);
    expect(result.confidence).toBeCloseTo(0.75, 2);
  });

  it("returns isModal:false for a cloaked window above target (UWP background)", () => {
    const target = makeTarget();
    const cloaked = makeWindow(5000n, 2, { isCloaked: true, className: "#32770" });
    const result = evaluateModalAbove(target, [target, cloaked]);
    expect(result.isModal).toBe(false);
  });

  it("returns isModal:false for a tooltip-sized window (area < 10000)", () => {
    const target = makeTarget();
    // 50×20 = 1000px² — far below MODAL_MIN_AREA
    const tooltip = makeWindow(6000n, 1, {
      region: { x: 200, y: 200, width: 50, height: 20 },
    });
    const result = evaluateModalAbove(target, [target, tooltip]);
    expect(result.isModal).toBe(false);
  });

  it("returns isModal:false when title matches MODAL_TITLE_RE but has no qualifying rule", () => {
    const target = makeTarget(); // enabled
    // Has "Error" in title but no ownership, not topmost, not #32770, target not disabled
    const named = makeWindow(7000n, 2, {
      title: "Error Log Viewer",
      className: "SomeOtherClass",
      ownerHwnd: null,
      exStyle: 0,
    });
    const result = evaluateModalAbove(target, [target, named]);
    expect(result.isModal).toBe(false);
  });

  it("returns isModal:false for a normal window below target in z-order", () => {
    const target = makeTarget();
    // zOrder=10 > target zOrder=5 → below target, not above
    const sibling = makeWindow(8000n, 10, { ownerHwnd: TARGET_HWND, className: "#32770" });
    const result = evaluateModalAbove(target, [target, sibling]);
    expect(result.isModal).toBe(false);
  });

  it("skips the target window itself", () => {
    const target = makeTarget({ isEnabled: false }); // disabled target
    // target has zOrder=5, not lower than itself — skipped because hwnd matches
    const result = evaluateModalAbove(target, [target]);
    expect(result.isModal).toBe(false);
  });

  it("picks the highest-confidence rule when multiple rules match", () => {
    // target disabled (0.93) + direct ownership (0.88) → should return 0.93
    const target = makeTarget({ isEnabled: false });
    const dialog = makeWindow(2000n, 2, {
      ownerHwnd: TARGET_HWND,
      className: "#32770",
    });
    const result = evaluateModalAbove(target, [target, dialog]);
    expect(result.isModal).toBe(true);
    // Confidence should be 0.93 (highest rule) boosted slightly by #32770 and title check if applicable
    expect(result.confidence).toBeGreaterThanOrEqual(0.93);
  });

  it("title-regex boosts confidence slightly above the base rule", () => {
    const target = makeTarget();
    // Direct ownership (0.88) + dialog title → slight boost
    const dlg = makeWindow(2000n, 2, {
      title: "Confirm Delete",
      ownerHwnd: TARGET_HWND,
    });
    const withTitleBoost = evaluateModalAbove(target, [target, dlg]);
    // Without boost
    const noTitleDlg = makeWindow(2000n, 2, { ownerHwnd: TARGET_HWND, title: "Child Window" });
    const withoutBoost = evaluateModalAbove(target, [target, noTitleDlg]);
    expect(withTitleBoost.confidence).toBeGreaterThan(withoutBoost.confidence);
  });

  it("returns isModal:false for a disabled window above target (disabled candidate skipped)", () => {
    const target = makeTarget(); // target is enabled
    const disabled = makeWindow(2000n, 2, {
      isEnabled: false,
      className: "#32770",
      ownerHwnd: TARGET_HWND,
    });
    const result = evaluateModalAbove(target, [target, disabled]);
    expect(result.isModal).toBe(false);
  });
});
