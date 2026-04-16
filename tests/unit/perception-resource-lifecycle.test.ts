/**
 * tests/unit/perception-resource-lifecycle.test.ts
 *
 * M2/M3: Resource lifecycle and sensor-loop dynamic-closure tests.
 *
 * Verifies:
 *  M2 - addLensLifecycleListener wires ResourceRegistry correctly:
 *       register → URIs appear, forget → tombstone
 *  M3 - Sensor-loop callbacks read lenses dynamically (no stale closure):
 *       A second lens registered after loop start should be visible to callbacks.
 *
 * Win32/event-bus/sidecar mocked; tests run without display.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(),
  getWindowProcessId: vi.fn(),
  getProcessIdentityByPid: vi.fn(),
  getWindowRectByHwnd: vi.fn(),
  getForegroundHwnd: vi.fn(),
  isWindowTopmost: vi.fn().mockReturnValue(false),
  getWindowClassName: vi.fn().mockReturnValue("Notepad"),
  getWindowIdentity: vi.fn(),
}));

vi.mock("../../src/engine/event-bus.js", () => ({
  subscribe: vi.fn().mockReturnValue("sub-mock"),
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
  addLensLifecycleListener,
  getAllLenses,
  __resetForTests,
} from "../../src/engine/perception/registry.js";
import { ResourceRegistry } from "../../src/engine/perception/resource-registry.js";
import type { LensSpec } from "../../src/engine/perception/types.js";
import { FLUENT_KINDS } from "../../src/engine/perception/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupMocks(hwnd: bigint, title: string, isActive = true) {
  vi.mocked(win32.enumWindowsInZOrder).mockReturnValue([{
    hwnd, title, isActive, zOrder: 0,
    isMinimized: false, isMaximized: false,
    region: { x: 0, y: 0, width: 1920, height: 1080 },
  }]);
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
  name: "test",
  target: { kind: "window", match: { titleIncludes: "Notepad" } },
  maintain: [...FLUENT_KINDS],
  guards: [],
  guardPolicy: "block",
  maxEnvelopeTokens: 120,
  salience: "normal",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTests();
});

// ── M2: ResourceRegistry lifecycle integration ────────────────────────────────

describe("ResourceRegistry lifecycle via addLensLifecycleListener (M2)", () => {
  it("URIs appear in registry after registerLens", () => {
    const reg = new ResourceRegistry();
    const unsub = addLensLifecycleListener({
      onRegistered: (lens) => reg.onLensRegistered(lens),
      onForgotten:  (lensId) => reg.onLensForgotten(lensId),
    });

    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);

    expect(reg.listUris()).toContain(`perception://lens/${lensId}/summary`);
    expect(reg.listUris()).toContain(`perception://lens/${lensId}/guards`);
    unsub();
  });

  it("URIs disappear and tombstone appears after forgetLens", () => {
    const reg = new ResourceRegistry();
    const unsub = addLensLifecycleListener({
      onRegistered: (lens) => reg.onLensRegistered(lens),
      onForgotten:  (lensId) => reg.onLensForgotten(lensId),
    });

    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    forgetLens(lensId);

    expect(reg.listUris()).not.toContain(`perception://lens/${lensId}/summary`);
    expect(reg.getTombstone(`perception://lens/${lensId}/summary`)).toBeDefined();
    unsub();
  });

  it("replay: registry receives URIs for already-registered lenses at subscribe time", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);

    const reg = new ResourceRegistry();
    const unsub = addLensLifecycleListener({
      onRegistered: (lens) => reg.onLensRegistered(lens),
    });

    // Replay should have fired synchronously in addLensLifecycleListener
    expect(reg.listUris()).toContain(`perception://lens/${lensId}/summary`);
    unsub();
  });

  it("multiple lenses all get URIs", () => {
    const reg = new ResourceRegistry();
    const unsub = addLensLifecycleListener({
      onRegistered: (lens) => reg.onLensRegistered(lens),
      onForgotten:  (lensId) => reg.onLensForgotten(lensId),
    });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      setupMocks(BigInt(100 + i), `Window-${i}`, true);
      const r = registerLens({
        ...baseSpec,
        name: `lens-${i}`,
        target: { kind: "window", match: { titleIncludes: `Window-${i}` } },
      });
      ids.push(r.lensId);
    }

    for (const id of ids) {
      expect(reg.listUris()).toContain(`perception://lens/${id}/summary`);
    }
    unsub();
  });
});

// ── M3: Sensor loop dynamic closure ───────────────────────────────────────────

describe("getAllLenses returns current lenses (M3 — no stale closure)", () => {
  it("returns empty before any lens is registered", () => {
    expect(getAllLenses()).toHaveLength(0);
  });

  it("returns lens immediately after registerLens", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    const all = getAllLenses();
    expect(all.map(l => l.lensId)).toContain(lensId);
  });

  it("returns updated list after second lens registered (dynamic read, not stale snapshot)", () => {
    setupMocks(100n, "Notepad-1", true);
    const r1 = registerLens({ ...baseSpec, name: "lens-1", target: { kind: "window", match: { titleIncludes: "Notepad-1" } } });

    // If callbacks used a stale closure, they'd only see lens-1.
    // getAllLenses() is always live.
    setupMocks(101n, "Notepad-2", true);
    const r2 = registerLens({ ...baseSpec, name: "lens-2", target: { kind: "window", match: { titleIncludes: "Notepad-2" } } });

    const ids = getAllLenses().map(l => l.lensId);
    expect(ids).toContain(r1.lensId);
    expect(ids).toContain(r2.lensId);
  });

  it("does not include forgotten lens", () => {
    setupMocks(100n, "Untitled - Notepad", true);
    const { lensId } = registerLens(baseSpec);
    forgetLens(lensId);
    const ids = getAllLenses().map(l => l.lensId);
    expect(ids).not.toContain(lensId);
  });
});

// ── getUrisForLens ─────────────────────────────────────────────────────────────

describe("ResourceRegistry.getUrisForLens", () => {
  it("returns summary and guards URIs for a registered lens", () => {
    const reg = new ResourceRegistry();
    reg.onLensRegistered({
      lensId: "perc-test",
      spec: baseSpec,
      binding: { hwnd: "100", windowTitle: "Test" },
      boundIdentity: { hwnd: "100", pid: 1, processName: "test.exe", processStartTimeMs: 0, titleResolved: "Test" },
      fluentKeys: [],
      registeredAtSeq: 0,
      registeredAtMs: Date.now(),
    });

    const uris = reg.getUrisForLens("perc-test");
    expect(uris).toContain("perception://lens/perc-test/summary");
    expect(uris).toContain("perception://lens/perc-test/guards");
  });

  it("returns empty array for unknown lensId", () => {
    const reg = new ResourceRegistry();
    expect(reg.getUrisForLens("unknown-lens")).toHaveLength(0);
  });

  it("returns empty array after lens is forgotten", () => {
    const reg = new ResourceRegistry();
    reg.onLensRegistered({
      lensId: "perc-test",
      spec: baseSpec,
      binding: { hwnd: "100", windowTitle: "Test" },
      boundIdentity: { hwnd: "100", pid: 1, processName: "test.exe", processStartTimeMs: 0, titleResolved: "Test" },
      fluentKeys: [],
      registeredAtSeq: 0,
      registeredAtMs: Date.now(),
    });
    reg.onLensForgotten("perc-test");
    expect(reg.getUrisForLens("perc-test")).toHaveLength(0);
  });
});
