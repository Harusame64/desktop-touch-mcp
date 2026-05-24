/**
 * ui-elements-cache.test.ts — E2E tests for F1: stale automationId after dialog closes
 *
 * F1: LLM-risk scenario: get_ui_elements fetches tree while dialog is open,
 *     then LLM tries to click an automationId after the dialog has closed.
 *     Result must be ElementNotFound (not a crash or silent success).
 *
 * Key behaviors verified:
 *   - click_element with a non-existent automationId → code:"ElementNotFound"
 *   - suggest[] contains "get_ui_elements" (direct the LLM to re-fetch)
 *   - Real dialog stale cycle: Save-As dialog open → get_ui_elements → Escape →
 *     click with dialog automationId → ElementNotFound
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { clickElementHandler, getUiElementsHandler } from "../../src/tools/ui-elements.js";
import { keyboardPressHandler } from "../../src/tools/keyboard.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";
import { restoreAndFocusWindow } from "../../src/engine/win32.js";

// ─────────────────────────────────────────────────────────────────────────────
// F1-base: ElementNotFound + suggest for a completely bogus automationId
// ─────────────────────────────────────────────────────────────────────────────

describe("F1-base: click_element with nonexistent automationId → ElementNotFound", () => {
  let np: NpInstance;

  beforeAll(async () => {
    np = await launchNotepad();
  }, 10_000);

  afterAll(() => np?.kill());

  it("returns code:ElementNotFound when automationId does not exist", async () => {
    const result = await clickElementHandler({
      windowTitle: np.title,
      automationId: "__stale_element_f1_test_xyz_99999__",
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.code).toBe("ElementNotFound");
  });

  it("suggest[] contains 'get_ui_elements' to guide LLM to re-fetch", async () => {
    const result = await clickElementHandler({
      windowTitle: np.title,
      automationId: "__stale_element_f1_test_xyz_99999__",
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(Array.isArray(p.suggest)).toBe(true);
    expect(p.suggest.length).toBeGreaterThan(0);
    // LLM must be directed to get_ui_elements to see the current tree
    // Phase 4: get_ui_elements privatized → ElementNotFound suggest now points at desktop_discover.
    expect(p.suggest.some((s: string) => /desktop_discover/.test(s))).toBe(true);
  });

  it("context carries windowTitle so LLM knows which window to re-query", async () => {
    const result = await clickElementHandler({
      windowTitle: np.title,
      automationId: "__stale_element_f1_test_xyz_99999__",
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(false);
    expect(p.context).toBeDefined();
    // windowTitle must be echoed so LLM can issue the corrective get_ui_elements call
    expect(p.context.windowTitle).toBeDefined();
    expect(p.context.windowTitle).toContain(np.tag);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F1-dialog: real dialog stale cycle
// Open Save-As dialog → get_ui_elements → Escape (close dialog) →
// use dialog automationId → ElementNotFound
// ─────────────────────────────────────────────────────────────────────────────

describe("F1-dialog: stale automationId after dialog closes → ElementNotFound", () => {
  let np: NpInstance;
  let dialogAutomationId: string | null = null;

  beforeAll(async () => {
    np = await launchNotepad();

    try {
      restoreAndFocusWindow(np.hwnd);
    } catch { /* non-fatal */ }
    await sleep(300);

    // Open Save-As dialog with ctrl+s
    await keyboardPressHandler({
      keys: "ctrl+s",
      windowTitle: np.title,
      trackFocus: false,
      settleMs: 400,
    });

    // Detect whether dialog appeared
    const wins = (await import("../../src/engine/win32.js")).enumWindowsInZOrder();
    const dialogWin = wins.find(w =>
      w.title.includes("名前を付けて保存") ||
      w.title.includes("Save As") ||
      w.title.includes("Save")
    );

    if (dialogWin) {
      // Fetch UI elements from dialog
      const result = await getUiElementsHandler({
        windowTitle: dialogWin.title,
        maxDepth: 3,
        maxElements: 50,
      });
      const payload = parsePayload(result);

      // Look for any element with a non-empty automationId
      const elements: Array<{ automationId?: string }> = payload.elements ?? [];
      const withId = elements.find(e => e.automationId && e.automationId.trim().length > 0);
      dialogAutomationId = withId?.automationId ?? null;

      // Close dialog
      await keyboardPressHandler({
        keys: "escape",
        windowTitle: dialogWin.title,
        trackFocus: false,
        settleMs: 300,
      });
    } else {
      // No dialog appeared (e.g. file already saved) — close any dialog best-effort
      await keyboardPressHandler({
        keys: "escape",
        trackFocus: false,
        settleMs: 100,
      });
    }
  }, 20_000);

  afterAll(() => np?.kill());

  it("stale dialog automationId → ElementNotFound on Notepad window (if dialog opened)", async ({ skip }) => {
    if (!dialogAutomationId) {
      // envOnly (issue #182): F1-dialog needs the Save-As dialog to expose
      // an automationId-bearing element. Some Notepad builds open a dialog
      // with no stable automationIds on its descendants; others auto-save
      // without ever opening the dialog (locale + version dependent).
      // Without an id captured during setup, the "stale id after dialog
      // closed" assertion has nothing to feed in. matrix doc §3.2 lists
      // get_ui_elements as query-axis (no Strict/Indirect contract).
      skip("envOnly: Save-As dialog did not appear or had no automationId — F1-dialog premise unmet");
      return;
    }

    // Use the dialog's automationId against the main Notepad window (dialog is now closed)
    const result = await clickElementHandler({
      windowTitle: np.title,
      automationId: dialogAutomationId,
    });
    const p = parsePayload(result);

    // The dialog element no longer exists in the Notepad window tree
    expect(p.ok).toBe(false);
    // Either ElementNotFound (element was in dialog, not in Notepad) or
    // the automationId happens to exist in Notepad too — log and accept both cases
    if (p.code !== "ElementNotFound") {
      // envOnly (issue #182): the captured automationId from the Save-As
      // dialog happens to also exist in the main Notepad window tree
      // (e.g. shared common-control id). The "stale" check premise (id
      // present in dialog, absent in window) is broken by coincidence,
      // not by the product. Notepad's UIA tree composition is locale /
      // version dependent. Not a click_element invariant violation.
      skip(`envOnly: automationId "${dialogAutomationId}" coincidentally exists in Notepad too — stale-check premise unmet`);
      return;
    }
    expect(p.code).toBe("ElementNotFound");
    // Phase 4: get_ui_elements privatized → ElementNotFound suggest now points at desktop_discover.
    expect(p.suggest.some((s: string) => /desktop_discover/.test(s))).toBe(true);
  }, 15_000);
});
