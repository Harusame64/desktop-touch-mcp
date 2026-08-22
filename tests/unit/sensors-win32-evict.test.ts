/**
 * tests/unit/sensors-win32-evict.test.ts
 *
 * A resolved handle that stops yielding a rectangle stops being an aiming
 * candidate.
 *
 * `refreshWin32Fluents` runs immediately before the auto-guard evaluates a
 * click (`action-target.ts:buildWindowLensResult`), so it is the one place that
 * both knows the handle and has just asked Windows about it. Without the
 * eviction the guard refuses the click but the cache entry survives, and the
 * next click aimed anywhere inside that rectangle resolves to it again — the
 * loop the user sees as "clicks keep getting rejected until I reconnect".
 *
 * The rule is deliberately a single question — *does this handle still yield a
 * rect?* — asked from the two places that reach it differently: the window was
 * not in the enumeration at all, or it was but its rectangle came back null.
 * Absence from the enumeration is NOT proof of closure: `enumWindowsInZOrder`
 * drops invisible, untitled and tiny windows on purpose, so that path probes
 * rather than assumes, and a live-but-unenumerated window keeps its entry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEnum = vi.fn<() => unknown[]>(() => []);
const mockRect = vi.fn<() => { x: number; y: number; width: number; height: number } | null>(
  () => ({ x: 100, y: 100, width: 400, height: 300 }),
);

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: () => mockEnum(),
    getWindowRectByHwnd: () => mockRect(),
    getWindowIdentity: () => ({ pid: 1234, processName: "app.exe", processStartTimeMs: 1 }),
    isWindowTopmost: () => false,
    getWindowClassName: () => "AppClass",
  };
});

const { refreshWin32Fluents } = await import("../../src/engine/perception/sensors-win32.js");
const { updateWindowCache, findContainingWindow } = await import(
  "../../src/engine/window-cache.js"
);

const HWND = 0xa1n;
const REGION = { x: 100, y: 100, width: 400, height: 300 };

/** The window as the enumerator would report it. */
const ENUMERATED = {
  hwnd: HWND,
  title: "MyApp — Editor",
  region: REGION,
  zOrder: 0,
  isMinimized: false,
  isMaximized: false,
  isActive: true,
};

function seedCache(): void {
  updateWindowCache([ENUMERATED as never]);
  expect(findContainingWindow(200, 200)?.hwnd).toBe(HWND);
}

beforeEach(() => {
  mockEnum.mockReset();
  mockRect.mockReset();
  mockEnum.mockReturnValue([ENUMERATED]);
  mockRect.mockReturnValue(REGION);
});

describe("refreshWin32Fluents evicts a handle that yields no rect", () => {
  it("drops the entry when the window is enumerated but its rect is unreadable", () => {
    seedCache();
    mockRect.mockReturnValue(null);

    refreshWin32Fluents(String(HWND), "MyApp");

    expect(findContainingWindow(200, 200)).toBeNull();
  });

  it("drops the entry when the window is gone from the enumeration entirely", () => {
    // This path never reaches the rect observation, so it has to ask for itself.
    seedCache();
    mockEnum.mockReturnValue([]);
    mockRect.mockReturnValue(null);

    refreshWin32Fluents(String(HWND), "MyApp");

    expect(findContainingWindow(200, 200)).toBeNull();
  });

  it("keeps a window that is merely absent from the enumeration but still answers", () => {
    // `enumWindowsInZOrder` deliberately drops invisible / untitled / tiny
    // windows, so "not enumerated" must not be read as "closed".
    seedCache();
    mockEnum.mockReturnValue([]);
    mockRect.mockReturnValue(REGION);

    refreshWin32Fluents(String(HWND), "MyApp");

    expect(findContainingWindow(200, 200)?.hwnd).toBe(HWND);
  });

  it("keeps a healthy window", () => {
    seedCache();

    refreshWin32Fluents(String(HWND), "MyApp");

    expect(findContainingWindow(200, 200)?.hwnd).toBe(HWND);
  });

  it("still reports the null rect on the fluent, so the guard can refuse", () => {
    // Eviction stops the NEXT click aiming there; the guard refusing is what
    // stops this one. Both halves are needed.
    mockRect.mockReturnValue(null);

    const obs = refreshWin32Fluents(String(HWND), "MyApp");

    const rectObs = obs.find((o) => o.property === "target.rect");
    expect(rectObs).toBeDefined();
    expect(rectObs!.value).toBeNull();
  });
});
