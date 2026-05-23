/**
 * tests/unit/advisory-hints.test.ts
 * ADR-022 / issue #352 — success-path advisory builder (`_advisory.ts`).
 *
 * Pure builder over the focused-element snapshot withPostState already captures.
 * No UIA, no timers — fully deterministic.
 */

import { describe, it, expect } from "vitest";
import { maybeAdvisory, getAdvisoryEmitCount } from "../../src/tools/_advisory.js";
import type { PostElementInfo } from "../../src/tools/_post.js";

const edit = (value: string | undefined = "existing"): PostElementInfo => ({
  name: "Text Editor",
  type: "Edit",
  ...(value !== undefined ? { value } : {}),
});

describe("maybeAdvisory — keyboard(type) → desktop_act", () => {
  it("emits for a focused UIA Edit (ValuePattern) with the windowTitle + text bound", () => {
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "メモ帳", text: "hello" },
      edit(),
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
    );
    expect(hint).not.toBeNull();
  });

  it("falls back to focused:true when no windowTitle, and text:'…' when no text", () => {
    const hint = maybeAdvisory("keyboard", { action: "type" }, edit());
    expect(hint).not.toBeNull();
    expect(hint!.example).toContain("focused:true");
    expect(hint!.example).toContain("text:'…'");
  });

  it("truncates long text and sanitises quotes/newlines in the example", () => {
    const longText = "a".repeat(50) + "'b\nc";
    const hint = maybeAdvisory(
      "keyboard",
      { action: "type", windowTitle: "x", text: longText },
      edit(),
    );
    expect(hint).not.toBeNull();
    // truncated to 40 chars + ellipsis, no raw newline, no unescaped quote breaking the literal
    expect(hint!.example).toContain("…");
    expect(hint!.example).not.toMatch(/\n/);
  });
});

describe("maybeAdvisory — suppression (no hint)", () => {
  it("returns null when the focused element is not a text input (UIA-blind / wrong control)", () => {
    expect(
      maybeAdvisory("keyboard", { action: "type", text: "x" }, { name: "Canvas", type: "Pane", value: "" }),
    ).toBeNull();
  });

  it("returns null when the focused element exposes no value (no ValuePattern)", () => {
    // An Edit with NO `value` field = UIA did not expose ValuePattern → suppress.
    expect(
      maybeAdvisory("keyboard", { action: "type", text: "x" }, { name: "Text Editor", type: "Edit" }),
    ).toBeNull();
  });

  it("returns null when there is no focused element", () => {
    expect(maybeAdvisory("keyboard", { action: "type", text: "x" }, null)).toBeNull();
  });

  it("returns null for a non-type keyboard action", () => {
    expect(maybeAdvisory("keyboard", { action: "press", keys: "enter" }, edit())).toBeNull();
  });

  it("returns null for a different tool", () => {
    expect(maybeAdvisory("mouse_click", { action: "type", text: "x" }, edit())).toBeNull();
  });
});

describe("getAdvisoryEmitCount", () => {
  it("increments on a hit and not on a miss", () => {
    const before = getAdvisoryEmitCount();
    maybeAdvisory("keyboard", { action: "type", text: "x" }, edit()); // hit
    maybeAdvisory("keyboard", { action: "type", text: "x" }, null); // miss
    maybeAdvisory("mouse_click", {}, edit()); // miss
    expect(getAdvisoryEmitCount()).toBe(before + 1);
  });
});
