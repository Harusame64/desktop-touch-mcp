/**
 * keyboard-focus-lost.test.ts — E2E tests for focusLost in keyboard tools
 *
 * Tests that keyboard_type and keyboard_press include focusLost in responses
 * when focus is stolen, and that trackFocus=false skips the detection.
 *
 * NOTE: Foreground-stealing protection makes reliable reproduction of
 * focus theft difficult in automated tests. These tests verify:
 *   1. The focusLost field is absent when nothing steals focus
 *   2. The trackFocus=false path skips the settle wait
 *   3. The windowTitle param triggers detection (even if no theft occurs)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { keyboardTypeHandler, keyboardPressHandler } from "../../src/tools/keyboard.js";

// ADR-038: every call in this file is deliberately destination-less — the
// no-windowTitle path IS the subject (detection is disabled without a target).
// That shape is refused by default since ADR-038, so the file opts into the
// documented downgrade. Assertions are unchanged.
let prevRequireDestination: string | undefined;
beforeAll(() => {
  prevRequireDestination = process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION;
  process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION = "0";
});
afterAll(() => {
  if (prevRequireDestination === undefined) delete process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION;
  else process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION = prevRequireDestination;
});

describe("keyboard_type focusLost", () => {
  it("succeeds and contains ok:true", async () => {
    const result = await keyboardTypeHandler({
      text: "",
      use_clipboard: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.typed).toBe(0);
  });

  it("includes method:keystroke when use_clipboard=false", async () => {
    const result = await keyboardTypeHandler({
      text: "",
      use_clipboard: false,
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.method).toBe("keystroke");
  });

  it("does not include focusLost when trackFocus=false", async () => {
    const result = await keyboardTypeHandler({
      text: "",
      use_clipboard: false,
      trackFocus: false,
      settleMs: 300,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    // Positive assertion first: `focusLost` is absent on an ERROR payload too,
    // so without this the case would pass on any failure (ADR-038 review R1).
    expect(payload.ok).toBe(true);
    expect(payload.focusLost).toBeUndefined();
  });

  it("runs focus detection without error when trackFocus=true and no windowTitle given (no-op path)", async () => {
    // No windowTitle + no homingNotes → detectFocusLoss returns null immediately
    const result = await keyboardTypeHandler({
      text: "",
      use_clipboard: false,
      trackFocus: true,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    // no-op path: focusLost is undefined
    expect(payload.focusLost).toBeUndefined();
  });
});

describe("keyboard_press focusLost", () => {
  it("succeeds with ok:true", async () => {
    // escape is a safe key that won't interfere with the test environment
    const result = await keyboardPressHandler({
      keys: "escape",
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.pressed).toBe("escape");
  });

  it("does not include focusLost when trackFocus=false", async () => {
    const result = await keyboardPressHandler({
      keys: "escape",
      trackFocus: false,
      settleMs: 300,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    // Positive assertion first — see the keyboard_type case above.
    expect(payload.ok).toBe(true);
    expect(payload.focusLost).toBeUndefined();
  });

  it("runs focus detection without error when trackFocus=true and no windowTitle given", async () => {
    const result = await keyboardPressHandler({
      keys: "escape",
      trackFocus: true,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.focusLost).toBeUndefined();
  });

  it("rejects blocked keys (win+l) with error", async () => {
    const result = await keyboardPressHandler({
      keys: "win+l",
      trackFocus: false,
      settleMs: 0,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    // Pin the reason: `ok:false` alone would also accept an unrelated refusal.
    expect(payload.code).toBe("BlockedKeyCombo");
  });
});
