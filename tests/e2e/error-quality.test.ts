/**
 * error-quality.test.ts — E2E tests for LLM-facing error response quality (G1–G3)
 *
 * G1: click_element on non-InvokePattern element
 *     → code:"InvokePatternNotSupported" + suggest contains "mouse_click"
 * G2: wait_until timeout
 *     → code:"WaitTimeout" + non-empty suggest[] + context.condition present
 * G3: keyboard_press blocked key (win+r)
 *     → code:"BlockedKeyCombo" + suggest contains "workspace_launch"
 *
 * Design principle: errors must carry enough signal for an LLM to pick the
 * right next action without falling back to screenshots.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { clickElementHandler } from "../../src/tools/ui-elements.js";
import { keyboardPressHandler } from "../../src/tools/keyboard.js";
import { waitUntilHandler } from "../../src/tools/wait-until.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload } from "./helpers/wait.js";

// ─────────────────────────────────────────────────────────────────────────────
// G1: InvokePattern not supported
// ─────────────────────────────────────────────────────────────────────────────

describe("G1: click_element on non-InvokePattern element → InvokePatternNotSupported", () => {
  let np: NpInstance;

  beforeAll(async () => {
    np = await launchNotepad();
  }, 10_000);

  afterAll(() => np?.kill());

  it(
    "returns InvokePatternNotSupported + suggest when clicking a status-bar Text control",
    async ({ skip }) => {
      // Win11 Notepad status bar: automationId="ContentTextBlock" on Text controls
      // (e.g. "行 1, 列 1", "0 文字").  These have no InvokePattern.
      const result = await clickElementHandler({
        windowTitle: np.title,
        automationId: "ContentTextBlock",
      });
      const p = parsePayload(result);

      if (p.ok === false && p.code === "ElementNotFound") {
        // envOnly (issue #182): G1 needs a specific Win11 Notepad fixture
        // (status-bar Text controls with automationId="ContentTextBlock").
        // Older Notepad versions / non-jp locales don't expose this id.
        // Without the fixture the InvokePatternNotSupported error path
        // can't be reached. Matrix doc §3.1 click_element row pins the
        // contract; this test just can't access the inputs.
        skip(
          "envOnly: ContentTextBlock not found — Notepad version or locale differs. " +
          "This element exists in Win11 Notepad status bar."
        );
      }

      if (p.ok) {
        // envOnly (issue #182): on this host, ContentTextBlock unexpectedly
        // exposes InvokePattern (theme/locale variant — Win11 Notepad has
        // shifted UIA exposure between feature updates). The error path
        // we want to test isn't reachable here. NOT a product bug:
        // InvokePatternNotSupported is one branch of click_element's error
        // surface; if this Notepad build supports invoke on the status
        // bar, that's a fixture mismatch, not an invariant violation.
        skip("envOnly: click_element succeeded (ContentTextBlock supports InvokePattern on this Notepad build) — G1 error path not triggered");
      }

      expect(p.ok).toBe(false);
      expect(p.code).toBe("InvokePatternNotSupported");
      expect(Array.isArray(p.suggest)).toBe(true);
      expect(p.suggest.length).toBeGreaterThan(0);
      // LLM must be directed to mouse_click as an alternative
      expect(p.suggest.some((s: string) => /mouse_click/.test(s))).toBe(true);
    },
    15_000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// G2: wait_until timeout
// ─────────────────────────────────────────────────────────────────────────────

describe("G2: wait_until timeout → WaitTimeout + suggest + context", () => {
  it("returns WaitTimeout code + non-empty suggest when window never appears", async () => {
    const result = await waitUntilHandler({
      condition: "window_appears",
      target: { windowTitle: "__no_such_window_xyz_g2_test__" },
      timeoutMs: 300,
      intervalMs: 100,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.code).toBe("WaitTimeout");
    // suggest must give the LLM recovery options (not an empty array)
    expect(Array.isArray(p.suggest)).toBe(true);
    expect(p.suggest.length).toBeGreaterThan(0);
    // Context must carry the original condition so LLM can diagnose
    expect(p.context).toBeDefined();
    expect(p.context.condition).toBe("window_appears");
  });

  it("returns WaitTimeout + context for element_appears timeout", async () => {
    const result = await waitUntilHandler({
      condition: "element_appears",
      target: {
        windowTitle: "__no_such_window_xyz_g2_test__",
        elementName: "__no_such_element__",
      },
      timeoutMs: 300,
      intervalMs: 300,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.code).toBe("WaitTimeout");
    expect(p.suggest.length).toBeGreaterThan(0);
    expect(p.context.condition).toBe("element_appears");
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// G3: keyboard_press blocked key
// ─────────────────────────────────────────────────────────────────────────────

describe("G3: keyboard_press blocked key → BlockedKeyCombo + workspace_launch suggest", () => {
  it("win+r → code:BlockedKeyCombo + suggest contains workspace_launch", async () => {
    const result = await keyboardPressHandler({
      keys: "win+r",
      trackFocus: false,
      settleMs: 0,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.code).toBe("BlockedKeyCombo");
    expect(Array.isArray(p.suggest)).toBe(true);
    expect(p.suggest.length).toBeGreaterThan(0);
    expect(p.suggest.some((s: string) => /workspace_launch/.test(s))).toBe(true);
  });

  it("win+l → code:BlockedKeyCombo (lock screen protected)", async () => {
    const result = await keyboardPressHandler({
      keys: "win+l",
      trackFocus: false,
      settleMs: 0,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.code).toBe("BlockedKeyCombo");
  });

  it("meta+x (super alias) → code:BlockedKeyCombo", async () => {
    const result = await keyboardPressHandler({
      keys: "meta+x",
      trackFocus: false,
      settleMs: 0,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.code).toBe("BlockedKeyCombo");
  });

  it("ctrl+s → allowed (not blocked)", async () => {
    // ctrl+s is safe — should not return BlockedKeyCombo.
    // The key press itself may have no visible effect without a focused window,
    // but it must NOT be blocked at the safety level.
    const result = await keyboardPressHandler({
      keys: "ctrl+s",
      trackFocus: false,
      settleMs: 0,
    });
    const p = parsePayload(result);

    // ok may be true or false (focus issues), but code must not be BlockedKeyCombo
    expect(p.code).not.toBe("BlockedKeyCombo");
  });
});
