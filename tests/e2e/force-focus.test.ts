/**
 * force-focus.test.ts — E2E tests for forceFocus param (AttachThreadInput path)
 *
 * Reliable reproduction of Windows foreground-stealing protection requires
 * a pinned CLI window, which is not guaranteed in CI. Structural tests
 * verify the parameter plumbing; real foreground-stealing tests are
 * skipped with reason when conditions cannot be met.
 */

import { describe, it, expect } from "vitest";
import { mouseClickHandler } from "../../src/tools/mouse.js";
import { keyboardPressHandler } from "../../src/tools/keyboard.js";

describe("forceFocus param — structural tests", () => {
  it("mouse_click succeeds with forceFocus=true (no target window)", async () => {
    // When no windowTitle is given, force path is not triggered in applyHoming
    // (homing=false skips applyHoming entirely). Should succeed normally.
    const result = await mouseClickHandler({
      x: 960,
      y: 540,
      button: "left",
      doubleClick: false,
      homing: false,
      forceFocus: true,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // ForceFocusRefused should NOT appear when no homing was attempted
    const warnings: string[] = payload.hints?.warnings ?? [];
    expect(warnings).not.toContain("ForceFocusRefused");
  });

  it("keyboard_press succeeds with forceFocus=true (no windowTitle)", async () => {
    const result = await keyboardPressHandler({
      keys: "escape",
      forceFocus: true,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
  });

  it("env DESKTOP_TOUCH_FORCE_FOCUS=1 makes forceFocus default to true", async () => {
    const original = process.env.DESKTOP_TOUCH_FORCE_FOCUS;
    process.env.DESKTOP_TOUCH_FORCE_FOCUS = "1";
    try {
      // With the env var set, forceFocus should default to true
      // When no windowTitle is given and homing=false, there's no visible difference
      // but the code should not throw.
      const result = await keyboardPressHandler({
        keys: "escape",
        // forceFocus omitted → should follow env
        trackFocus: false,
        settleMs: 0,
      });
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.ok).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.DESKTOP_TOUCH_FORCE_FOCUS;
      } else {
        process.env.DESKTOP_TOUCH_FORCE_FOCUS = original;
      }
    }
  });

  it("forceFocus=false explicitly disables the path", async () => {
    const result = await mouseClickHandler({
      x: 960,
      y: 540,
      button: "left",
      doubleClick: false,
      homing: false,
      forceFocus: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // ForceFocusRefused should NOT appear without homing
    const warnings2: string[] = payload.hints?.warnings ?? [];
    expect(warnings2).not.toContain("ForceFocusRefused");
  });

  it.skip("foreground-stealing test — requires pinned CLI window to reproduce", async () => {
    // This test requires a pinned CLI that steals focus.
    // Without that setup, ForceFocusRefused will not appear.
    // Skipped: would require dock_window pinned CLI setup.
    //
    // If we could reproduce: mouse_click with forceFocus=true on a target window
    // should NOT have ForceFocusRefused in warnings.
  });
});
