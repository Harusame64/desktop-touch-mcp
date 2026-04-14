/**
 * key-map.test.ts — Unit tests for parseKeys (J5)
 *
 * Verifies case-insensitivity, space-trimming, modifier aliases,
 * error handling for unknown/empty tokens, and duplicate modifiers.
 */

import { describe, it, expect } from "vitest";
import { parseKeys, KEY_MAP } from "../../src/utils/key-map.js";
import { Key } from "@nut-tree-fork/nut-js";

// ── Canonical combos ──────────────────────────────────────────────────────────

describe("parseKeys — canonical input", () => {
  it("parses 'ctrl+s'", () => {
    expect(parseKeys("ctrl+s")).toEqual([Key.LeftControl, Key.S]);
  });

  it("parses 'alt+tab'", () => {
    expect(parseKeys("alt+tab")).toEqual([Key.LeftAlt, Key.Tab]);
  });

  it("parses 'ctrl+shift+s'", () => {
    expect(parseKeys("ctrl+shift+s")).toEqual([Key.LeftControl, Key.LeftShift, Key.S]);
  });

  it("parses 'enter'", () => {
    expect(parseKeys("enter")).toEqual([Key.Return]);
  });

  it("parses 'f5'", () => {
    expect(parseKeys("f5")).toEqual([Key.F5]);
  });
});

// ── Case insensitivity ────────────────────────────────────────────────────────

describe("parseKeys — case insensitive", () => {
  it("CTRL+S → same as ctrl+s", () => {
    expect(parseKeys("CTRL+S")).toEqual(parseKeys("ctrl+s"));
  });

  it("ALT+TAB → same as alt+tab", () => {
    expect(parseKeys("ALT+TAB")).toEqual(parseKeys("alt+tab"));
  });

  it("ENTER → same as enter", () => {
    expect(parseKeys("ENTER")).toEqual(parseKeys("enter"));
  });

  it("Ctrl+Shift+S (mixed) → same as ctrl+shift+s", () => {
    expect(parseKeys("Ctrl+Shift+S")).toEqual(parseKeys("ctrl+shift+s"));
  });
});

// ── Whitespace trimming ───────────────────────────────────────────────────────

describe("parseKeys — whitespace trimming", () => {
  it("'ctrl + s' (spaces around +) → same as ctrl+s", () => {
    expect(parseKeys("ctrl + s")).toEqual(parseKeys("ctrl+s"));
  });

  it("' enter ' (leading/trailing spaces on token) → [Return]", () => {
    expect(parseKeys(" enter ")).toEqual([Key.Return]);
  });

  it("'ctrl +  s' (multiple spaces) → same as ctrl+s", () => {
    expect(parseKeys("ctrl +  s")).toEqual(parseKeys("ctrl+s"));
  });
});

// ── Modifier aliases ──────────────────────────────────────────────────────────

describe("parseKeys — modifier aliases", () => {
  it("'control+s' (control = ctrl alias) → same as ctrl+s", () => {
    expect(parseKeys("control+s")).toEqual(parseKeys("ctrl+s"));
  });

  it("'meta+tab' → [LeftSuper, Tab]", () => {
    expect(parseKeys("meta+tab")).toEqual([Key.LeftSuper, Key.Tab]);
  });

  it("'super+tab' → same as meta+tab", () => {
    expect(parseKeys("super+tab")).toEqual(parseKeys("meta+tab"));
  });

  it("'win+tab' → same as meta+tab", () => {
    expect(parseKeys("win+tab")).toEqual(parseKeys("meta+tab"));
  });

  it("'esc' → same as 'escape'", () => {
    expect(parseKeys("esc")).toEqual(parseKeys("escape"));
  });

  it("'return' → same as 'enter'", () => {
    expect(parseKeys("return")).toEqual(parseKeys("enter"));
  });

  it("'del' → same as 'delete'", () => {
    expect(parseKeys("del")).toEqual(parseKeys("delete"));
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe("parseKeys — error cases", () => {
  it("throws for unknown key name", () => {
    expect(() => parseKeys("ctrl+unicorn")).toThrow(/Unknown key.*unicorn/);
  });

  it("throws for empty string", () => {
    // "".split("+") = [""] → KEY_MAP[""] = undefined
    expect(() => parseKeys("")).toThrow(/Unknown key/);
  });

  it("throws for trailing '+' (empty token after split)", () => {
    // "ctrl+".split("+") = ["ctrl", ""] → KEY_MAP[""] = undefined
    expect(() => parseKeys("ctrl+")).toThrow(/Unknown key/);
  });

  it("throws for leading '+' (empty token before split)", () => {
    expect(() => parseKeys("+s")).toThrow(/Unknown key/);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("parseKeys — edge cases", () => {
  it("duplicate modifiers are accepted (ctrl+ctrl+s → two LeftControl entries)", () => {
    const result = parseKeys("ctrl+ctrl+s");
    expect(result).toEqual([Key.LeftControl, Key.LeftControl, Key.S]);
  });

  it("all function keys f1–f12 are mapped", () => {
    for (let i = 1; i <= 12; i++) {
      expect(() => parseKeys(`f${i}`)).not.toThrow();
    }
  });

  it("digits 0–9 are mapped", () => {
    for (let i = 0; i <= 9; i++) {
      expect(() => parseKeys(`${i}`)).not.toThrow();
    }
  });

  it("KEY_MAP contains no undefined entries for standard keys", () => {
    const standardKeys = ["a","b","z","enter","escape","tab","space","backspace",
      "delete","home","end","pageup","pagedown","up","down","left","right",
      "ctrl","alt","shift","win","f1","f12","0","9"];
    for (const k of standardKeys) {
      expect(KEY_MAP[k]).toBeDefined();
    }
  });
});
