/**
 * mouse-focus-lost.test.ts — E2E tests for focusLost in mouse_click
 *
 * Tests the focusLost detection path in mouseClickHandler.
 * Actual foreground-stealing reproduction is skipped (environment-dependent).
 * These tests verify the structural behavior: presence/absence of focusLost,
 * and the trackFocus=false opt-out.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mouseClickHandler } from "../../src/tools/mouse.js";
import { findBlankDesktopPoint } from "./helpers/blank-point.js";

// Click a scanned blank desktop spot, never a hardcoded coordinate — (960,540)
// (screen centre) almost always lands on a real window. Skip if the screen is
// fully covered (no safe blank spot to click).
const BLANK = findBlankDesktopPoint();

describe.skipIf(BLANK === null)("mouse_click focusLost", () => {
  // These tests pre-date v0.12 Auto Perception. They exercise focusLost
  // detection, not the auto-guard path — disable auto-guard so it doesn't
  // block clicks based on live desktop modal/window state.
  let prevAutoGuard: string | undefined;
  beforeAll(() => {
    prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  });
  afterAll(() => {
    if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
    else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  });

  it("succeeds and contains ok:true", async () => {
    // Click a scanned blank desktop spot (over the wallpaper, no window there)
    const result = await mouseClickHandler({
      x: BLANK!.x,
      y: BLANK!.y,
      button: "left",
      doubleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe("click");
  });

  it("does not include focusLost when trackFocus=false", async () => {
    const result = await mouseClickHandler({
      x: BLANK!.x,
      y: BLANK!.y,
      button: "left",
      doubleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 300,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.focusLost).toBeUndefined();
  });

  it("runs without error when trackFocus=true and no windowTitle (no-op path)", async () => {
    // No windowTitle, no homing notes → detectFocusLoss returns null immediately
    const result = await mouseClickHandler({
      x: BLANK!.x,
      y: BLANK!.y,
      button: "left",
      doubleClick: false,
      homing: false,
      trackFocus: true,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.focusLost).toBeUndefined();
  });

  it("includes conversion info when origin is provided", async () => {
    // Verify the origin+scale conversion (screen = origin + local/scale) while
    // still landing the real click on the scanned blank spot: with x=100,scale=2
    // the local offset is +50, so origin = BLANK - 50 makes screen === BLANK.
    const origin = { x: BLANK!.x - 50, y: BLANK!.y - 50 };
    const result = await mouseClickHandler({
      x: 100,
      y: 100,
      origin,
      scale: 2,
      button: "left",
      doubleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(typeof payload.conversion).toBe("string");
    // screen = origin.x + x/scale = (BLANK.x - 50) + 100/2 = BLANK.x
    expect(payload.at.x).toBe(BLANK!.x);
    expect(payload.at.y).toBe(BLANK!.y);
  });

  it("skips settle wait and focusLost when trackFocus=false (faster execution)", async () => {
    const before = Date.now();
    await mouseClickHandler({
      x: BLANK!.x,
      y: BLANK!.y,
      button: "left",
      doubleClick: false,
      tripleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 300, // settleMs is ignored when trackFocus=false
      // Issue #178: verifyDelivery defaults to true and adds ~150ms settle +
      // two UIA round-trips. Disable here so the budget-vs-trackFocus test
      // measures only the trackFocus cost.
      verifyDelivery: false,
    });
    const elapsed = Date.now() - before;
    // Without the settle wait, should complete well under 300ms
    // (allowing for click animation time ~200ms at default speed)
    expect(elapsed).toBeLessThan(1000);
  });

  it("skips non-existent window title gracefully (no focusLost when fg matches target)", async () => {
    const result = await mouseClickHandler({
      x: BLANK!.x,
      y: BLANK!.y,
      button: "left",
      doubleClick: false,
      homing: false,
      windowTitle: undefined, // no target → no detection
      trackFocus: true,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
  });
});
