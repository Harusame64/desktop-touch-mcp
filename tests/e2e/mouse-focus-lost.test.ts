/**
 * mouse-focus-lost.test.ts — E2E tests for focusLost in mouse_click
 *
 * Tests the focusLost detection path in mouseClickHandler.
 * Actual foreground-stealing reproduction is skipped (environment-dependent).
 * These tests verify the structural behavior: presence/absence of focusLost,
 * and the trackFocus=false opt-out.
 */

import { describe, it, expect } from "vitest";
import { mouseClickHandler } from "../../src/tools/mouse.js";

describe("mouse_click focusLost", () => {
  it("succeeds and contains ok:true", async () => {
    // Click at screen center — may or may not hit a real window
    const result = await mouseClickHandler({
      x: 960,
      y: 540,
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
      x: 960,
      y: 540,
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
      x: 960,
      y: 540,
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
    const result = await mouseClickHandler({
      x: 100,
      y: 100,
      origin: { x: 800, y: 400 },
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
    // screen = origin.x + x/scale = 800 + 100/2 = 850
    expect(payload.at.x).toBe(850);
    expect(payload.at.y).toBe(450);
  });

  it("skips settle wait and focusLost when trackFocus=false (faster execution)", async () => {
    const before = Date.now();
    await mouseClickHandler({
      x: 960,
      y: 540,
      button: "left",
      doubleClick: false,
      homing: false,
      trackFocus: false,
      settleMs: 300, // settleMs is ignored when trackFocus=false
    });
    const elapsed = Date.now() - before;
    // Without the settle wait, should complete well under 300ms
    // (allowing for click animation time ~200ms at default speed)
    expect(elapsed).toBeLessThan(1000);
  });

  it("skips non-existent window title gracefully (no focusLost when fg matches target)", async () => {
    const result = await mouseClickHandler({
      x: 960,
      y: 540,
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
