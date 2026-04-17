/**
 * tests/unit/suggested-fix-store-union.test.ts
 *
 * Phase G — SuggestedFix.tool union (v3 §7.1).
 * Verifies all 4 tool variants work with the store (store/resolve/consume).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  storeFix,
  resolveFix,
  consumeFix,
  _resetFixStoreForTest,
  FIX_TTL_MS,
} from "../../src/engine/perception/suggested-fix-store.js";
import type { SuggestedFix } from "../../src/engine/perception/suggested-fix-store.js";

function makePartial(tool: SuggestedFix["tool"], args: Record<string, unknown> = {}): Omit<SuggestedFix, "fixId" | "createdAtMs" | "expiresAtMs" | "consumed"> {
  return {
    tool,
    args,
    targetFingerprint: {
      kind: "window",
      descriptorKey: "window:notepad",
      hwnd: "1000",
      pid: 100,
      processStartTimeMs: 12345,
    },
    reason: "test drift",
  };
}

beforeEach(() => _resetFixStoreForTest());

describe("SuggestedFix.tool union — all 4 variants", () => {
  for (const tool of ["mouse_click", "keyboard_type", "browser_click_element", "click_element"] as const) {
    it(`storeFix accepts tool="${tool}"`, () => {
      const fix = storeFix(makePartial(tool));
      expect(fix.tool).toBe(tool);
      expect(fix.fixId).toMatch(/^fix-/);
      expect(fix.consumed).toBe(false);
    });

    it(`resolveFix returns fix for tool="${tool}"`, () => {
      const stored = storeFix(makePartial(tool));
      const resolved = resolveFix(stored.fixId);
      expect(resolved).not.toBeNull();
      expect(resolved!.tool).toBe(tool);
    });

    it(`consumeFix marks consumed for tool="${tool}"`, () => {
      const stored = storeFix(makePartial(tool));
      consumeFix(stored.fixId);
      expect(resolveFix(stored.fixId)).toBeNull();  // consumed → not resolvable
    });
  }
});

describe("validateAndPrepareFix (tool mismatch)", () => {
  it("returns FixToolMismatch when tool does not match", async () => {
    const { validateAndPrepareFix } = await import("../../src/tools/_action-guard.js");
    const stored = storeFix(makePartial("keyboard_type", { text: "hello", windowTitle: "Notepad" }));
    const r = validateAndPrepareFix(stored.fixId, "mouse_click");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("FixToolMismatch");
  });

  it("returns fix when tool matches", async () => {
    const { validateAndPrepareFix } = await import("../../src/tools/_action-guard.js");
    const stored = storeFix(makePartial("keyboard_type", { text: "hello", windowTitle: "Notepad" }));
    const r = validateAndPrepareFix(stored.fixId, "keyboard_type");
    expect(r.ok).toBe(true);
    expect(r.fix!.args.text).toBe("hello");
  });

  it("returns FixNotFoundOrExpired for expired fix", async () => {
    const { validateAndPrepareFix } = await import("../../src/tools/_action-guard.js");
    const past = Date.now() - FIX_TTL_MS - 1000;
    const stored = storeFix(makePartial("click_element"), past);
    const r = validateAndPrepareFix(stored.fixId, "click_element");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("FixNotFoundOrExpired");
  });
});
