/**
 * tests/unit/suggested-fix-store.test.ts
 * SuggestedFixStore unit tests — 8 cases (v3 §7 design rules).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  storeFix,
  resolveFix,
  consumeFix,
  clearExpiredFixes,
  getFixSnapshot,
  _resetFixStoreForTest,
  FIX_TTL_MS,
  FIX_MAX_SLOTS,
} from "../../src/engine/perception/suggested-fix-store.js";

function makeFix(overrides: Partial<Parameters<typeof storeFix>[0]> = {}) {
  return {
    tool: "mouse_click" as const,
    args: { x: 100, y: 200, windowTitle: "Notepad" },
    targetFingerprint: {
      kind: "window" as const,
      descriptorKey: "window:notepad",
      hwnd: "1000",
      pid: 100,
      processStartTimeMs: 12345,
    },
    reason: "Test drift",
    ...overrides,
  };
}

beforeEach(() => {
  _resetFixStoreForTest();
});

describe("SuggestedFixStore — basic store/resolve", () => {
  it("stores a fix and resolves it by fixId", () => {
    const fix = storeFix(makeFix());
    expect(fix.fixId).toMatch(/^fix-/);
    expect(fix.consumed).toBe(false);

    const resolved = resolveFix(fix.fixId);
    expect(resolved).not.toBeNull();
    expect(resolved?.args.x).toBe(100);
  });

  it("returns null for unknown fixId", () => {
    expect(resolveFix("fix-nonexistent")).toBeNull();
  });
});

describe("SuggestedFixStore — TTL expiry (15s)", () => {
  it("resolves fix within TTL", () => {
    const now = Date.now();
    const fix = storeFix(makeFix(), now);
    expect(resolveFix(fix.fixId, now + FIX_TTL_MS - 1)).not.toBeNull();
  });

  it("returns null after TTL expiry", () => {
    const now = Date.now();
    const fix = storeFix(makeFix(), now);
    expect(resolveFix(fix.fixId, now + FIX_TTL_MS + 1)).toBeNull();
  });

  it("clearExpiredFixes removes expired entries", () => {
    const now = Date.now();
    storeFix(makeFix(), now);
    clearExpiredFixes(now + FIX_TTL_MS + 1);
    expect(getFixSnapshot().length).toBe(0);
  });
});

describe("SuggestedFixStore — one-shot consume", () => {
  it("fix is unusable after consume", () => {
    const fix = storeFix(makeFix());
    consumeFix(fix.fixId);
    expect(resolveFix(fix.fixId)).toBeNull();
  });

  it("consumeFix on unknown id is a no-op", () => {
    // Should not throw
    expect(() => consumeFix("fix-unknown")).not.toThrow();
  });
});

describe("SuggestedFixStore — capacity / LRU eviction", () => {
  it("evicts oldest entry when at capacity", () => {
    const now = Date.now();
    const fixes: ReturnType<typeof storeFix>[] = [];
    for (let i = 0; i < FIX_MAX_SLOTS; i++) {
      fixes.push(storeFix(makeFix({ reason: `fix-${i}` }), now + i * 100));
    }
    expect(getFixSnapshot().length).toBe(FIX_MAX_SLOTS);

    // Add one more — oldest (fix 0) should be evicted
    storeFix(makeFix({ reason: "extra" }), now + FIX_MAX_SLOTS * 100);
    expect(getFixSnapshot().length).toBe(FIX_MAX_SLOTS);
    expect(resolveFix(fixes[0]!.fixId, now + FIX_MAX_SLOTS * 100)).toBeNull();
  });
});

describe("SuggestedFixStore — tool mismatch guard", () => {
  it("fix tool must be mouse_click", () => {
    const fix = storeFix(makeFix({ tool: "mouse_click" }));
    const resolved = resolveFix(fix.fixId);
    expect(resolved?.tool).toBe("mouse_click");
    // Tool is always mouse_click in v0.12 — other tools are not storable due to the type
  });
});

describe("SuggestedFixStore — targetFingerprint is stored and readable", () => {
  it("resolved fix contains targetFingerprint for revalidation", () => {
    const fix = storeFix(makeFix());
    const resolved = resolveFix(fix.fixId);
    expect(resolved?.targetFingerprint.hwnd).toBe("1000");
    expect(resolved?.targetFingerprint.processStartTimeMs).toBe(12345);
    expect(resolved?.targetFingerprint.descriptorKey).toBe("window:notepad");
  });

  it("fix with no processStartTimeMs can skip identity revalidation", () => {
    const fix = storeFix(makeFix({
      targetFingerprint: {
        kind: "window",
        descriptorKey: "window:paint",
        // hwnd without processStartTimeMs — revalidation is a no-op
      },
    }));
    const resolved = resolveFix(fix.fixId);
    expect(resolved?.targetFingerprint.processStartTimeMs).toBeUndefined();
  });
});
