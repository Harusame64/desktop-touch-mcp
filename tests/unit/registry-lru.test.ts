/**
 * tests/unit/registry-lru.test.ts
 *
 * Phase E — Manual Lens LRU (v3 §6.2, §10.7).
 * Verifies touch-on-use semantics for evaluatePreToolGuards / buildEnvelopeFor / readLens.
 *
 * Win32/sidecar mocked; tests run headless.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn().mockReturnValue([]),
  getWindowProcessId: vi.fn().mockReturnValue(1),
  getProcessIdentityByPid: vi.fn().mockReturnValue({ name: "test.exe", startTimeMs: 0 }),
  getWindowRectByHwnd: vi.fn().mockReturnValue({ x: 0, y: 0, width: 100, height: 100 }),
  getForegroundHwnd: vi.fn().mockReturnValue(BigInt(0)),
  isWindowTopmost: vi.fn().mockReturnValue(false),
  getWindowClassName: vi.fn().mockReturnValue("test"),
  getWindowIdentity: vi.fn(),
  restoreAndFocusWindow: vi.fn(),
}));
vi.mock("../../src/engine/event-bus.js", () => ({
  subscribe: vi.fn().mockReturnValue("sub"),
  unsubscribe: vi.fn(),
  poll: vi.fn().mockReturnValue([]),
}));
vi.mock("../../src/engine/identity-tracker.js", () => ({
  observeTarget: vi.fn(),
  clearIdentities: vi.fn(),
  buildHintsForTitle: vi.fn().mockReturnValue(null),
}));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getFocusedAndPointInfo: vi.fn().mockResolvedValue({ hwnd: null, title: null }),
}));
vi.mock("../../src/engine/perception/sensors-uia.js", () => ({
  refreshUiaFluents: vi.fn().mockResolvedValue([]),
  startUiaSensorLoop: vi.fn().mockReturnValue(() => {}),
  __resetUiaSensorForTests: vi.fn(),
}));
vi.mock("../../src/engine/perception/sensors-cdp.js", () => ({
  refreshCdpFluents: vi.fn().mockResolvedValue([]),
  startCdpSensorLoop: vi.fn().mockReturnValue(() => {}),
  __resetCdpSensorForTests: vi.fn(),
}));
vi.mock("../../src/engine/perception/sensors-native-win32.js", () => ({
  NativeSensorBridge: class { processBatch() {} processOverflow() {} },
}));
vi.mock("../../src/engine/winevent-source.js", () => ({
  WinEventSource: class { start() {} stop() {} },
}));
vi.mock("../../src/engine/perception/raw-event-queue.js", () => ({
  RawEventQueue: class { drain() { return []; } enqueue() {} overflowPending = false; },
}));
vi.mock("../../src/engine/perception/flush-scheduler.js", () => ({
  FlushScheduler: class { schedule() {} dispose() {} },
}));
vi.mock("../../src/engine/perception/reconciliation.js", () => ({
  ReconciliationScheduler: class { start() {} stop() {} triggerImmediate() {} },
}));

// ─────────────────────────────────────────────────────────────────────────────

import {
  registerLens,
  forgetLens,
  evaluatePreToolGuards,
  buildEnvelopeFor,
  readLens,
  listLenses,
  getLensAttention,
  addLensLifecycleListener,
  __resetForTests,
} from "../../src/engine/perception/registry.js";
import { _resetForTest as resetTimeline } from "../../src/engine/perception/target-timeline.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Stub refreshWin32Fluents so register doesn't need real Win32
const { refreshWin32Fluents, buildWindowIdentity } = await vi.importMock("../../src/engine/perception/sensors-win32.js") as {
  refreshWin32Fluents: ReturnType<typeof vi.fn>;
  buildWindowIdentity: ReturnType<typeof vi.fn>;
};

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: vi.fn().mockReturnValue([]),
  buildWindowIdentity: vi.fn().mockReturnValue({
    hwnd: "1000", pid: 1, processName: "test.exe", processStartTimeMs: 0, titleResolved: "test",
  }),
  startSensorLoop: vi.fn().mockReturnValue(() => {}),
  __resetSensorForTests: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn().mockReturnValue([
    { hwnd: BigInt(1000), title: "TestWindow", zOrder: 0, isActive: true },
  ]),
  getWindowProcessId: vi.fn().mockReturnValue(1),
  getProcessIdentityByPid: vi.fn().mockReturnValue({ name: "test.exe", startTimeMs: 0 }),
  getWindowRectByHwnd: vi.fn().mockReturnValue({ x: 0, y: 0, width: 100, height: 100 }),
  getForegroundHwnd: vi.fn().mockReturnValue(BigInt(1000)),
  isWindowTopmost: vi.fn().mockReturnValue(false),
  getWindowClassName: vi.fn().mockReturnValue("test"),
  getWindowIdentity: vi.fn(),
  restoreAndFocusWindow: vi.fn(),
}));

function makeWindowSpec(name: string) {
  return {
    name,
    target: { kind: "window" as const, match: { titleIncludes: "TestWindow" } },
    maintain: ["target.exists" as const],
    guards: [] as never[],
    guardPolicy: "block" as const,
    maxEnvelopeTokens: 0,
    salience: "normal" as const,
  };
}

beforeEach(() => {
  __resetForTests();
  resetTimeline();
});

// ─────────────────────────────────────────────────────────────────────────────
// E-4: touch-then-evict
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase E — LRU touch-on-use", () => {
  it("E-4: lens 0 touched via evaluatePreToolGuards, then 17th lens evicts lens 1 (not lens 0)", async () => {
    // Register 16 lenses
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const { lensId } = registerLens(makeWindowSpec(`lens-${i}`));
      ids.push(lensId);
    }
    expect(listLenses()).toHaveLength(16);

    // Touch lens 0 (promotes it to MRU)
    try {
      await evaluatePreToolGuards(ids[0], "test", {});
    } catch { /* best-effort */ }

    // Register 17th lens — must evict the LRU (lens 1, since lens 0 was just touched)
    const { lensId: lens17 } = registerLens(makeWindowSpec("lens-16"));

    // Lens 0 should still be alive (was touched)
    const lens0Alive = listLenses().some(l => l.lensId === ids[0]);
    expect(lens0Alive).toBe(true);

    // Lens 1 should have been evicted (oldest among untouched)
    const lens1Alive = listLenses().some(l => l.lensId === ids[1]);
    expect(lens1Alive).toBe(false);

    // Lens 17 is present
    expect(listLenses().some(l => l.lensId === lens17)).toBe(true);
  });

  it("listLenses does NOT touch lenses (listing doesn't change LRU order)", () => {
    const { lensId: id0 } = registerLens(makeWindowSpec("lens-0"));
    const { lensId: id1 } = registerLens(makeWindowSpec("lens-1"));

    // List many times — should not touch either lens
    for (let i = 0; i < 10; i++) listLenses();

    // id0 should still be LRU (no touch happened)
    // If we now register 15 more + 1 more, id0 should be evicted (not id1)
    const ids: string[] = [id0, id1];
    for (let i = 2; i < 16; i++) {
      const { lensId } = registerLens(makeWindowSpec(`lens-${i}`));
      ids.push(lensId);
    }
    // 16 total now. Register 17th — id0 should be evicted (LRU)
    registerLens(makeWindowSpec("lens-16"));
    expect(listLenses().some(l => l.lensId === id0)).toBe(false);
    expect(listLenses().some(l => l.lensId === id1)).toBe(true);
  });

  it("E-5: onForgotten fires with 'evict' reason when LRU is evicted", () => {
    const evictedIds: string[] = [];
    const { lensId: id0 } = registerLens(makeWindowSpec("lens-0"));
    void id0;  // registered as LRU

    // Register lens 1-15
    for (let i = 1; i < 16; i++) registerLens(makeWindowSpec(`lens-${i}`));

    // Add lifecycle listener
    const unsub = addLensLifecycleListener({
      onForgotten: (lensId: string, reason: string) => {
        if (reason === "evict") evictedIds.push(lensId);
      },
    });

    // Register 17th — triggers eviction of id0
    registerLens(makeWindowSpec("lens-16"));
    unsub();

    expect(evictedIds).toContain(id0);
  });

  it("buildEnvelopeFor touch promotes lens to MRU", () => {
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const { lensId } = registerLens(makeWindowSpec(`lens-${i}`));
      ids.push(lensId);
    }

    // Touch lens 0 via buildEnvelopeFor
    buildEnvelopeFor(ids[0]);

    // Register 17th — should evict lens 1 (lens 0 is MRU)
    registerLens(makeWindowSpec("lens-16"));

    expect(listLenses().some(l => l.lensId === ids[0])).toBe(true);
    expect(listLenses().some(l => l.lensId === ids[1])).toBe(false);
  });

  it("sensor loop refresh does NOT touch lenses (getLensAttention doesn't touch)", () => {
    const { lensId: id0 } = registerLens(makeWindowSpec("lens-0"));

    // getLensAttention is a read-only getter — should not touch
    getLensAttention(id0);
    getLensAttention(id0);

    // id0 should still be LRU
    for (let i = 1; i < 16; i++) registerLens(makeWindowSpec(`lens-${i}`));

    // 17th should evict id0
    registerLens(makeWindowSpec("lens-16"));
    expect(listLenses().some(l => l.lensId === id0)).toBe(false);
  });
});
