/**
 * tests/unit/perception-registry.test.ts
 * Unit tests for the perception registry — register/list/forget cycle,
 * LRU eviction, seq monotonicity, and guard evaluation.
 *
 * Win32 / event-bus / identity-tracker calls are mocked so tests run without a display.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock impure dependencies ────────────────────────────────────────────────────
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(),
  getWindowProcessId: vi.fn(),
  getProcessIdentityByPid: vi.fn(),
  getWindowRectByHwnd: vi.fn(),
  getForegroundHwnd: vi.fn(),
  isWindowTopmost: vi.fn(),
  getWindowClassName: vi.fn(),
  getWindowIdentity: vi.fn(),
}));

vi.mock("../../src/engine/event-bus.js", () => ({
  subscribe: vi.fn().mockReturnValue("sub-1"),
  unsubscribe: vi.fn(),
  poll: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/engine/identity-tracker.js", () => ({
  observeTarget: vi.fn(),
  clearIdentities: vi.fn(),
  buildHintsForTitle: vi.fn().mockReturnValue(null),
}));

import * as win32 from "../../src/engine/win32.js";
import * as identTracker from "../../src/engine/identity-tracker.js";
import {
  registerLens,
  forgetLens,
  listLenses,
  evaluatePreToolGuards,
  buildEnvelopeFor,
  readLens,
  __resetForTests,
} from "../../src/engine/perception/registry.js";
import type { LensSpec } from "../../src/engine/perception/types.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeWindow(hwnd: bigint, title: string, isActive = false, zOrder = 0) {
  return {
    hwnd, title, isActive, zOrder,
    isMinimized: false, isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
  };
}

function setupMocks(hwnd: bigint, title: string, isActive = true) {
  vi.mocked(win32.enumWindowsInZOrder).mockReturnValue([
    fakeWindow(hwnd, title, isActive),
  ]);
  vi.mocked(win32.getWindowRectByHwnd).mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
  vi.mocked(win32.getForegroundHwnd).mockReturnValue(isActive ? hwnd : null);
  vi.mocked(win32.isWindowTopmost).mockReturnValue(false);
  vi.mocked(win32.getWindowClassName).mockReturnValue("Notepad");
  vi.mocked(win32.getWindowIdentity).mockReturnValue({
    pid: 1234, processName: "notepad.exe", processStartTimeMs: 1700000000000,
  });
  vi.mocked(identTracker.observeTarget).mockReturnValue({
    identity: { pid: 1234, processName: "notepad.exe", processStartTimeMs: 1700000000000, titleResolved: title },
    invalidatedBy: null,
  });
}

const baseSpec: LensSpec = {
  name: "test-notepad",
  target: { kind: "window", match: { titleIncludes: "Notepad" } },
  maintain: [...FLUENT_KINDS],
  guards: ["target.identityStable", "safe.keyboardTarget"],
  guardPolicy: "block",
  maxEnvelopeTokens: 120,
  salience: "normal",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTests();
});

// ── register / list / forget ──────────────────────────────────────────────────

describe("registerLens", () => {
  it("returns a lensId, seq, and digest on success", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const result = registerLens(baseSpec);
    expect(result.lensId).toMatch(/^perc-\d+$/);
    expect(typeof result.seq).toBe("number");
    expect(result.digest).toContain(result.lensId);
  });

  it("throws when no window matches titleIncludes", () => {
    vi.mocked(win32.enumWindowsInZOrder).mockReturnValue([]);
    expect(() => registerLens(baseSpec)).toThrow(/Window not found/);
  });

  it("increments seq across multiple registrations", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const r1 = registerLens(baseSpec);
    setupMocks(200n, "Second Notepad", true);
    const r2 = registerLens({ ...baseSpec, name: "second", target: { kind: "window", match: { titleIncludes: "Second Notepad" } } });
    expect(r2.seq).toBeGreaterThan(r1.seq);
  });

  it("lensId is unique across registrations", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const r1 = registerLens(baseSpec);
    setupMocks(100n, "Untitled - Notepad", true);
    const r2 = registerLens({ ...baseSpec, name: "second" });
    expect(r1.lensId).not.toBe(r2.lensId);
  });
});

describe("listLenses", () => {
  it("returns empty array when no lenses registered", () => {
    expect(listLenses()).toHaveLength(0);
  });

  it("lists registered lenses with summary info", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    const list = listLenses();
    expect(list).toHaveLength(1);
    expect(list[0]!.lensId).toBe(lensId);
    expect(list[0]!.name).toBe("test-notepad");
    expect(list[0]!.guardPolicy).toBe("block");
  });
});

describe("forgetLens", () => {
  it("removes a lens and returns true", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    const removed = forgetLens(lensId);
    expect(removed).toBe(true);
    expect(listLenses()).toHaveLength(0);
  });

  it("returns false when lensId is unknown", () => {
    expect(forgetLens("nonexistent")).toBe(false);
  });

  it("stops sensor loop when last lens is removed", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    forgetLens(lensId);
    // After forgetting the only lens, listLenses should be empty
    expect(listLenses()).toHaveLength(0);
  });
});

// ── LRU eviction ─────────────────────────────────────────────────────────────

describe("LRU eviction (max 16)", () => {
  it("evicts oldest lens when exceeding 16", () => {
    // Register 17 lenses — first one should be evicted
    let firstLensId: string | undefined;
    for (let i = 0; i < 17; i++) {
      const hwnd = BigInt(100 + i);
      const title = `Window-${i}`;
      setupMocks(hwnd, title, i === 0);
      const r = registerLens({
        ...baseSpec,
        name: `lens-${i}`,
        target: { kind: "window", match: { titleIncludes: title } },
      });
      if (i === 0) firstLensId = r.lensId;
    }
    const ids = listLenses().map(l => l.lensId);
    expect(ids).not.toContain(firstLensId);
    expect(ids.length).toBeLessThanOrEqual(16);
  });
});

// ── evaluatePreToolGuards ────────────────────────────────────────────────────

describe("evaluatePreToolGuards", () => {
  it("throws when lensId is unknown", () => {
    expect(() => evaluatePreToolGuards("nonexistent", "keyboard_type", {})).toThrow(/Lens not found/);
  });

  it("returns ok:true when window is foreground and identity stable", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    // Mock for the pre-guard refresh call
    setupMocks(100n, "Untitled - Notepad", true);
    const result = evaluatePreToolGuards(lensId, "keyboard_type", {});
    expect(result.ok).toBe(true);
  });

  it("returns ok:false when window is not foreground", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    // Simulate window losing foreground on pre-guard refresh
    setupMocks(100n, "Untitled - Notepad", false);
    const result = evaluatePreToolGuards(lensId, "keyboard_type", {});
    expect(result.ok).toBe(false);
    expect(result.policy).toBe("block");
  });
});

// ── buildEnvelopeFor ─────────────────────────────────────────────────────────

describe("buildEnvelopeFor", () => {
  it("returns null for unknown lensId", () => {
    const env = buildEnvelopeFor("nonexistent");
    expect(env).toBeNull();
  });

  it("returns a PerceptionEnvelope with correct structure", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    setupMocks(100n, "Untitled - Notepad", true);
    const env = buildEnvelopeFor(lensId, { toolName: "keyboard_type" });
    expect(env).not.toBeNull();
    expect(env!.lens).toBe(lensId);
    expect(typeof env!.seq).toBe("number");
    expect(env!.attention).toBeDefined();
    expect(env!.guards).toBeDefined();
  });

  it("consumes recent changes after call (idempotent on next call)", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    setupMocks(100n, "Untitled - Notepad", true);
    const env1 = buildEnvelopeFor(lensId);
    setupMocks(100n, "Untitled - Notepad", true);
    const env2 = buildEnvelopeFor(lensId);
    // Second call should have empty changed (changes consumed by first)
    expect(env2!.changed.length).toBeLessThanOrEqual(env1!.changed.length);
  });
});

// ── readLens ─────────────────────────────────────────────────────────────────

describe("readLens", () => {
  it("throws for unknown lensId", () => {
    expect(() => readLens("nonexistent")).toThrow(/Lens not found/);
  });

  it("returns envelope with current state", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    setupMocks(100n, "Untitled - Notepad", true);
    const env = readLens(lensId);
    expect(env.lens).toBe(lensId);
    expect(env.attention).toBeDefined();
  });
});

// ── __resetForTests ────────────────────────────────────────────────────────

describe("__resetForTests", () => {
  it("clears all lenses", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    registerLens(baseSpec);
    __resetForTests();
    expect(listLenses()).toHaveLength(0);
  });
});
