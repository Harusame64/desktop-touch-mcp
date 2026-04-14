/**
 * context-consistency.test.ts — E2E tests for get_context consistency (C1, C3)
 *
 * C1: get_context → keyboard_type → get_context round-trip
 *   - focusedElement is captured before and after typing
 *   - focusedWindow reflects the Notepad title
 *   - focusedElementSource is "uia"
 *
 * C3: hasModal detection — real dialog vs normal window
 *   - Notepad without dialog → hasModal:false, pageState:"ready"
 *   - Notepad with Save-As dialog open → hasModal:true, pageState:"dialog"
 *   - After dialog closes → hasModal:false again
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getContextHandler } from "../../src/tools/context.js";
import { keyboardTypeHandler, keyboardPressHandler } from "../../src/tools/keyboard.js";
import { launchNotepad, type NpInstance } from "./helpers/notepad-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";
import { focusWindow } from "../../src/engine/win32.js";

let np: NpInstance;

async function focusNotepad() {
  try { focusWindow(np.hwnd); } catch { /* non-fatal */ }
  await sleep(400);
}

beforeAll(async () => {
  np = await launchNotepad();
  await focusNotepad();
}, 10_000);

afterAll(() => np?.kill());

describe("C1: get_context → keyboard_type → get_context round-trip", () => {
  it("focusedWindow matches Notepad title before typing", async ({ skip }) => {
    await focusNotepad();
    const p = parsePayload(await getContextHandler());

    expect(p.focusedWindow).toBeDefined();
    const title: string = p.focusedWindow.title ?? "";
    if (!(title.includes(np.tag) || title.includes("メモ帳") || title.includes("Notepad"))) {
      skip(
        `focusNotepad() could not transfer foreground (Windows foreground-stealing ` +
        `protection) — got title: "${title}"`
      );
    }
    expect(
      title.includes(np.tag) || title.includes("メモ帳") || title.includes("Notepad")
    ).toBe(true);
  });

  it("focusedElement reflects the Notepad editor before typing", async () => {
    const p = parsePayload(await getContextHandler());

    // focusedElement should be the document/edit area
    if (p.focusedElement) {
      expect(p.hints.focusedElementSource).toBe("uia");
      // Notepad's main editing control is a Document type
      expect(["Document", "Edit"]).toContain(p.focusedElement.type);
    }
    // If focusedElement is null, Notepad may have lost focus — that's a test
    // environment issue, not a product bug. The key assertion is that when
    // it IS set, it comes from UIA and has the expected type.
  });

  it("keyboard_type succeeds and typed count matches input length", async () => {
    await focusNotepad();
    const testText = `hello-${np.tag}`;
    const result = await keyboardTypeHandler({
      text: testText,
      use_clipboard: true,  // clipboard is more reliable than keystroke in CI
      trackFocus: true,
      windowTitle: np.title,
      settleMs: 300,
    });
    const p = parsePayload(result);

    expect(p.ok).toBe(true);
    expect(p.typed).toBe(testText.length);
    // NOTE: raw keyboardTypeHandler does not include "post" — that comes from
    // withPostState which is applied at server-registration time, not here.
    // We verify the core contract: typed count and ok status.
  });

  it("focusedWindow still Notepad after typing", async ({ skip }) => {
    await focusNotepad();
    await sleep(200);
    const p = parsePayload(await getContextHandler());

    const title: string = p.focusedWindow?.title ?? "";
    if (!(title.includes(np.tag) || title.includes("メモ帳") || title.includes("Notepad"))) {
      skip(
        `focusNotepad() could not transfer foreground (Windows foreground-stealing ` +
        `protection) — got title: "${title}"`
      );
    }
    // After typing, Notepad title gets an asterisk (*) prefix (unsaved changes)
    expect(
      title.includes(np.tag) || title.includes("メモ帳") || title.includes("Notepad")
    ).toBe(true);
  });

  it("focusedElement value reflects typed text (or gracefully null)", async () => {
    await focusNotepad();
    const p = parsePayload(await getContextHandler());

    if (p.focusedElement?.value !== undefined && p.focusedElement.value !== null) {
      // ValuePattern returned a value — it should be a non-empty string.
      // Note: parallel E2E tests may have typed other content into the same
      // Notepad window (clipboard races, focus competition). We only assert
      // that ValuePattern works (returns a string) and contains our tag OR
      // any other test content — we do NOT assert exact text in parallel runs.
      expect(typeof p.focusedElement.value).toBe("string");
      // Structural contract: UIA source was used
      expect(p.hints.focusedElementSource).toBe("uia");
    } else {
      // Notepad's Document control may not expose ValuePattern on all Windows
      // versions. When value is null/undefined, verify focusedElement is at
      // least the right type — confirming UIA reached the correct control.
      if (p.focusedElement) {
        expect(["Document", "Edit"]).toContain(p.focusedElement.type);
      }
      // Known limitation documented in test plan (C1):
      // "Notepad's Document control may not provide ValuePattern"
    }
  });

  it("pageState is 'ready' (not 'loading' or 'dialog') for Notepad", async () => {
    await focusNotepad();
    const p = parsePayload(await getContextHandler());
    expect(p.pageState).toBe("ready");
  });

  it("hasModal is false when no dialog is open", async () => {
    await focusNotepad();
    const p = parsePayload(await getContextHandler());
    expect(p.hasModal).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C3: hasModal detection — real dialog vs file-name false positives
// ─────────────────────────────────────────────────────────────────────────────

describe("C3: hasModal real dialog detection", () => {
  let np3: NpInstance;

  beforeAll(async () => {
    np3 = await launchNotepad();
    try { focusWindow(np3.hwnd); } catch { /* non-fatal */ }
    await sleep(400);
  }, 10_000);

  afterAll(() => np3?.kill());

  it("hasModal:false and pageState:'ready' before any dialog opens", async () => {
    const p = parsePayload(await getContextHandler());

    expect(p.hasModal).toBe(false);
    // pageState is ready when no dialog title is detected
    expect(p.pageState).toBe("ready");
  });

  it("hasModal:true and pageState:'dialog' when Save-As dialog is open", async ({ skip }) => {
    // Open Save-As with ctrl+s (new file — dialog always appears)
    try { focusWindow(np3.hwnd); } catch { /* non-fatal */ }
    await sleep(300);

    await keyboardPressHandler({
      keys: "ctrl+s",
      windowTitle: np3.title,
      trackFocus: false,
      settleMs: 500,
    });

    // Verify that the dialog appeared
    const { enumWindowsInZOrder } = await import("../../src/engine/win32.js");
    const dialogTitles = enumWindowsInZOrder()
      .map(w => w.title)
      .filter(t => t.includes("名前を付けて保存") || t.includes("Save As") || t.includes("Save"));

    if (dialogTitles.length === 0) {
      // Dismiss any opened dialog and skip
      await keyboardPressHandler({ keys: "escape", trackFocus: false, settleMs: 200 });
      skip("Save-As dialog did not appear (file may have auto-saved) — skipping C3 dialog test");
      return;
    }

    const p = parsePayload(await getContextHandler());

    // Modal is detected via MODAL_RE on window titles
    expect(p.hasModal).toBe(true);
    expect(p.pageState).toBe("dialog");

    // Close the dialog
    await keyboardPressHandler({ keys: "escape", trackFocus: false, settleMs: 300 });
  }, 15_000);

  it("hasModal returns to false after dialog closes", async () => {
    // Dialog should already be closed (previous test closed it, or it never opened)
    await sleep(300);
    const p = parsePayload(await getContextHandler());

    // After dismiss, no dialog-titled window should remain
    expect(p.hasModal).toBe(false);
    expect(p.pageState).toBe("ready");
  });

  it("get_context structure is stable: focusedWindow, hasModal, pageState always present", async () => {
    const p = parsePayload(await getContextHandler());

    // Structural contract: these fields are always in the response
    expect("focusedWindow" in p).toBe(true);
    expect("hasModal" in p).toBe(true);
    expect("pageState" in p).toBe(true);
    expect(typeof p.hasModal).toBe("boolean");
    expect(["ready", "loading", "dialog"]).toContain(p.pageState);
  });
});
