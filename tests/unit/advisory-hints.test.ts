/**
 * tests/unit/advisory-hints.test.ts
 * ADR-022 / issue #352 — success-path advisory builder (`_advisory.ts`).
 *
 * Pure builder over the focused-element snapshot withPostState already captures
 * + the focused window's processName. No UIA, no timers — fully deterministic.
 * Gate (ADR-022 dogfood): keyboard(type) + Edit/Document + value + NOT a browser
 * process + automationId !== RootWebArea.
 */

import { describe, it, expect } from "vitest";
import { maybeAdvisory, getAdvisoryEmitCount } from "../../src/tools/_advisory.js";
import type { PostElementInfo } from "../../src/tools/_post.js";

const edit = (value: string | undefined = "existing"): PostElementInfo => ({
  name: "Text Editor",
  type: "Edit",
  ...(value !== undefined ? { value } : {}),
});

// A non-browser process so the browser-suppression gate is not the thing under test.
const NATIVE = "notepad";

describe("maybeAdvisory — keyboard(type) → desktop_act", () => {
  it("emits for a focused UIA Edit (ValuePattern) with the windowTitle + text bound", () => {
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "メモ帳", text: "hello" },
      edit(),
      NATIVE,
    );
    expect(hint).not.toBeNull();
    expect(hint!.preferredPath).toBe("desktop_act");
    expect(hint!.example).toContain("windowTitle:'メモ帳'");
    expect(hint!.example).toContain("text:'hello'");
    expect(hint!.example).toContain("desktop_discover");
    expect(hint!.example).toContain("desktop_act");
  });

  it("emits for a Document control type too", () => {
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "Word", text: "x" },
      { name: "Doc", type: "Document", value: "" },
      "winword",
    );
    expect(hint).not.toBeNull();
  });

  it("falls back to focused:true when no windowTitle, and text:'…' when no text", () => {
    const hint = maybeAdvisory("keyboard", { action: "type" }, edit(), NATIVE);
    expect(hint).not.toBeNull();
    expect(hint!.example).toContain("focused:true");
    expect(hint!.example).toContain("text:'…'");
  });

  it("truncates long text and sanitises quotes/newlines/backslashes in the example", () => {
    const longText = "a".repeat(50) + "'b\nc\\d";
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "x", text: longText },
      edit(),
      NATIVE,
    );
    expect(hint).not.toBeNull();
    expect(hint!.example).toContain("…");
    expect(hint!.example).not.toMatch(/\n/);
  });
});

describe("maybeAdvisory — unnamed text input (#352 follow-up, ADR-022 §5.5)", () => {
  // The gate is NAME-AGNOSTIC (it checks type / value / automationId / process,
  // never name). The Round-1 under-fire was upstream — the bridge dropped
  // name-empty rows before they reached this gate. This pins that an unnamed Edit
  // that DOES reach the gate fires, so the upstream relax (includeUnnamed) is the
  // only thing needed to widen coverage to unlabeled inputs.
  it("fires for an unnamed Edit with value:'' (empty string = ValuePattern PRESENT)", () => {
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "App", text: "x" },
      { name: "", type: "Edit", value: "" }, // name-empty editable, ValuePattern exposed
      NATIVE,
    );
    expect(hint).not.toBeNull();
    expect(hint!.preferredPath).toBe("desktop_act");
  });

  it("does NOT fire for an unnamed Edit with value ABSENT (undefined = no ValuePattern)", () => {
    // Guard against conflating value:'' (fires) with value missing (drops). The
    // gate is `value === undefined` (_advisory.ts) — empty string passes, absent drops.
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", text: "x" },
      { name: "", type: "Edit" }, // no `value` field at all
      NATIVE,
    );
    expect(hint).toBeNull();
  });
});

describe("maybeAdvisory — suppression (no hint)", () => {
  it("returns null when the focused element is not a text input (UIA-blind / wrong control)", () => {
    expect(
      maybeAdvisory("keyboard", { action: "type", text: "x" }, { name: "Canvas", type: "Pane", value: "" }, NATIVE),
    ).toBeNull();
  });

  it("returns null when the focused element exposes no value (no ValuePattern)", () => {
    // An Edit with NO `value` field = UIA did not expose ValuePattern → suppress.
    expect(
      maybeAdvisory("keyboard", { action: "type", text: "x" }, { name: "Text Editor", type: "Edit" }, NATIVE),
    ).toBeNull();
  });

  it("returns null for a Chromium web-area root (Document + value=URL + RootWebArea automationId)", () => {
    // dogfood: a browser's focused element is Document+value(URL)+RootWebArea — a
    // wrong desktop_act nudge. Suppressed even with a non-browser processName.
    expect(
      maybeAdvisory(
        "keyboard",
        { action: "type", text: "x" },
        { name: "ホーム / X", type: "Document", value: "https://x.com/home", automationId: "RootWebArea" },
        NATIVE,
      ),
    ).toBeNull();
  });

  it("returns null when the focused window is a browser (web content uses browser_*, not desktop_act)", () => {
    // Even an Edit-typed web input inside a browser must not be nudged to desktop_act.
    for (const proc of ["chrome", "msedge", "chrome.exe", "MSEDGE", "brave"]) {
      expect(
        maybeAdvisory("keyboard", { action: "type", text: "x" }, edit(), proc),
      ).toBeNull();
    }
  });

  it("returns null when there is no focused element", () => {
    expect(maybeAdvisory("keyboard", { action: "type", text: "x" }, null, NATIVE)).toBeNull();
  });

  it("returns null for a non-type keyboard action", () => {
    expect(maybeAdvisory("keyboard", { action: "press", keys: "enter" }, edit(), NATIVE)).toBeNull();
  });

  it("returns null for a different tool", () => {
    expect(maybeAdvisory("mouse_click", { action: "type", text: "x" }, edit(), NATIVE)).toBeNull();
  });
});

describe("getAdvisoryEmitCount", () => {
  it("increments on a hit and not on a miss", () => {
    const before = getAdvisoryEmitCount();
    maybeAdvisory("keyboard", { action: "type", text: "x" }, edit(), NATIVE); // hit
    maybeAdvisory("keyboard", { action: "type", text: "x" }, null, NATIVE); // miss
    maybeAdvisory("keyboard", { action: "type", text: "x" }, edit(), "chrome"); // miss (browser)
    maybeAdvisory("mouse_click", {}, edit(), NATIVE); // miss
    expect(getAdvisoryEmitCount()).toBe(before + 1);
  });
});
