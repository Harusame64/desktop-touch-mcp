/**
 * tests/unit/resolve-action-target.test.ts
 * Unit tests for resolveActionTarget and normalizeTitle.
 * window: 8 cases, coordinate: 5 cases, browserTab: 5 cases
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mocks ───────────────────────────────────────────────────────────────

const { mockEnumWindows, mockBuildWindowIdentity, mockRefreshWin32Fluents,
        mockFindContainingWindow, mockGetCachedWindowByTitle,
        mockListTabsLight } = vi.hoisted(() => ({
  mockEnumWindows: vi.fn(),
  mockBuildWindowIdentity: vi.fn(),
  mockRefreshWin32Fluents: vi.fn(),
  mockFindContainingWindow: vi.fn(),
  mockGetCachedWindowByTitle: vi.fn(),
  mockListTabsLight: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: mockEnumWindows,
}));

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: mockRefreshWin32Fluents,
  buildWindowIdentity: mockBuildWindowIdentity,
}));

vi.mock("../../src/engine/window-cache.js", () => ({
  findContainingWindow: mockFindContainingWindow,
  getCachedWindowByTitle: mockGetCachedWindowByTitle,
  computeWindowDelta: vi.fn(() => null),
}));

// Mock CDP bridge to prevent real Chrome connections in unit tests
vi.mock("../../src/engine/cdp-bridge.js", () => ({
  listTabsLight: mockListTabsLight,
  DEFAULT_CDP_PORT: 9222,
}));

// Mock compileLens to track idSeed calls
const compiledLensIds: string[] = [];
vi.mock("../../src/engine/perception/lens.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/perception/lens.js")>();
  return {
    ...actual,
    compileLens: (...args: Parameters<typeof actual.compileLens>) => {
      const [spec, binding, identity, seq, idSeed] = args;
      const lens = actual.compileLens(spec, binding, identity, seq, idSeed);
      compiledLensIds.push(lens.lensId);
      return lens;
    },
  };
});

import { resolveActionTarget } from "../../src/engine/perception/action-target.js";

function makeWindow(hwnd: string, title: string, isActive = false, zOrder = 5) {
  return { hwnd: BigInt(hwnd) as unknown as bigint, title, isActive, zOrder, region: { x: 0, y: 0, width: 800, height: 600 } };
}

function makeIdentity(hwnd: string) {
  return { hwnd, pid: 100, processName: "test.exe", processStartTimeMs: 0, titleResolved: "" };
}

beforeEach(() => {
  mockEnumWindows.mockReset();
  mockBuildWindowIdentity.mockReset();
  mockRefreshWin32Fluents.mockReset();
  mockFindContainingWindow.mockReset();
  mockGetCachedWindowByTitle.mockReset();
  mockListTabsLight.mockReset();
  compiledLensIds.length = 0;

  mockRefreshWin32Fluents.mockReturnValue([]);
  mockBuildWindowIdentity.mockReturnValue(null);
  // Default: CDP unavailable (listTabsLight throws)
  mockListTabsLight.mockRejectedValue(new Error("CDP unavailable (mock)"));
});

// ─── Window kind ──────────────────────────────────────────────────────────────

describe("resolveActionTarget — window kind", () => {
  it("returns single matching window", async () => {
    mockEnumWindows.mockReturnValue([makeWindow("1000", "Untitled - Notepad", false, 3)]);
    const result = await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    expect(result.candidates).toBe(1);
    expect(result.lens).not.toBeNull();
    expect(result.lens?.binding.hwnd).toBe("1000");
  });

  it("returns foreground window when multiple match", async () => {
    mockEnumWindows.mockReturnValue([
      makeWindow("1001", "Notepad", false, 2),
      makeWindow("1002", "Notepad - 2", true, 1),  // foreground
    ]);
    const result = await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    expect(result.candidates).toBe(2);
    expect(result.lens?.binding.hwnd).toBe("1002");  // foreground wins
  });

  it("returns frontmost (lowest zOrder) when no foreground match", async () => {
    mockEnumWindows.mockReturnValue([
      makeWindow("1003", "Notepad - main", false, 5),
      makeWindow("1004", "Notepad - bg", false, 2),   // lower zOrder = frontmost
    ]);
    const result = await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "mouseClick" });
    expect(result.lens?.binding.hwnd).toBe("1004");
  });

  it("returns candidates=0 when no window matches", async () => {
    mockEnumWindows.mockReturnValue([makeWindow("1000", "Calculator", false, 1)]);
    const result = await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    expect(result.candidates).toBe(0);
    expect(result.lens).toBeNull();
  });

  it("strips Chromium suffix for matching", async () => {
    mockEnumWindows.mockReturnValue([makeWindow("2000", "GitHub - Google Chrome", false, 1)]);
    const result = await resolveActionTarget({ kind: "window", titleIncludes: "github" }, { actionKind: "mouseClick" });
    expect(result.candidates).toBe(1);
    expect(result.lens?.binding.hwnd).toBe("2000");
  });

  it("compileLens uses auto- prefix (global counter not polluted)", async () => {
    mockEnumWindows.mockReturnValue([makeWindow("1000", "Notepad", false, 1)]);
    const before = compiledLensIds.length;
    await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    const newIds = compiledLensIds.slice(before);
    expect(newIds.every(id => id.startsWith("auto-"))).toBe(true);
  });

  it("creates fresh FluentStore per call (not sharing module store)", async () => {
    mockEnumWindows.mockReturnValue([makeWindow("1000", "Notepad", false, 1)]);
    const r1 = await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    const r2 = await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    expect(r1.localStore).not.toBe(r2.localStore);
  });

  it("attaches identity when buildWindowIdentity returns a value", async () => {
    mockEnumWindows.mockReturnValue([makeWindow("1000", "Notepad", false, 1)]);
    mockBuildWindowIdentity.mockReturnValue(makeIdentity("1000"));
    const result = await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    expect(result.identity).not.toBeNull();
    expect((result.identity as { hwnd: string }).hwnd).toBe("1000");
  });
});

// ─── Coordinate kind ──────────────────────────────────────────────────────────

describe("resolveActionTarget — coordinate kind", () => {
  it("returns lens from findContainingWindow hit", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("1000"), title: "Notepad", zOrder: 1 });
    const result = await resolveActionTarget({ kind: "coordinate", x: 100, y: 100 }, { actionKind: "mouseClick" });
    expect(result.candidates).toBe(1);
    expect(result.lens?.binding.hwnd).toBe("1000");
  });

  it("returns candidates=0 when coordinate not inside any window", async () => {
    mockFindContainingWindow.mockReturnValue(null);
    const result = await resolveActionTarget({ kind: "coordinate", x: 9999, y: 9999 }, { actionKind: "mouseClick" });
    expect(result.candidates).toBe(0);
    expect(result.lens).toBeNull();
  });

  it("adds warning when windowTitle hint does not match containing window", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("2000"), title: "Calculator", zOrder: 1 });
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "Notepad" },
      { actionKind: "mouseClick" }
    );
    expect(result.warnings.some(w => w.includes("does not match"))).toBe(true);
  });

  it("no warning when windowTitle hint matches containing window", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("1000"), title: "Untitled - Notepad", zOrder: 1 });
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "notepad" },
      { actionKind: "mouseClick" }
    );
    const hasMismatchWarning = result.warnings.some(w => w.includes("does not match"));
    expect(hasMismatchWarning).toBe(false);
  });

  it("uses containing window hwnd (not getCachedWindowByTitle) for coordinate kind", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("3000"), title: "Paint", zOrder: 1 });
    const result = await resolveActionTarget({ kind: "coordinate", x: 50, y: 50 }, { actionKind: "mouseClick" });
    expect(result.lens?.binding.hwnd).toBe("3000");
    expect(mockGetCachedWindowByTitle).not.toHaveBeenCalled();
  });
});

// ─── browserTab kind ─────────────────────────────────────────────────────────

describe("resolveActionTarget — browserTab kind", () => {
  it("returns candidates=0 when CDP unavailable", async () => {
    // CDP module dynamic import will fail in test environment
    const result = await resolveActionTarget(
      { kind: "browserTab", port: 9222 },
      { actionKind: "browserCdp" }
    );
    expect(result.candidates).toBe(0);
    expect(result.lens).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns candidates=0 when tabId not found", async () => {
    const result = await resolveActionTarget(
      { kind: "browserTab", port: 9222, tabId: "nonexistent" },
      { actionKind: "browserCdp" }
    );
    expect(result.candidates).toBe(0);
  });

  it("needs_escalation guard for browserTab + keyboard is handled in runActionGuard not here", async () => {
    // resolveActionTarget itself just resolves tabs — the escalation block is in runActionGuard
    const result = await resolveActionTarget(
      { kind: "browserTab", port: 9222 },
      { actionKind: "keyboard" }  // keyboard with browserTab — runActionGuard blocks, not here
    );
    // Just verify it doesn't throw
    expect(result).toBeDefined();
  });

  it("returns warnings array even on CDP failure", async () => {
    const result = await resolveActionTarget(
      { kind: "browserTab", port: 9999 },
      { actionKind: "browserCdp" }
    );
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("returns identity null when CDP unavailable", async () => {
    const result = await resolveActionTarget(
      { kind: "browserTab", port: 9222 },
      { actionKind: "browserCdp" }
    );
    expect(result.identity).toBeNull();
  });
});

// ─── B-4: manual lens budget isolation ───────────────────────────────────────

describe("resolveActionTarget — does not pollute manual lens registry (B-4)", () => {
  it("all compiled lens IDs start with auto- (global counter not touched)", async () => {
    // Run more calls than MAX_LENSES (16) to verify no registry growth
    mockEnumWindows.mockReturnValue([{ hwnd: BigInt("1000"), title: "Notepad", isActive: false, zOrder: 1, region: { x:0, y:0, width:800, height:600 } }]);
    const before = compiledLensIds.length;
    for (let i = 0; i < 20; i++) {
      await resolveActionTarget({ kind: "window", titleIncludes: "notepad" }, { actionKind: "keyboard" });
    }
    const newIds = compiledLensIds.slice(before);
    expect(newIds.length).toBe(20);
    expect(newIds.every(id => id.startsWith("auto-"))).toBe(true);
  });
});
