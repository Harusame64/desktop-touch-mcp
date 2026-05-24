/**
 * force-focus.test.ts — E2E tests for forceFocus param (AttachThreadInput path)
 *
 * Reliable reproduction of Windows foreground-stealing protection requires
 * a pinned CLI window, which is not guaranteed in CI. Structural tests
 * verify the parameter plumbing; real foreground-stealing tests are
 * skipped with reason when conditions cannot be met.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mouseClickHandler } from "../../src/tools/mouse.js";
import { keyboardPressHandler } from "../../src/tools/keyboard.js";
import { findBlankDesktopPoint } from "./helpers/blank-point.js";

// mouse_click tests target a SCANNED blank desktop spot, never (960,540) /
// screen centre (which almost always lands on a real window). Only the mouse
// tests need it (keyboard tests do not click), so guard those with it.skipIf.
const BLANK = findBlankDesktopPoint();

describe("forceFocus param — structural tests", () => {
  // These tests pre-date v0.12 Auto Perception. They exercise the forceFocus
  // plumbing, not the auto-guard path — disable auto-guard so it doesn't
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

  it.skipIf(BLANK === null)("mouse_click succeeds with forceFocus=true (no target window)", async () => {
    // When no windowTitle is given, force path is not triggered in applyHoming
    // (homing=false skips applyHoming entirely). Should succeed normally.
    const result = await mouseClickHandler({
      x: BLANK!.x,
      y: BLANK!.y,
      button: "left",
      doubleClick: false,
      homing: false,
      forceFocus: true,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // Issue #202: ForceFocusRefused warning was retired in favour of the
    // typed ok:false code:"ForegroundRestricted" early-return. The string
    // should never appear in warnings under either contract — pre-fix
    // because no homing was attempted, post-fix because the warning shape
    // itself is dead. Pinning absence here guards against accidental
    // re-introduction.
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

  it.skipIf(BLANK === null)("forceFocus=false explicitly disables the path", async () => {
    const result = await mouseClickHandler({
      x: BLANK!.x,
      y: BLANK!.y,
      button: "left",
      doubleClick: false,
      homing: false,
      forceFocus: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // Issue #202: same invariant as line 43-45 — the legacy
    // ForceFocusRefused warning shape is retired (typed ok:false now), so
    // its absence is unconditional under the new contract.
    const warnings2: string[] = payload.hints?.warnings ?? [];
    expect(warnings2).not.toContain("ForceFocusRefused");
  });

  // envOnly (issue #182): reliably reproducing Windows foreground-stealing
  // protection requires a pinned CLI window racing focus mid-test, which
  // depends on dock_window setup that isn't present in CI. Per matrix doc
  // §3.1 mouse_click row, the Indirect verification (focus_only /
  // delivered / unverifiable hint) covers the contract; this test would
  // only pin a specific OS-side degradation case (ForceFocusRefused
  // warning suppression when forceFocus=true). No product invariant is
  // silently passed — it.skip is documenting an unreachable branch.
  it.skip("foreground-stealing test — requires pinned CLI window to reproduce (envOnly)", async () => {
    // If we could reproduce: mouse_click with forceFocus=true on a target window
    // should NOT have ForceFocusRefused in warnings.
  });
});
