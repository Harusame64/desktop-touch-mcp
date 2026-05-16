/**
 * modal-detection-browser-exclusion.test.ts — pin the browser-class
 * exclusion contract used by `desktop_state.hasModal` (see
 * `src/tools/desktop-state.ts` line ~562). A Chrome / Edge / Firefox
 * top-level window whose page title happens to match MODAL_RE (e.g.
 * Japanese "通知" / Stack Overflow "Save As" thread) is page content,
 * NOT a modal — the browser renders its own dialogs inside the tab
 * via CDP. Without this exclusion, every desktop_state call from a
 * machine with such a tab open falsely returns `hasModal: true` and
 * breaks e2e tests like `context-consistency.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { isBrowserTopLevelClass, MODAL_RE } from "../../src/tools/desktop-state.js";

describe("isBrowserTopLevelClass", () => {
  it("matches Chromium-family classes (Chrome / Edge / Brave / Vivaldi / Arc)", () => {
    expect(isBrowserTopLevelClass("Chrome_WidgetWin_1")).toBe(true);
  });

  it("matches Firefox class", () => {
    expect(isBrowserTopLevelClass("MozillaWindowClass")).toBe(true);
  });

  it("does NOT match non-browser classes", () => {
    expect(isBrowserTopLevelClass("Notepad")).toBe(false);
    expect(isBrowserTopLevelClass("#32770")).toBe(false); // standard Win32 dialog
    expect(isBrowserTopLevelClass("CASCADIA_HOSTING_WINDOW_CLASS")).toBe(false);
    expect(isBrowserTopLevelClass("ConsoleWindowClass")).toBe(false);
  });

  it("handles undefined className safely (older addon builds)", () => {
    expect(isBrowserTopLevelClass(undefined)).toBe(false);
  });
});

describe("MODAL_RE — browser-class exclusion regression", () => {
  // These titles WOULD trigger MODAL_RE if checked directly, but when they
  // appear on a Chrome_WidgetWin_1 / MozillaWindowClass top-level window
  // they must be ignored because the browser handles modals internally.
  const falsePositiveBrowserTitles = [
    "Twitter 通知 - Twitter",
    "Gmail - 通知設定 - Google",
    "Save As - Stack Overflow",
    "Error 404 - GitHub",
    "Warning: chemicals exposure - Wikipedia",
    "Confirm Delete Account - Service Settings",
    "Google Gemini - LINE通知音が出ない原因調査 - Google Gemini",
  ];

  for (const title of falsePositiveBrowserTitles) {
    it(`MODAL_RE matches "${title}" on its own (regex itself unchanged)`, () => {
      // Confirms the regex still matches — the gate is the class check,
      // not a regex change. This pins the architecture: the regex stays
      // permissive; the production heuristic excludes by class.
      expect(MODAL_RE.test(title)).toBe(true);
    });
  }
});
