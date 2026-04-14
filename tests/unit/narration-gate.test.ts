/**
 * narration-gate.test.ts — Unit tests for isStateTransitioningKey
 */

import { describe, it, expect } from "vitest";
import { isStateTransitioningKey } from "../../src/tools/_narration.js";

describe("isStateTransitioningKey", () => {
  // ── Bare special keys ───────────────────────────────────────────────────────

  it("returns true for enter", () => expect(isStateTransitioningKey("enter")).toBe(true));
  it("returns true for tab",   () => expect(isStateTransitioningKey("tab")).toBe(true));
  it("returns true for escape",() => expect(isStateTransitioningKey("escape")).toBe(true));
  it("returns true for esc",   () => expect(isStateTransitioningKey("esc")).toBe(true));
  it("returns true for f5",    () => expect(isStateTransitioningKey("f5")).toBe(true));
  it("returns true for f12",   () => expect(isStateTransitioningKey("f12")).toBe(true));
  it("returns true for delete",    () => expect(isStateTransitioningKey("delete")).toBe(true));
  it("returns true for backspace", () => expect(isStateTransitioningKey("backspace")).toBe(true));
  it("returns true for pageup",    () => expect(isStateTransitioningKey("pageup")).toBe(true));
  it("returns true for home",      () => expect(isStateTransitioningKey("home")).toBe(true));
  it("returns true for up arrow",  () => expect(isStateTransitioningKey("up")).toBe(true));

  // ── Bare single-character keys ──────────────────────────────────────────────

  it("returns false for 'a'", () => expect(isStateTransitioningKey("a")).toBe(false));
  it("returns false for 'z'", () => expect(isStateTransitioningKey("z")).toBe(false));
  it("returns false for '1'", () => expect(isStateTransitioningKey("1")).toBe(false));
  it("returns false for space character", () => expect(isStateTransitioningKey(" ")).toBe(false));

  // ── ctrl combos ────────────────────────────────────────────────────────────

  it("returns true for ctrl+s (save)",  () => expect(isStateTransitioningKey("ctrl+s")).toBe(true));
  it("returns true for ctrl+f (find)",  () => expect(isStateTransitioningKey("ctrl+f")).toBe(true));
  it("returns true for ctrl+z (undo)",  () => expect(isStateTransitioningKey("ctrl+z")).toBe(true));
  it("returns true for ctrl+p",         () => expect(isStateTransitioningKey("ctrl+p")).toBe(true));
  it("returns true for ctrl+shift+s",   () => expect(isStateTransitioningKey("ctrl+shift+s")).toBe(true));
  it("returns true for ctrl+shift+p",   () => expect(isStateTransitioningKey("ctrl+shift+p")).toBe(true));
  it("returns true for ctrl+enter",     () => expect(isStateTransitioningKey("ctrl+enter")).toBe(true));

  // ── alt combos ─────────────────────────────────────────────────────────────

  it("returns true for alt+tab",  () => expect(isStateTransitioningKey("alt+tab")).toBe(true));
  it("returns true for alt+f4",   () => expect(isStateTransitioningKey("alt+f4")).toBe(true));
  it("returns true for alt+enter",() => expect(isStateTransitioningKey("alt+enter")).toBe(true));

  // ── meta / win / super / cmd ────────────────────────────────────────────────

  it("returns true for meta+tab",  () => expect(isStateTransitioningKey("meta+tab")).toBe(true));
  it("returns true for win+d",     () => expect(isStateTransitioningKey("win+d")).toBe(true));
  it("returns true for super+tab", () => expect(isStateTransitioningKey("super+tab")).toBe(true));
  it("returns true for cmd+s",     () => expect(isStateTransitioningKey("cmd+s")).toBe(true));

  // ── shift combos — shift alone is NOT a state modifier ─────────────────────

  it("returns false for shift+a (uppercase A — text input)",
    () => expect(isStateTransitioningKey("shift+a")).toBe(false));
  it("returns false for shift+1",
    () => expect(isStateTransitioningKey("shift+1")).toBe(false));
  it("returns true for shift+tab (reverse-tab — STATE_KEYS hit)",
    () => expect(isStateTransitioningKey("shift+tab")).toBe(true));
  it("returns true for shift+enter",
    () => expect(isStateTransitioningKey("shift+enter")).toBe(true));
  it("returns true for shift+f10 (context menu)",
    () => expect(isStateTransitioningKey("shift+f10")).toBe(true));

  // ── case insensitivity ──────────────────────────────────────────────────────

  it("is case-insensitive: Ctrl+S", () => expect(isStateTransitioningKey("Ctrl+S")).toBe(true));
  it("is case-insensitive: ALT+TAB", () => expect(isStateTransitioningKey("ALT+TAB")).toBe(true));
  it("is case-insensitive: ENTER",   () => expect(isStateTransitioningKey("ENTER")).toBe(true));

  // ── edge cases ──────────────────────────────────────────────────────────────

  it("returns false for empty string", () => expect(isStateTransitioningKey("")).toBe(false));
  it("returns false for whitespace",   () => expect(isStateTransitioningKey("   ")).toBe(false));
});
