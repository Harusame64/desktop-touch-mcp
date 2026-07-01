// ADR-014 v2 R3 Key Locker — getWindows() tool-exclusion filter (Codex R1 P1-B).
//
// getWindows() is nut-js's OWN enumerator (separate from win32's enumWindowsInZOrder) behind
// screenshot(mode:'background') title-match, the window list, workspace, and macro. While a Key
// Locker is alive its windows must be dropped here too, else a caller who knows the fixed title
// could capture the secure dialog through this path. This suite mocks the raw nut-js library +
// the two exclusion deps and exercises the production wrapper directly.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockRawGetWindows, mockHasExcludedPids, mockIsExcludedWindowHandle } = vi.hoisted(() => ({
  mockRawGetWindows: vi.fn(),
  mockHasExcludedPids: vi.fn<() => boolean>(),
  mockIsExcludedWindowHandle: vi.fn<(h: unknown) => boolean>(),
}));

vi.mock("@nut-tree-fork/nut-js", () => ({
  mouse: { config: { autoDelayMs: 0, mouseSpeed: 0 } },
  keyboard: { config: { autoDelayMs: 0 }, pressKey: vi.fn(), releaseKey: vi.fn(), type: vi.fn() },
  screen: {},
  getWindows: mockRawGetWindows,
  getActiveWindow: vi.fn(),
  Key: {}, Button: {}, Point: class {}, Region: class {}, Size: class {},
  straightTo: vi.fn(), up: vi.fn(), down: vi.fn(), left: vi.fn(), right: vi.fn(),
}));
vi.mock("../../src/engine/win32.js", () => ({ isExcludedWindowHandle: mockIsExcludedWindowHandle }));
vi.mock("../../src/engine/tool-exclusion.js", () => ({ hasExcludedPids: mockHasExcludedPids }));

import { getWindows } from "../../src/engine/nutjs.js";

// nut-js Window stand-ins — only .windowHandle is read by the filter.
const winA = { windowHandle: 111 };
const winLocker = { windowHandle: 222 };

beforeEach(() => {
  mockRawGetWindows.mockReset().mockResolvedValue([winA, winLocker]);
  mockHasExcludedPids.mockReset();
  mockIsExcludedWindowHandle.mockReset().mockReturnValue(false);
});

describe("getWindows() — R3 tool-exclusion filter", () => {
  it("returns the raw nut-js list unfiltered when no locker is alive (zero overhead)", async () => {
    mockHasExcludedPids.mockReturnValue(false);
    const wins = await getWindows();
    expect(wins).toEqual([winA, winLocker]);
    expect(mockIsExcludedWindowHandle).not.toHaveBeenCalled(); // gated out entirely
  });

  it("drops a window whose handle is excluded while armed", async () => {
    mockHasExcludedPids.mockReturnValue(true);
    mockIsExcludedWindowHandle.mockImplementation((h) => h === 222);
    const wins = await getWindows();
    expect(wins).toEqual([winA]);
    expect(mockIsExcludedWindowHandle).toHaveBeenCalledWith(222);
  });

  it("keeps every window while armed when none is excluded", async () => {
    mockHasExcludedPids.mockReturnValue(true);
    mockIsExcludedWindowHandle.mockReturnValue(false);
    const wins = await getWindows();
    expect(wins).toEqual([winA, winLocker]);
  });
});
