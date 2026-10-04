/**
 * tests/unit/advisory-hints.test.ts
 * ADR-022 / issue #352 — success-path advisory builder (`_advisory.ts`).
 *
 * Pure builder over the focused-element snapshot withPostState already captures
 * + the focused window's processName. No UIA, no timers — fully deterministic.
 * Gate (ADR-022 dogfood): keyboard(type) + Edit/Document + hasValuePattern + NOT a browser
 * process + automationId !== RootWebArea. The post carries whether there is a value,
 * never the value (ADR-036, option c).
 */

import { describe, it, expect } from "vitest";
import { maybeAdvisory, getAdvisoryEmitCount } from "../../src/tools/_advisory.js";
import type { PostElementInfo } from "../../src/tools/_post.js";

const edit = (): PostElementInfo => ({ name: "Text Editor", type: "Edit", hasValuePattern: true });

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
    expect(hint!.preferredPath).toBe("desktop_act (only to replace the whole value)");
    expect(hint!.example).toContain("windowTitle:'メモ帳'");
    // llm22 F16: the example sets the WHOLE value; 'hello' alone would replace the document.
    expect(hint!.example).toContain("action:'setValue'");
    expect(hint!.reason).toContain("as 'hello' just was");
    expect(hint!.example).toContain("desktop_discover");
    expect(hint!.example).toContain("desktop_act");
  });

  it("emits for a Document control type too", () => {
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "Word", text: "x" },
      { name: "Doc", type: "Document", hasValuePattern: true },
      "winword",
    );
    expect(hint).not.toBeNull();
  });

  it("omits the target when there is no windowTitle or hwnd, and text:'…' when no text", () => {
    const hint = maybeAdvisory("keyboard", { action: "type" }, edit(), NATIVE);
    expect(hint).not.toBeNull();
    // desktop_discover's target takes windowTitle / hwnd / tabId only (internal #211 item 4)
    expect(hint!.example).toContain("desktop_discover({})");
    expect(hint!.example).not.toContain("focused");
    expect(hint!.example).toContain("text:'<the whole new value>'");
  });

  it("uses the hwnd the caller addressed, ahead of windowTitle as keyboard does", () => {
    const hint = maybeAdvisory("keyboard", { action: "type", hwnd: "723210" }, edit(), NATIVE);
    expect(hint).not.toBeNull();
    expect(hint!.example).toContain("desktop_discover({target:{hwnd:'723210'}})");
    const both = maybeAdvisory("keyboard", { action: "type", windowTitle: "メモ", hwnd: "723210" }, edit(), NATIVE);
    expect(both!.example).toContain("desktop_discover({target:{hwnd:'723210'}})");
    expect(both!.example).not.toContain("windowTitle");
  });

  it("truncates long text and sanitises quotes/newlines/backslashes where the hint quotes it", () => {
    const longText = "a".repeat(50) + "'b\nc\\d";
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "x", text: longText },
      edit(),
      NATIVE,
    );
    expect(hint).not.toBeNull();
    // llm22 F16: the typed text is quoted in the reason now, never in the example's value slot.
    expect(hint!.reason).toContain("…");
    expect(hint!.reason).not.toMatch(/\n/);
    expect(hint!.example).not.toContain("aaaa");
  });
});

describe("maybeAdvisory — unnamed text input (#352 follow-up, ADR-022 §5.5)", () => {
  // The gate is NAME-AGNOSTIC (it checks type / value / automationId / process,
  // never name). The Round-1 under-fire was upstream — the bridge dropped
  // name-empty rows before they reached this gate. This pins that an unnamed Edit
  // that DOES reach the gate fires, so the upstream relax (includeUnnamed) is the
  // only thing needed to widen coverage to unlabeled inputs.
  it("fires for an unnamed Edit with hasValuePattern:true (an empty value still counts as ValuePattern PRESENT)", () => {
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "App", text: "x" },
      { name: "", type: "Edit", hasValuePattern: true }, // name-empty editable, ValuePattern exposed
      NATIVE,
    );
    expect(hint).not.toBeNull();
    expect(hint!.preferredPath).toBe("desktop_act (only to replace the whole value)");
  });

  it("does NOT fire for an unnamed Edit with hasValuePattern:false (no ValuePattern)", () => {
    // The post carries whether there is a value, not the value (ADR-036, option c); `_post.ts`
    // sets it from UIA's `value != null`, so an empty value is `true` and an absent one `false`.
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", text: "x" },
      { name: "", type: "Edit", hasValuePattern: false },
      NATIVE,
    );
    expect(hint).toBeNull();
  });
});

describe("maybeAdvisory — suppression (no hint)", () => {
  it("returns null when the focused element is not a text input (UIA-blind / wrong control)", () => {
    expect(
      maybeAdvisory("keyboard", { action: "type", text: "x" }, { name: "Canvas", type: "Pane", hasValuePattern: true }, NATIVE),
    ).toBeNull();
  });

  it("returns null when the focused element exposes no value (no ValuePattern)", () => {
    // An Edit with hasValuePattern:false = UIA did not expose ValuePattern → suppress.
    expect(
      maybeAdvisory("keyboard", { action: "type", text: "x" }, { name: "Text Editor", type: "Edit", hasValuePattern: false }, NATIVE),
    ).toBeNull();
  });

  it("returns null for a Chromium web-area root (Document + value=URL + RootWebArea automationId)", () => {
    // dogfood: a browser's focused element is Document+value(URL)+RootWebArea — a
    // wrong desktop_act nudge. Suppressed even with a non-browser processName.
    expect(
      maybeAdvisory(
        "keyboard",
        { action: "type", text: "x" },
        { name: "ホーム / X", type: "Document", hasValuePattern: true, automationId: "RootWebArea" },
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

// llm22 drive F16 (win2, 2026-10-04, P1): an agent that had appended at the caret with keyboard:type
// followed this hint's example, desktop_act({action:'type'}), and the UI Automation type replaced the
// whole document. The hint says the road replaces, keeps keyboard for typing at the caret, and its
// example never asks for a bare type of the fragment.
describe("the keyboard → desktop_act hint does not lead an append into a replace (llm22 F16)", () => {
  it("says desktop_act's type replaces the whole field, and that keyboard stays the road at the caret", () => {
    const hint = maybeAdvisory("keyboard", { action: "type", windowTitle: "メモ帳", text: " +kbd" }, edit(), NATIVE);
    expect(hint).not.toBeNull();
    expect(hint!.reason).toMatch(/executor 'uia'\) REPLACES everything in the field/);
    expect(hint!.reason).toMatch(/executor 'keyboard'\) is the text inserted at the caret/);
    expect(hint!.reason).toMatch(/keep using keyboard:type/);
    expect(hint!.preferredPath).toBe("desktop_act (only to replace the whole value)");
    expect(hint!.example).toContain("text:'<the whole new value>'");
    expect(hint!.example).not.toContain("action:'type'");
  });
});
