/**
 * key-safety.test.ts — Unit tests for assertKeyComboSafe (J4)
 *
 * Verifies the blocklist covers all dangerous Win+* combos and
 * that case-insensitivity and modifier aliases are handled correctly.
 */

import { describe, it, expect } from "vitest";
import { assertKeyComboSafe, BlockedKeyComboError } from "../../src/utils/key-safety.js";

// ── Helper ────────────────────────────────────────────────────────────────────

function isBlocked(combo: string): boolean {
  try {
    assertKeyComboSafe(combo);
    return false;
  } catch (e) {
    return e instanceof BlockedKeyComboError;
  }
}

// ── Blocked combos ────────────────────────────────────────────────────────────

describe("assertKeyComboSafe — blocked combos", () => {
  it("blocks win+r  (Run dialog)", () => expect(isBlocked("win+r")).toBe(true));
  it("blocks win+x  (Power User menu)", () => expect(isBlocked("win+x")).toBe(true));
  it("blocks win+s  (Windows Search)", () => expect(isBlocked("win+s")).toBe(true));
  it("blocks win+l  (Lock screen)", () => expect(isBlocked("win+l")).toBe(true));

  // ── Case insensitivity ───────────────────────────────────────────────────────
  it("blocks WIN+R  (uppercase)", () => expect(isBlocked("WIN+R")).toBe(true));
  it("blocks Win+R  (mixed case)", () => expect(isBlocked("Win+R")).toBe(true));
  it("blocks WIN+X",               () => expect(isBlocked("WIN+X")).toBe(true));
  it("blocks WIN+S",               () => expect(isBlocked("WIN+S")).toBe(true));
  it("blocks WIN+L",               () => expect(isBlocked("WIN+L")).toBe(true));

  // ── meta / super aliases ─────────────────────────────────────────────────────
  it("blocks meta+r  (meta = win alias)", () => expect(isBlocked("meta+r")).toBe(true));
  it("blocks super+r (super = win alias)", () => expect(isBlocked("super+r")).toBe(true));
  it("blocks META+R  (uppercase alias)",   () => expect(isBlocked("META+R")).toBe(true));
  it("blocks Super+L",                     () => expect(isBlocked("Super+L")).toBe(true));
  it("blocks meta+s",                      () => expect(isBlocked("meta+s")).toBe(true));
  it("blocks super+x",                     () => expect(isBlocked("super+x")).toBe(true));
});

// ── Allowed combos ────────────────────────────────────────────────────────────

describe("assertKeyComboSafe — allowed combos", () => {
  it("allows ctrl+s",    () => expect(isBlocked("ctrl+s")).toBe(false));
  it("allows ctrl+z",    () => expect(isBlocked("ctrl+z")).toBe(false));
  it("allows alt+f4",    () => expect(isBlocked("alt+f4")).toBe(false));
  it("allows enter",     () => expect(isBlocked("enter")).toBe(false));
  it("allows escape",    () => expect(isBlocked("escape")).toBe(false));
  it("allows alt+tab",   () => expect(isBlocked("alt+tab")).toBe(false));
  it("allows win+d  (show desktop — not on blocklist)", () => expect(isBlocked("win+d")).toBe(false));
  it("allows win+tab (Task View — not on blocklist)",   () => expect(isBlocked("win+tab")).toBe(false));
  it("allows f5",        () => expect(isBlocked("f5")).toBe(false));
});

// ── Error shape ───────────────────────────────────────────────────────────────

describe("BlockedKeyComboError shape", () => {
  it("throws BlockedKeyComboError (not generic Error)", () => {
    expect(() => assertKeyComboSafe("win+r")).toThrowError(BlockedKeyComboError);
  });

  it("error name is 'BlockedKeyComboError'", () => {
    try {
      assertKeyComboSafe("win+r");
    } catch (e) {
      expect((e as Error).name).toBe("BlockedKeyComboError");
    }
  });

  it("error message contains the original combo string", () => {
    try {
      assertKeyComboSafe("Win+R");
    } catch (e) {
      expect((e as Error).message).toContain("Win+R");
    }
  });

  it("error message mentions 'workspace_launch' as alternative", () => {
    try {
      assertKeyComboSafe("win+r");
    } catch (e) {
      expect((e as Error).message).toContain("workspace_launch");
    }
  });
});
