/**
 * internal #245 — the parts of the acted-on window the post-act read (and the pre-act watch) count.
 *
 * MEASURED win2 (2026-10-04, internal `spike/245-hidden-act-observation`): a covered label that
 * changed read `no_change` 10 of 12 times, and a video behind the target crossed its rect and read as
 * the act's change. Gate 2 on #771: a full-screen layered overlay at the top of win2's desktop (Dell's
 * EAWorkWindow, `point-owner.ts`) must not be taken for a cover, and a part past the monitor the watch
 * reads never reports.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enumWindowsInZOrder: vi.fn(),
  visibleFrame: vi.fn(),
  monitors: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: mocks.enumWindowsInZOrder,
    getVisibleFrameRectByHwnd: mocks.visibleFrame,
    enumMonitors: mocks.monitors,
  };
});

import { visibleRegionOf } from "../../src/tools/desktop-register.js";

const RECT = { x: 93, y: 100, width: 914, height: 607 };
const FRAME = { x: 100, y: 100, width: 900, height: 600 };
const SCREEN = { x: 0, y: 0, width: 1920, height: 1032 };
const win = (hwnd: bigint, zOrder: number, region: typeof FRAME, over: Record<string, unknown> = {}) =>
  ({ hwnd, title: `w${hwnd}`, zOrder, region, isActive: false, isMinimized: false, isMaximized: false, ...over });

function setup(wins: unknown[]) {
  mocks.enumWindowsInZOrder.mockReset().mockReturnValue(wins);
  mocks.visibleFrame.mockReset().mockImplementation((h: bigint) => (h === 1n ? FRAME : null));
  mocks.monitors.mockReset().mockReturnValue([{ bounds: SCREEN }]);
}

const area = (parts: Array<{ width: number; height: number }>) => parts.reduce((s, p) => s + p.width * p.height, 0);

describe("visibleRegionOf", () => {
  it("reads the visible frame, not the rect with its invisible border", () => {
    setup([win(1n, 0, RECT)]);
    expect(visibleRegionOf(1n, RECT)).toEqual({ frame: FRAME, visible: [FRAME] });
  });

  it("subtracts a window above that covers part of it", () => {
    setup([win(2n, 0, { x: 0, y: 0, width: 550, height: 1032 }), win(1n, 1, RECT)]);
    expect(area(visibleRegionOf(1n, RECT).visible)).toBe(450 * 600);
  });

  it("does not take a layered window above for a cover (a full-screen overlay would cover every window)", () => {
    setup([win(9n, 0, SCREEN, { exStyle: 0x0008_0000 | 0x80 | 0x8 }), win(1n, 1, RECT)]);
    expect(visibleRegionOf(1n, RECT).visible).toEqual([FRAME]);
  });

  it("does not take a minimised or cloaked window, or one below, for a cover", () => {
    setup([
      win(3n, 0, SCREEN, { isMinimized: true }),
      win(4n, 1, SCREEN, { isCloaked: true }),
      win(1n, 2, RECT),
      win(5n, 3, SCREEN),
    ]);
    expect(visibleRegionOf(1n, RECT).visible).toEqual([FRAME]);
  });

  it("leaves out the part past the monitor the read watches", () => {
    setup([win(1n, 0, RECT)]);
    mocks.monitors.mockReturnValue([{ bounds: { x: 0, y: 0, width: 600, height: 1032 } }]);
    // The window's centre (550, 403) is on this monitor; its right 400 px are past it.
    const { frame, visible } = visibleRegionOf(1n, RECT);
    expect(frame).toEqual(FRAME);
    expect(area(visible)).toBe(500 * 600);
  });
});
