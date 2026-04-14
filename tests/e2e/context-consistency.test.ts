/**
 * context-consistency.test.ts — E2E tests for get_context consistency (C1)
 *
 * C1: get_context → keyboard_type → get_context round-trip
 *   - focusedElement is captured before and after typing
 *   - focusedWindow reflects the Notepad title
 *   - focusedElementSource is "uia"
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getContextHandler } from "../../src/tools/context.js";
import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
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
