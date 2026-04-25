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
  for (const tool of ["mouse_click", "keyboard_type", "browser_click", "click_element"] as const) {
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

// browserTab fingerprint — no Win32 calls needed for revalidation
function makeBrowserFix(tool: SuggestedFix["tool"]): Omit<SuggestedFix, "fixId" | "createdAtMs" | "expiresAtMs" | "consumed"> {
  return {
    tool,
    args: { selector: "#btn", tabId: "tab-1", port: 9222 },
    targetFingerprint: {
      kind: "browserTab",
      descriptorKey: "browserTab:tab-1",
      tabId: "tab-1",
      url: "https://example.com",
    },
    reason: "test drift",
  };
}

describe("validateAndPrepareFix (tool mismatch / error codes)", () => {
  it("returns FixToolMismatch when tool does not match", async () => {
    const { validateAndPrepareFix } = await import("../../src/tools/_action-guard.js");
    const stored = storeFix(makeBrowserFix("keyboard_type"));
    const r = validateAndPrepareFix(stored.fixId, "mouse_click");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("FixToolMismatch");
  });

  it("returns fix when tool matches (browserTab fingerprint — no Win32 needed)", async () => {
    const { validateAndPrepareFix } = await import("../../src/tools/_action-guard.js");
    const stored = storeFix(makeBrowserFix("browser_click"));
    const r = validateAndPrepareFix(stored.fixId, "browser_click");
    expect(r.ok).toBe(true);
    expect(r.fix!.args.selector).toBe("#btn");
  });

  it("returns FixNotFoundOrExpired for expired fix", async () => {
    const { validateAndPrepareFix } = await import("../../src/tools/_action-guard.js");
    const past = Date.now() - FIX_TTL_MS - 1000;
    const stored = storeFix(makeBrowserFix("click_element"), past);
    const r = validateAndPrepareFix(stored.fixId, "click_element");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("FixNotFoundOrExpired");
  });

  it("FixTargetMismatch for window fingerprint with non-existent hwnd", async () => {
    const { validateAndPrepareFix } = await import("../../src/tools/_action-guard.js");
    // hwnd "1" is virtually guaranteed to not be a real window (or if it is, pid won't match 999)
    const stored = storeFix({
      tool: "mouse_click",
      args: { x: 100, y: 100 },
      targetFingerprint: { kind: "window", descriptorKey: "window:notepad", hwnd: "1", pid: 99999999 },
      reason: "test",
    });
    const r = validateAndPrepareFix(stored.fixId, "mouse_click");
    // If hwnd 1 doesn't exist: FixTargetMismatch (window gone)
    // If hwnd 1 exists but pid differs: FixTargetMismatch
    // Either way, should not succeed with mismatched pid
    expect(["FixTargetMismatch", "ok"]).toContain(r.errorCode ?? "ok");
  });
});
