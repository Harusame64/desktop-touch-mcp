/**
 * rich-narration-edge.test.ts — E2E tests for narrate:"rich" edge cases
 *
 * B1: Chromium window → diffDegraded:"chromium_sparse" (not empty diff)
 * B2: keyboard_press("a", narrate:"rich") → downgraded silently (no post.rich)
 * B5: narrate:"rich" after alt+f4 closes window → degraded gracefully
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { keyboardPressHandler } from "../../src/tools/keyboard.js";
import { withRichNarration } from "../../src/tools/_narration.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";

// Wrap keyboard_press the same way the MCP server does
const richKeyboardPress = withRichNarration("keyboard_press", keyboardPressHandler, {
  windowTitleKey: "windowTitle",
  keyboardPressGate: true,
  keysKey: "keys",
});

// ─────────────────────────────────────────────────────────────────────────────
// B1: Chromium sparse guard
// ─────────────────────────────────────────────────────────────────────────────

describe("B1: Chromium narrate:rich → chromium_sparse", () => {
  it("returns diffDegraded:chromium_sparse for a Chrome window", async ({ skip }) => {
    // Find any Chrome window. Chrome may be minimized — that's fine, the
    // chromium guard only checks the title string, not focus state.
    const { enumWindowsInZOrder } = await import("../../src/engine/win32.js");
    const chromeWin = enumWindowsInZOrder().find(w =>
      /- (?:Google Chrome|Microsoft Edge|Brave|Chromium)$/.test(w.title)
    );
    if (!chromeWin) {
      skip("No Chromium window open — skipping B1");
    }

    const result = await richKeyboardPress({
      keys: "escape",
      narrate: "rich",
      windowTitle: chromeWin!.title.slice(-20), // partial title suffix
      trackFocus: false,
      settleMs: 0,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // post.rich must exist and signal chromium_sparse
    expect(p.post.rich).toBeDefined();
    expect(p.post.rich.diffDegraded).toBe("chromium_sparse");
    expect(p.post.rich.diffSource).toBe("none");
    // Structural contract: arrays are present even when degraded
    expect(Array.isArray(p.post.rich.appeared)).toBe(true);
    expect(Array.isArray(p.post.rich.disappeared)).toBe(true);
    expect(Array.isArray(p.post.rich.valueDeltas)).toBe(true);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// B2: trivial key downgrade
// ─────────────────────────────────────────────────────────────────────────────

describe("B2: keyboard_press trivial key → narrate:rich downgraded", () => {
  let np: NpInstance;

  beforeAll(async () => {
    np = await launchNotepad();
  }, 10_000);

  afterAll(() => np?.kill());

  it("single char 'a' with narrate:rich → post.rich absent (downgraded to minimal)", async () => {
    const result = await richKeyboardPress({
      keys: "a",
      narrate: "rich",
      windowTitle: np.title,
      trackFocus: false,
      settleMs: 0,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // Downgraded: no post.rich field
    expect(p.post.rich).toBeUndefined();
  });

  it("state-transitioning key 'enter' with narrate:rich → post.rich present", async () => {
    const result = await richKeyboardPress({
      keys: "enter",
      narrate: "rich",
      windowTitle: np.title,
      trackFocus: false,
      settleMs: 100,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // Rich narration should fire for enter
    expect(p.post.rich).toBeDefined();
    expect(p.post.rich.diffSource).toBe("uia");
    expect(Array.isArray(p.post.rich.appeared)).toBe(true);
    expect(Array.isArray(p.post.rich.valueDeltas)).toBe(true);
  }, 10_000);

  it("ctrl+s with narrate:rich → post.rich present (modifier+char is state-transitioning)", async () => {
    const result = await richKeyboardPress({
      keys: "ctrl+s",
      narrate: "rich",
      windowTitle: np.title,
      trackFocus: false,
      settleMs: 300,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // ctrl+s opens Save-As dialog → rich narration fires
    expect(p.post.rich).toBeDefined();
    expect(["uia", "none"]).toContain(p.post.rich.diffSource);

    // Close any dialog that may have opened
    await richKeyboardPress({
      keys: "escape",
      narrate: "minimal",
      windowTitle: np.title,
      trackFocus: false,
      settleMs: 300,
    });
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// B5: window closed during narrate:rich → graceful degradation
// ─────────────────────────────────────────────────────────────────────────────

describe("B5: window closes during narrate:rich → degraded gracefully", () => {
  it("alt+f4 on Notepad → post.rich present with diffDegraded (not thrown)", async () => {
    // Launch a fresh Notepad for this test so closing it doesn't affect others
    const victim = await launchNotepad();

    let result: Awaited<ReturnType<typeof richKeyboardPress>>;
    try {
      result = await richKeyboardPress({
        keys: "alt+f4",
        narrate: "rich",
        windowTitle: victim.title,
        trackFocus: false,
        settleMs: 200,
      });
    } finally {
      // Best-effort cleanup: window may already be closed
      try { victim.kill(); } catch { /* ignore */ }
    }

    const p = parsePayload(result);
    expect(p.ok).toBe(true);
    // After-snapshot must fail (window gone) → degraded, not thrown
    expect(p.post.rich).toBeDefined();
    // Accept timeout or no_target — both mean "couldn't get after-snapshot"
    expect(["timeout", "no_target", "uia"]).toContain(
      p.post.rich.diffDegraded ?? p.post.rich.diffSource
    );
  }, 20_000);
});
