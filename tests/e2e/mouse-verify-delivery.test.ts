/**
 * mouse-verify-delivery.test.ts — E2E tests for issue #178
 *
 * Pins the `hints.verifyDelivery` 3-value enum (matrix doc §4.4):
 *   - delivered: pre/post snapshot diffs detected an observable change
 *   - focus_only: foreground stable, nothing else moved
 *   - unverifiable: UIA observation channel unavailable
 *
 * Why E2E: the snapshot helper (`snapshotForVerify`) calls real UIA +
 * win32 APIs, so a mocked test would only echo back the mock. We use the
 * desktop background as a target — it is stable, deterministic, and the
 * UIA tree is "Desktop" in both pre and post snapshots, which gives us
 * `focus_only` (nothing changed) for the "intentional silent fail" path
 * required by the issue acceptance criteria.
 *
 * Skip policy: when no UIA is available at all (tests/CI without a
 * desktop), `unverifiable` is the expected outcome — tests assert the
 * status is one of {focus_only, unverifiable} for null-target clicks
 * rather than pinning to a single value (E2E flakiness mitigation).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mouseClickHandler, mouseDragHandler } from "../../src/tools/mouse.js";
import { spawnBlankWindow } from "./helpers/blank-window.js";

// Click/drag a dedicated, empty throwaway window instead of guessing a "probably
// empty" coordinate like (50,50) or (960,540). The blank window's empty client
// area is exactly the "action that hits nothing" the silent-fail pin needs (no
// UIA children to mutate -> focus_only), and it never clicks/drags on a real
// window or the desktop/Recycle Bin. Skip only if the window cannot be spawned.
// Closed ONCE at file scope (a per-describe afterAll would close it before the
// second describe runs, leaving its clicks to land on the desktop).
const blank = await spawnBlankWindow();
afterAll(() => blank?.close());

describe.skipIf(blank === null)("mouse_click verifyDelivery hint (issue #178)", () => {
  let prevAutoGuard: string | undefined;
  beforeAll(() => {
    // Disable auto-guard so blank-area clicks don't get filtered by
    // safe.clickCoordinates. We're testing the post-click verification
    // path, not the pre-click guard.
    prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  });
  afterAll(() => {
    if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
    else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  });

  it("returns hints.verifyDelivery when verifyDelivery=true (default)", async () => {
    const result = await mouseClickHandler({
      // Blank window's empty client area — this click hits nothing actionable.
      x: blank!.point.x,
      y: blank!.point.y,
      button: "left",
      doubleClick: false,
      tripleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // Hint must be present by default (no opt-in required, matrix doc §3.1).
    expect(payload.hints).toBeDefined();
    expect(payload.hints.verifyDelivery).toBeDefined();
    const v = payload.hints.verifyDelivery;
    expect(["delivered", "focus_only", "unverifiable"]).toContain(v.status);
    expect(v.channel).toBe("send_input");
    if (v.status !== "delivered") {
      // Non-delivered statuses must carry a reason (matrix doc §4.4).
      expect(v.reason).toBeTruthy();
    }
  }, 15_000);

  it("does NOT include verifyDelivery hint when verifyDelivery=false", async () => {
    const result = await mouseClickHandler({
      // Blank window's empty client area — this click hits nothing actionable.
      x: blank!.point.x,
      y: blank!.point.y,
      button: "left",
      doubleClick: false,
      tripleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 0,
      verifyDelivery: false,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    if (payload.hints) {
      expect(payload.hints.verifyDelivery).toBeUndefined();
    }
  }, 10_000);

  it("blank-area click returns 'focus_only' or 'unverifiable' (silent fail pin)", async () => {
    // Click the blank window's empty client area — there is no actionable target
    // there. Pre/post UIA observations are identical (an empty form has no
    // children to mutate), giving 'focus_only' when UIA is available. On hosts
    // without UIA the snapshot returns null and we expect 'unverifiable'.
    //
    // This is the "intentional silent fail" pin from the issue acceptance
    // criteria: an action that doesn't hit anything must NOT return
    // verifyDelivery:'delivered'. The dedicated window also keeps this off the
    // desktop entirely (no Recycle Bin focus, no host-MCP failsafe corner).
    //
    // Note: this is the 3rd click in the describe, so the blank window is already
    // foreground by now — the click causes no foreground change, so the status
    // settles on 'focus_only' (a 1st click could report 'delivered' via fgChange;
    // that earlier test does not assert a specific status).
    const result = await mouseClickHandler({
      // Blank window's empty client area — this click hits nothing actionable.
      x: blank!.point.x,
      y: blank!.point.y,
      button: "left",
      doubleClick: false,
      tripleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    const status = payload.hints?.verifyDelivery?.status;
    // Either we observed nothing (focus_only) or UIA was missing
    // (unverifiable). 'delivered' would mean a real side effect happened
    // somewhere on this empty click — that is the silent-success
    // regression we are guarding against.
    expect(["focus_only", "unverifiable"]).toContain(status);
  }, 15_000);

  it("3-value enum: status is one of {delivered, focus_only, unverifiable}", async () => {
    // Cover the canonical matrix doc §4.4 enum. Click the blank window — any of
    // the 3 statuses is acceptable here (no branch requires 'delivered').
    const result = await mouseClickHandler({
      x: blank!.point.x,
      y: blank!.point.y,
      button: "left",
      doubleClick: false,
      tripleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    const v = payload.hints?.verifyDelivery;
    expect(v).toBeDefined();
    expect(["delivered", "focus_only", "unverifiable"]).toContain(v.status);
  }, 15_000);
});

describe.skipIf(blank === null)("mouse_drag verifyDelivery hint (issue #178)", () => {
  let prevAutoGuard: string | undefined;
  beforeAll(() => {
    prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  });
  afterAll(() => {
    if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
    else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  });

  it("returns hints.verifyDelivery for drags when default", async () => {
    // Short drag inside the blank window. allowCrossWindowDrag:true keeps the
    // cross-window guard from firing (both endpoints are within our window).
    const result = await mouseDragHandler({
      startX: blank!.point.x,
      startY: blank!.point.y,
      endX: blank!.point.x + 20,
      endY: blank!.point.y + 20,
      homing: false,
      allowCrossWindowDrag: true,
      allowTabDrag: true,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.hints?.verifyDelivery).toBeDefined();
    const v = payload.hints.verifyDelivery;
    expect(["delivered", "focus_only", "unverifiable"]).toContain(v.status);
    expect(v.channel).toBe("send_input");
  }, 15_000);

  it("respects verifyDelivery=false opt-out for drag", async () => {
    const result = await mouseDragHandler({
      startX: blank!.point.x,
      startY: blank!.point.y,
      endX: blank!.point.x + 20,
      endY: blank!.point.y + 20,
      homing: false,
      allowCrossWindowDrag: true,
      allowTabDrag: true,
      verifyDelivery: false,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    if (payload.hints) {
      expect(payload.hints.verifyDelivery).toBeUndefined();
    }
  }, 10_000);
});
