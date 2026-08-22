/**
 * tests/unit/resolve-action-target.test.ts
 * Unit tests for resolveActionTarget and normalizeTitle.
 * window: 8 cases, coordinate: 5 cases, browserTab: 5 cases
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mocks ───────────────────────────────────────────────────────────────

const { mockEnumWindows, mockBuildWindowIdentity, mockRefreshWin32Fluents,
        mockFindContainingWindow, mockGetCachedWindowByTitle,
        mockGetWindowProcessId, mockListTabsLight } = vi.hoisted(() => ({
  mockEnumWindows: vi.fn(),
  mockBuildWindowIdentity: vi.fn(),
  mockRefreshWin32Fluents: vi.fn(),
  mockFindContainingWindow: vi.fn(),
  mockGetCachedWindowByTitle: vi.fn(),
  mockGetWindowProcessId: vi.fn(),
  mockListTabsLight: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: mockEnumWindows,
  // Used by the coordinate path's title-hint verdict. The allowance is pid
  // equality, which covers owned dialogs and same-application siblings alike.
  getWindowProcessId: mockGetWindowProcessId,
}));

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: mockRefreshWin32Fluents,
  buildWindowIdentity: mockBuildWindowIdentity,
}));

vi.mock("../../src/engine/window-cache.js", () => ({
  findContainingWindow: mockFindContainingWindow,
  // The coordinate path uses the refreshing variant (a miss re-enumerates once
  // before giving up). Delegating keeps these cases about what they were always
  // about — hit vs miss — while the refresh behaviour itself is pinned against
  // the real cache in `window-cache-staleness.test.ts`.
  findContainingWindowFresh: mockFindContainingWindow,
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
  mockGetWindowProcessId.mockReset();
  mockGetWindowProcessId.mockReturnValue(0);
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

  it("delivers into a SIBLING window of the same process, not just an owned dialog", async () => {
    // The same-process allowance is pid equality, which is wider than
    // ownership: one process routinely owns several unrelated top-level windows
    // (every Chrome window, every File Explorer window, two Windows Terminal
    // windows measured on this project at pid 16372). So naming one of those
    // and landing in a sibling is DELIVERED, not refused.
    //
    // Pinned deliberately. It is not a regression — that click was delivered
    // before this change too — but it is the shape the CHANGELOG has to
    // describe honestly, and tightening it later must be a decision somebody
    // makes on purpose rather than a quiet side effect.
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("3001"), title: "Downloads", zOrder: 0 });
    mockEnumWindows.mockReturnValue([
      { hwnd: BigInt("3001"), title: "Downloads", zOrder: 0 },
      { hwnd: BigInt("3002"), title: "Documents", zOrder: 1 },
    ]);
    mockGetWindowProcessId.mockReturnValue(4242);   // one explorer.exe for both

    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "Documents" },
      { actionKind: "mouseClick" }
    );

    expect(result.titleMismatch).toBeUndefined();
    expect(result.lens).not.toBeNull();
    expect(result.warnings.some(w => w.includes("same process"))).toBe(true);
  });

  it("no warning when windowTitle hint matches containing window", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("1000"), title: "Untitled - Notepad", zOrder: 1 });
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "notepad" },
      { actionKind: "mouseClick" }
    );
    const hasMismatchWarning = result.warnings.some(w => w.includes("does not match"));
    expect(hasMismatchWarning).toBe(false);
    // The negative control: a matching title still resolves normally.
    expect(result.titleMismatch).toBeUndefined();
    expect(result.lens).not.toBeNull();
  });

  it("uses containing window hwnd (not getCachedWindowByTitle) for coordinate kind", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("3000"), title: "Paint", zOrder: 1 });
    const result = await resolveActionTarget({ kind: "coordinate", x: 50, y: 50 }, { actionKind: "mouseClick" });
    expect(result.lens?.binding.hwnd).toBe("3000");
    expect(mockGetCachedWindowByTitle).not.toHaveBeenCalled();
  });
});

// ─── Coordinate kind — title-hint verdict (Round 2 P1-1 scope-down) ──────────
//
// The mismatch refusal must be based on window identity, not title text.
// The negative controls pin the three workflows the string predicate
// false-refused: a bare browser name against a suffixed title, an owned
// dialog clicked under the parent application's title, and a window whose
// cached title is stale while its live title matches the hint.

describe("resolveActionTarget — coordinate title hint", () => {
  it("accepts a bare browser name against a suffixed containing title, without enumerating", async () => {
    // normalizeTitle strips " - Google Chrome" from the window title but not
    // from the bare hint, so normalized containment is structurally false —
    // the raw form must be consulted first. This is the tool's own documented
    // windowTitle example ("Google Chrome").
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("4000"), title: "Claude - Google Chrome", zOrder: 1 });
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "Google Chrome" },
      { actionKind: "mouseClick" }
    );
    expect(result.titleMismatch).toBeUndefined();
    expect(result.lens).not.toBeNull();
    expect(mockEnumWindows).not.toHaveBeenCalled();
  });

  it("accepts when the containing window matches under its live title (cache held the previous title)", async () => {
    // Terminals retitle on every command; hwnd / "@active" hints are the live
    // title by construction, while the cache may still hold the old one for
    // the very same window.
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("5000"), title: "PowerShell", zOrder: 1 });
    mockEnumWindows.mockReturnValue([makeWindow("5000", "npm run build - Windows Terminal")]);
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "npm run build" },
      { actionKind: "mouseClick" }
    );
    expect(result.titleMismatch).toBeUndefined();
    expect(result.lens).not.toBeNull();
    expect(result.lens?.binding.hwnd).toBe("5000");
  });

  it("delivers with a warning when the hint names another window of the same process (owned dialog)", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("2000"), title: "名前を付けて保存", zOrder: 1 });
    mockEnumWindows.mockReturnValue([
      makeWindow("1000", "無題 - メモ帳"),
      makeWindow("2000", "名前を付けて保存"),
    ]);
    mockGetWindowProcessId.mockReturnValue(77); // both windows: same process
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "メモ帳" },
      { actionKind: "mouseClick" }
    );
    expect(result.titleMismatch).toBeUndefined();
    expect(result.lens).not.toBeNull();
    expect(result.lens?.binding.hwnd).toBe("2000"); // the dialog, not the parent
    expect(result.warnings.some((w) => w.includes("same process"))).toBe(true);
  });

  it("refuses when the hint names a live window of a different process", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("2000"), title: "Other App", zOrder: 1 });
    mockEnumWindows.mockReturnValue([
      makeWindow("1000", "MyApp — main"),
      makeWindow("2000", "Other App"),
    ]);
    mockGetWindowProcessId.mockImplementation((h: unknown) => (String(h) === "2000" ? 88 : 77));
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "MyApp" },
      { actionKind: "mouseClick" }
    );
    expect(result.lens).toBeNull();
    expect(result.titleMismatch).toEqual({ requested: "MyApp", resolved: "Other App", kind: "different_window" });
  });

  it("refuses as not_found when the hint matches no open window", async () => {
    // The reported symptom itself: a click naming a window that is gone must
    // not be delivered to whatever now occupies the point.
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("2000"), title: "Calculator", zOrder: 1 });
    mockEnumWindows.mockReturnValue([makeWindow("2000", "Calculator")]);
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "Ghost App" },
      { actionKind: "mouseClick" }
    );
    expect(result.lens).toBeNull();
    expect(result.titleMismatch).toEqual({ requested: "Ghost App", resolved: "Calculator", kind: "not_found" });
  });

  it("refuses fail-closed when the desktop cannot be enumerated to verify the mismatch", async () => {
    mockFindContainingWindow.mockReturnValue({ hwnd: BigInt("2000"), title: "Calculator", zOrder: 1 });
    mockEnumWindows.mockImplementation(() => { throw new Error("native addon unavailable"); });
    const result = await resolveActionTarget(
      { kind: "coordinate", x: 100, y: 100, windowTitle: "Notepad" },
      { actionKind: "mouseClick" }
    );
    expect(result.lens).toBeNull();
    expect(result.titleMismatch).toEqual({ requested: "Notepad", resolved: "Calculator", kind: "different_window" });
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
