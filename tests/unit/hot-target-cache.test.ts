/**
 * tests/unit/hot-target-cache.test.ts
 * HotTargetCache unit tests — 10 cases covering TTL, LRU, and design rules.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getOrCreateSlot,
  updateSlot,
  markBad,
  clearExpired,
  getSlotSnapshot,
  _resetForTest,
  HOT_IDLE_TTL_MS,
  HOT_HARD_TTL_MS,
  HOT_BAD_TTL_MS,
  HOT_MAX_SLOTS,
} from "../../src/engine/perception/hot-target-cache.js";
import type { ActionTargetDescriptor } from "../../src/engine/perception/action-target.js";

function windowDescriptor(title: string): ActionTargetDescriptor {
  return { kind: "window", titleIncludes: title };
}

function browserTabDescriptor(tabId: string): ActionTargetDescriptor {
  return { kind: "browserTab", tabId, port: 9222 };
}

function coordinateDescriptor(x: number, y: number): ActionTargetDescriptor {
  return { kind: "coordinate", x, y };
}

beforeEach(() => {
  _resetForTest();
});

describe("HotTargetCache — coordinate-only not cached", () => {
  it("returns null for coordinate-only descriptor (no windowTitle)", () => {
    const slot = getOrCreateSlot(coordinateDescriptor(100, 200));
    expect(slot).toBeNull();
  });

  it("returns slot for window descriptor", () => {
    const slot = getOrCreateSlot(windowDescriptor("notepad"));
    expect(slot).not.toBeNull();
    expect(slot?.kind).toBe("window");
  });
});

describe("HotTargetCache — idle TTL", () => {
  it("evicts slot after idle TTL expires", () => {
    const now = Date.now();
    const slot = getOrCreateSlot(windowDescriptor("notepad"), now);
    expect(slot).not.toBeNull();

    // Advance past idle TTL
    clearExpired(now + HOT_IDLE_TTL_MS + 1);
    const snapshot = getSlotSnapshot();
    expect(snapshot.find(s => s.key.includes("notepad"))).toBeUndefined();
  });

  it("keeps slot within idle TTL", () => {
    const now = Date.now();
    getOrCreateSlot(windowDescriptor("notepad"), now);

    clearExpired(now + HOT_IDLE_TTL_MS - 1000);
    const snapshot = getSlotSnapshot();
    expect(snapshot.length).toBe(1);
  });
});

describe("HotTargetCache — hard TTL", () => {
  it("evicts slot after hard TTL even if touched continuously", () => {
    const now = Date.now();
    const slot = getOrCreateSlot(windowDescriptor("calc"), now);
    expect(slot).not.toBeNull();

    // Simulate continuous touches within idle TTL but past hard TTL
    const touchTime = now + HOT_HARD_TTL_MS - 100;
    updateSlot(slot!.key, { useCount: 99 }, touchTime);

    clearExpired(now + HOT_HARD_TTL_MS + 1);
    const snapshot = getSlotSnapshot();
    expect(snapshot.find(s => s.key.includes("calc"))).toBeUndefined();
  });
});

describe("HotTargetCache — bad TTL", () => {
  it("marks slot bad and removes after bad TTL", () => {
    const now = Date.now();
    const slot = getOrCreateSlot(windowDescriptor("paint"), now);
    expect(slot).not.toBeNull();

    markBad(slot!.key, "test reason", now);
    expect(slot!.attention).toBe("not_found");
    expect(slot!.badUntilMs).toBe(now + HOT_BAD_TTL_MS);

    // After bad TTL, slot is removed
    clearExpired(now + HOT_BAD_TTL_MS + 1);
    const snapshot = getSlotSnapshot();
    expect(snapshot.find(s => s.key.includes("paint"))).toBeUndefined();
  });

  it("bad slot is skipped when retrieving (returns fresh slot)", () => {
    const now = Date.now();
    const slot1 = getOrCreateSlot(windowDescriptor("wordpad"), now);
    markBad(slot1!.key, "failed", now);

    // Within bad TTL — should create a new slot (old one had bad TTL)
    const slot2 = getOrCreateSlot(windowDescriptor("wordpad"), now + 1000);
    // slot2 should be a new slot since old one is bad
    expect(slot2).not.toBeNull();
    expect(slot2!.badUntilMs).toBeUndefined();
  });
});

describe("HotTargetCache — LRU eviction", () => {
  it("evicts least recently used slot when capacity exceeded", () => {
    const now = Date.now();
    // Fill up to HOT_MAX_SLOTS
    for (let i = 0; i < HOT_MAX_SLOTS; i++) {
      getOrCreateSlot(windowDescriptor(`app${i}`), now + i * 100);
    }
    expect(getSlotSnapshot().length).toBe(HOT_MAX_SLOTS);

    // Add one more — should evict app0 (oldest, used at now+0)
    getOrCreateSlot(windowDescriptor("extra"), now + HOT_MAX_SLOTS * 100);
    const snapshot = getSlotSnapshot();
    expect(snapshot.length).toBe(HOT_MAX_SLOTS);
    expect(snapshot.find(s => s.key.includes("app0"))).toBeUndefined();
    expect(snapshot.find(s => s.key.includes("extra"))).toBeDefined();
  });
});

describe("HotTargetCache — TTL only extended on action touch", () => {
  it("updateSlot extends lastUsedAtMs (action model touch)", () => {
    const now = Date.now();
    const slot = getOrCreateSlot(windowDescriptor("vscode"), now);
    expect(slot!.lastUsedAtMs).toBe(now);

    const laterTime = now + 30_000;
    updateSlot(slot!.key, { useCount: 1 }, laterTime);
    expect(slot!.lastUsedAtMs).toBe(laterTime);
  });

  it("clearExpired (background sensor sweep) does NOT extend TTL", () => {
    const now = Date.now();
    const slot = getOrCreateSlot(windowDescriptor("explorer"), now);
    const originalLastUsed = slot!.lastUsedAtMs;

    // Simulate background sensor calling clearExpired — should not touch lastUsedAtMs
    clearExpired(now + 10_000);
    expect(slot!.lastUsedAtMs).toBe(originalLastUsed);
  });
});

describe("HotTargetCache — descriptor-bound identity", () => {
  it("same descriptor key returns same slot even after identity change", () => {
    const now = Date.now();
    const slot1 = getOrCreateSlot(windowDescriptor("notepad"), now);
    slot1!.identity = { hwnd: "1000", pid: 100, processName: "notepad.exe", processStartTimeMs: 0, titleResolved: "" };

    // "Same" descriptor key — should get same slot object back
    const slot2 = getOrCreateSlot(windowDescriptor("notepad"), now + 1000);
    expect(slot2).toBe(slot1);
  });

  it("updateSlot stores new identity in existing slot", () => {
    const now = Date.now();
    const slot = getOrCreateSlot(windowDescriptor("chrome"), now);
    const newIdentity = { hwnd: "2000", pid: 200, processName: "chrome.exe", processStartTimeMs: 1000, titleResolved: "" };
    updateSlot(slot!.key, { identity: newIdentity }, now + 5000);
    expect(slot!.identity).toEqual(newIdentity);
  });
});

describe("HotTargetCache — browserTab descriptor", () => {
  it("returns slot for browserTab with tabId", () => {
    const slot = getOrCreateSlot(browserTabDescriptor("tab-abc-123"));
    expect(slot).not.toBeNull();
    expect(slot?.kind).toBe("browserTab");
    expect(slot?.key).toBe("browserTab:tab-abc-123");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F-5: stale-identity LRU detail assertions (v3 §6.1 specification compliance)
// ─────────────────────────────────────────────────────────────────────────────

describe("F-5: stale-identity LRU detail (v3 §6.1)", () => {
  it("F-5(a): LRU tiebreak uses lastUsedAtMs — oldest is evicted", () => {
    // Fill to HOT_MAX_SLOTS
    for (let i = 0; i < HOT_MAX_SLOTS; i++) {
      getOrCreateSlot(windowDescriptor(`window${i}`), 1000 + i * 100);
    }
    expect(getSlotSnapshot()).toHaveLength(HOT_MAX_SLOTS);

    // Add one more — should evict oldest (window0 with lastUsedAtMs=1000)
    getOrCreateSlot(windowDescriptor("windowNew"), 2000);
    const keys = getSlotSnapshot().map(s => s.key);
    // window0 is the oldest by lastUsedAtMs
    expect(keys).not.toContain("window:window0");
    expect(keys).toContain("window:windownew");
  });

  it("F-5(b): bad-TTL expired slot is cleared by clearExpired", () => {
    const now = 1_000_000;
    const slot = getOrCreateSlot(windowDescriptor("notepad"), now);
    markBad(slot!.key, "test bad", now);
    expect(getSlotSnapshot().find(s => s.key === slot!.key)?.badUntilMs).toBeGreaterThan(now);

    // Before TTL expiry — slot still present
    clearExpired(now + HOT_BAD_TTL_MS - 1);
    expect(getSlotSnapshot().find(s => s.key === slot!.key)).toBeTruthy();

    // After TTL expiry — slot removed
    clearExpired(now + HOT_BAD_TTL_MS + 1);
    expect(getSlotSnapshot().find(s => s.key === slot!.key)).toBeUndefined();
  });

  it("F-5(c): getOrCreateSlot read-only call does NOT extend TTL", () => {
    const now = 1_000_000;
    const slot = getOrCreateSlot(windowDescriptor("notepad"), now);
    const originalLastUsed = slot!.lastUsedAtMs;

    // Multiple read-only calls should NOT change lastUsedAtMs
    getOrCreateSlot(windowDescriptor("notepad"), now + 5000);
    getOrCreateSlot(windowDescriptor("notepad"), now + 10000);
    expect(slot!.lastUsedAtMs).toBe(originalLastUsed);

    // Only updateSlot (called by model actions) should advance TTL
    updateSlot(slot!.key, { useCount: slot!.useCount + 1 }, now + 10000);
    expect(slot!.lastUsedAtMs).toBe(now + 10000);
  });
});
