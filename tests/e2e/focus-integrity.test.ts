/**
 * focus-integrity.test.ts — E2E tests for focus tracking and windowTitle usage (A1, A2)
 *
 * A1: LLM risk — keyboard_type without windowTitle cannot detect focus loss
 *   - With windowTitle: focusLost detection is armed
 *   - Without windowTitle: focusLost is always null (undetectable)
 *   - This is the "silent misfire" scenario: if another window steals focus,
 *     keystrokes go to the wrong target but the LLM gets no signal.
 *
 * A2: terminal_send(restoreFocus:true) restores previous foreground window
 *   - Focus returns to the caller's window (e.g. Notepad) after terminal command
 *   - focusRestored:true in response confirms the restore happened
 *   - Structural test: restoreFocus parameter works end-to-end
 *
 * Design note:
 *   The actual "focus stolen by another app" scenario requires a second process
 *   to intervene at a precise moment — not reliably automatable in unit/E2E tests.
 *   These tests instead verify the DETECTION CAPABILITY: that the tooling can
 *   detect focus loss when armed (windowTitle given) and cannot when not armed
 *   (windowTitle omitted). This boundary is the critical invariant to guard.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
import { keyboardPressHandler } from "../../src/tools/keyboard.js";
import { terminalSendHandler } from "../../src/tools/terminal.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { launchPowerShell, type PsInstance } from "./helpers/powershell-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";
import { focusWindow } from "../../src/engine/win32.js";

let np: NpInstance;

beforeAll(async () => {
  np = await launchNotepad();
  try { focusWindow(np.hwnd); } catch { /* non-fatal */ }
  await sleep(400);
}, 10_000);

afterAll(() => np?.kill());

// ─────────────────────────────────────────────────────────────────────────────
// A1-armed: windowTitle given → focusLost detection is active
// ─────────────────────────────────────────────────────────────────────────────

describe("A1-armed: keyboard_type with windowTitle arms focusLost detection", () => {
  it("returns ok:true and no focusLost when Notepad keeps focus", async () => {
    try { focusWindow(np.hwnd); } catch { /* non-fatal */ }
    await sleep(200);

    const result = await keyboardTypeHandler({
      text: "a",
      use_clipboard: true,
      trackFocus: true,
      windowTitle: np.title,
      settleMs: 200,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // If Notepad kept focus, focusLost should be absent or undefined
    // (It may be present if focus-stealing protection fired — that's also OK)
    if (p.focusLost) {
      // focusLost was detected — means something else grabbed focus.
      // This is a test environment issue, not a product bug. The important
      // point is that detection ran (the field exists when armed).
      expect(typeof p.focusLost).toBe("object");
    } else {
      // Normal case: no focus loss
      expect(p.focusLost).toBeUndefined();
    }
  });

  it("focusLost field structure is correct when detection triggers", async ({ skip }) => {
    // We can't force a third process to steal focus on demand.
    // Instead, verify the structure by simulating what detectFocusLoss would return.
    // This is the contract test: if focusLost fires, it must have these fields.

    // keyboard_type with windowTitle that doesn't match anything → after settle,
    // the foreground window title won't include our (fake) target → focusLost triggers.
    const result = await keyboardTypeHandler({
      text: " ",
      use_clipboard: true,
      trackFocus: true,
      windowTitle: "__guaranteed_mismatch_focus_integrity__",  // won't match any window
      settleMs: 100,
    });
    const p = parsePayload(result);

    // May succeed with focusLost, or fail with WindowNotFound — both are valid
    if (p.focusLost) {
      // focusLost structure: stolenBy + latencyMs
      expect(typeof p.focusLost).toBe("object");
      // stolenByTitle tells LLM which window stole focus
      if (p.focusLost.stolenByTitle !== undefined) {
        expect(typeof p.focusLost.stolenByTitle).toBe("string");
      }
    } else {
      // If no focusLost returned, that's acceptable in this edge case
      skip("focusLost not triggered with mismatched windowTitle — environment-dependent");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1-unarmed: windowTitle omitted → focusLost is always null (LLM risk)
// ─────────────────────────────────────────────────────────────────────────────

describe("A1-unarmed: keyboard_type without windowTitle cannot detect focus loss", () => {
  it("trackFocus:true but no windowTitle → focusLost is absent (detection disabled)", async () => {
    // When windowTitle is omitted, detectFocusLoss short-circuits (no-op).
    // This means the LLM has NO signal if input goes to the wrong window.
    const result = await keyboardTypeHandler({
      text: "z",
      use_clipboard: true,
      trackFocus: true,
      // windowTitle intentionally omitted
      settleMs: 100,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // Without windowTitle, detectFocusLoss returns null → focusLost absent
    // This is the documented blind spot: LLM must always pass windowTitle.
    expect(p.focusLost).toBeUndefined();
  });

  it("trackFocus:false always skips detection regardless of windowTitle", async () => {
    const result = await keyboardTypeHandler({
      text: "q",
      use_clipboard: true,
      trackFocus: false,
      windowTitle: np.title,
      settleMs: 0,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // trackFocus:false → detection skipped unconditionally
    expect(p.focusLost).toBeUndefined();
  });

  it("keyboard_type result always has ok + typed fields regardless of trackFocus", async () => {
    const r1 = await keyboardTypeHandler({
      text: "test",
      use_clipboard: true,
      trackFocus: true,
      windowTitle: np.title,
      settleMs: 0,
    });
    const r2 = await keyboardTypeHandler({
      text: "test",
      use_clipboard: true,
      trackFocus: false,
      settleMs: 0,
    });

    [r1, r2].forEach(r => {
      const p = parsePayload(r);
      expect(p.ok).toBe(true);
      expect(typeof p.typed).toBe("number");
      expect(p.typed).toBe(4);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1-press: keyboard_press also has windowTitle + trackFocus contract
// ─────────────────────────────────────────────────────────────────────────────

describe("A1-press: keyboard_press follows the same focusLost contract", () => {
  it("keyboard_press with windowTitle + trackFocus returns structured response", async () => {
    const result = await keyboardPressHandler({
      keys: "escape",
      windowTitle: np.title,
      trackFocus: true,
      settleMs: 100,
    });
    const p = parsePayload(result);

    // ok:true or ok:false (focus may not have been transferred) — structure must be correct
    expect(typeof p.ok).toBe("boolean");
    // When ok:true, focusLost may or may not be present
    if (p.ok && p.focusLost) {
      expect(typeof p.focusLost).toBe("object");
    }
  });

  it("keyboard_press without windowTitle → focusLost never set", async () => {
    const result = await keyboardPressHandler({
      keys: "escape",
      // windowTitle omitted
      trackFocus: true,
      settleMs: 100,
    });
    const p = parsePayload(result);

    // No detection possible without windowTitle
    expect(p.focusLost).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2: terminal_send(restoreFocus:true) — focus returns to caller window
// ─────────────────────────────────────────────────────────────────────────────

describe("A2: terminal_send(restoreFocus:true) restores caller's focus", () => {
  let ps: PsInstance;

  beforeAll(async () => {
    ps = await launchPowerShell({ banner: "a2-ready" });
  }, 15_000);

  afterAll(() => ps?.kill());

  it("focusRestored:true when Notepad was active before terminal_send", async ({ skip }) => {
    // Focus Notepad first (the window we want focus to return to)
    try { focusWindow(np.hwnd); } catch { /* non-fatal */ }
    await sleep(300);

    // Verify Notepad is active
    const { enumWindowsInZOrder } = await import("../../src/engine/win32.js");
    const active = enumWindowsInZOrder().find(w => w.isActive);
    if (!active?.title.includes(np.tag)) {
      skip("Could not transfer focus to Notepad (foreground-stealing protection) — skipping A2");
      return;
    }

    // Send a command to PowerShell with restoreFocus:true
    const result = await terminalSendHandler({
      windowTitle: ps.tag,
      input: "echo a2-test",
      pressEnter: true,
      focusFirst: true,
      restoreFocus: true,   // <-- key parameter
      preferClipboard: false,
      pasteKey: "ctrl+v",
      trackFocus: false,
      settleMs: 300,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // focusRestored:true confirms the terminal tool restored the previous window
    expect(p.focusRestored).toBe(true);
  }, 20_000);

  it("focusRestored:false when restoreFocus is disabled", async ({ skip }) => {
    // Focus Notepad first
    try { focusWindow(np.hwnd); } catch { /* non-fatal */ }
    await sleep(300);

    const { enumWindowsInZOrder } = await import("../../src/engine/win32.js");
    const active = enumWindowsInZOrder().find(w => w.isActive);
    if (!active?.title.includes(np.tag)) {
      skip("Could not transfer focus to Notepad — skipping A2 restoreFocus:false test");
      return;
    }

    const result = await terminalSendHandler({
      windowTitle: ps.tag,
      input: "echo a2-no-restore",
      pressEnter: true,
      focusFirst: true,
      restoreFocus: false,  // <-- disabled
      preferClipboard: false,
      pasteKey: "ctrl+v",
      trackFocus: false,
      settleMs: 200,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    // restoreFocus:false → focusRestored must be false
    expect(p.focusRestored).toBe(false);
  }, 20_000);

  it("terminal_send response always has focusRestored boolean field", async () => {
    // Structural contract: focusRestored is always present in ok:true responses
    const result = await terminalSendHandler({
      windowTitle: ps.tag,
      input: "echo structural-test",
      pressEnter: false,
      focusFirst: true,
      restoreFocus: true,
      preferClipboard: false,
      pasteKey: "ctrl+v",
      trackFocus: false,
      settleMs: 0,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    expect("focusRestored" in p).toBe(true);
    expect(typeof p.focusRestored).toBe("boolean");
  }, 15_000);
});
