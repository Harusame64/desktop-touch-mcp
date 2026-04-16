/**
 * tests/unit/perception-native-runtime.test.ts
 *
 * M4: Native WinEvent runtime integration tests.
 *
 * Verifies:
 *  - stopNativeRuntime() is idempotent (no throw when called on idle runtime)
 *  - getNativePerceptionDiagnostics() returns well-formed structure
 *  - nativeEventsEnabled() respects DESKTOP_TOUCH_NATIVE_WINEVENTS=0 env var
 *
 * Note: WinEventSource spawns a sidecar binary that won't exist in CI.
 * The WinEventSource itself is mocked to prevent spawn attempts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock impure dependencies ────────────────────────────────────────────────────
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn().mockReturnValue([]),
  getWindowProcessId: vi.fn(),
  getProcessIdentityByPid: vi.fn(),
  getWindowRectByHwnd: vi.fn(),
  getForegroundHwnd: vi.fn().mockReturnValue(null),
  isWindowTopmost: vi.fn().mockReturnValue(false),
  getWindowClassName: vi.fn().mockReturnValue("TestClass"),
  getWindowIdentity: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/engine/event-bus.js", () => ({
  subscribe: vi.fn().mockReturnValue("sub-mock"),
  unsubscribe: vi.fn(),
  poll: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/engine/identity-tracker.js", () => ({
  observeTarget: vi.fn().mockReturnValue(null),
  clearIdentities: vi.fn(),
  buildHintsForTitle: vi.fn().mockReturnValue(null),
}));

// Note: WinEventSource is NOT mocked — sidecar spawn will fail with ENOENT,
// which is handled gracefully by the WinEventSource implementation.

import {
  stopNativeRuntime,
  getNativePerceptionDiagnostics,
  __resetForTests,
} from "../../src/engine/perception/registry.js";

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTests();
});

describe("stopNativeRuntime (M4)", () => {
  it("is idempotent when called before runtime is started", () => {
    expect(() => stopNativeRuntime()).not.toThrow();
    expect(() => stopNativeRuntime()).not.toThrow();
  });

  it("can be called multiple times safely", () => {
    for (let i = 0; i < 5; i++) {
      expect(() => stopNativeRuntime()).not.toThrow();
    }
  });
});

describe("getNativePerceptionDiagnostics (M4)", () => {
  it("returns a well-formed diagnostics object", () => {
    const diag = getNativePerceptionDiagnostics();
    expect(typeof diag.enabled).toBe("boolean");
    expect(diag.source).toBeDefined();
    expect(typeof diag.journalEntryCount).toBe("number");
    expect(typeof diag.globalDirty).toBe("boolean");
  });

  it("reports enabled:false when NATIVE_WINEVENTS=0", () => {
    vi.stubEnv("DESKTOP_TOUCH_NATIVE_WINEVENTS", "0");
    const diag = getNativePerceptionDiagnostics();
    expect(diag.enabled).toBe(false);
    vi.unstubAllEnvs();
  });

  it("source is disabled state when runtime not started", () => {
    const diag = getNativePerceptionDiagnostics();
    expect(diag.source).toMatchObject({ state: "disabled" });
  });

  it("queue is undefined when runtime not started", () => {
    const diag = getNativePerceptionDiagnostics();
    expect(diag.queue).toBeUndefined();
  });
});
