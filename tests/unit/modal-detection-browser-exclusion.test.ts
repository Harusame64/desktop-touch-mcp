/**
 * modal-detection-browser-exclusion.test.ts — pin the
 * (class × process-name) double-gate used by `desktop_state.hasModal`
 * (see `src/tools/desktop-state.ts` line ~599). Both axes must match for
 * exclusion to fire, so Electron / CEF apps (VS Code, Discord, Slack,
 * Cursor, Claude Desktop, Obsidian, …) that ALSO use the Chromium widget
 * class continue to raise `hasModal: true` when their modal title matches
 * MODAL_RE (Codex P1 review on PR #324).
 *
 * The false-positive being suppressed: a real-browser tab whose page title
 * happens to contain "通知" / "Save As" / "Error" / "警告" etc. is page
 * content, NOT a modal. Browsers render their own dialogs inside the tab
 * via CDP; the top-level window is the tab itself.
 */

import { describe, it, expect } from "vitest";
import {
  isBrowserTopLevelClass,
  isBrowserProcessName,
  MODAL_RE,
} from "../../src/tools/desktop-state.js";

describe("isBrowserTopLevelClass", () => {
  it("matches Chromium-family widget class (Chrome / Edge / Brave / Vivaldi / Arc / + Electron / CEF)", () => {
    // Chromium widget class is SHARED with every Electron / CEF app — the
    // helper just identifies the class family. Exclusion also requires the
    // process-name gate below.
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

describe("isBrowserProcessName", () => {
  it("matches Chromium-engine real browsers (case-insensitive)", () => {
    expect(isBrowserProcessName("chrome")).toBe(true);
    expect(isBrowserProcessName("CHROME")).toBe(true); // case-insensitive
    expect(isBrowserProcessName("msedge")).toBe(true);
    expect(isBrowserProcessName("brave")).toBe(true);
    expect(isBrowserProcessName("opera")).toBe(true);
    expect(isBrowserProcessName("vivaldi")).toBe(true);
    expect(isBrowserProcessName("arc")).toBe(true);
    expect(isBrowserProcessName("thorium")).toBe(true);
  });

  it("matches Gecko-engine browsers", () => {
    expect(isBrowserProcessName("firefox")).toBe(true);
    expect(isBrowserProcessName("waterfox")).toBe(true);
    expect(isBrowserProcessName("librewolf")).toBe(true);
  });

  it("does NOT match Electron / CEF apps (Codex P1 regression guard)", () => {
    // These apps share `Chrome_WidgetWin_1` but their modal titles ARE
    // legitimate modals — `hasModal` MUST still raise true for them.
    expect(isBrowserProcessName("Code")).toBe(false); // VS Code
    expect(isBrowserProcessName("code")).toBe(false); // lowercase variant
    expect(isBrowserProcessName("Discord")).toBe(false);
    expect(isBrowserProcessName("Slack")).toBe(false);
    expect(isBrowserProcessName("Cursor")).toBe(false);
    expect(isBrowserProcessName("Claude")).toBe(false);
    expect(isBrowserProcessName("Obsidian")).toBe(false);
    expect(isBrowserProcessName("Notion")).toBe(false);
    expect(isBrowserProcessName("Atom")).toBe(false);
  });

  it("does NOT match unrelated apps", () => {
    expect(isBrowserProcessName("notepad")).toBe(false);
    expect(isBrowserProcessName("powershell")).toBe(false);
    expect(isBrowserProcessName("explorer")).toBe(false);
  });

  it("handles empty string and undefined safely (lookup failure)", () => {
    // `getProcessIdentityByPid` returns `processName: ""` on lookup failure
    // — must NOT treat empty as a browser (errs toward keeping `hasModal`
    // honest rather than over-suppressing).
    expect(isBrowserProcessName("")).toBe(false);
    expect(isBrowserProcessName(undefined)).toBe(false);
  });
});

describe("MODAL_RE — false-positive titles regex still matches (gate is class × process)", () => {
  // These titles WOULD trigger MODAL_RE if checked directly, but when they
  // appear on a (Chrome_WidgetWin_1 × `chrome`) or (MozillaWindowClass ×
  // `firefox`) window the production logic suppresses them. The regex
  // itself stays permissive — exclusion happens at the loop level.
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
      expect(MODAL_RE.test(title)).toBe(true);
    });
  }
});
