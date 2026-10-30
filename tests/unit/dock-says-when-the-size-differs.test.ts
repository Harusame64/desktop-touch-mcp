/**
 * internal #317 — window_dock answered ok:true when the window did not take the bounds.
 *
 * win2 (2026-10-28): Edge will not go below 516 px wide. Docked bottom-right at 480x360 on a 1920 px
 * monitor it ended at 516x360 with its right edge at 1948, 28 px past the screen, and the reply flagged
 * nothing. On an earlier head of #870 a window stayed maximized and the reply was still ok:true.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  setWindowBounds: vi.fn(),
  rect: { x: 0, y: 0, width: 0, height: 0 } as { x: number; y: number; width: number; height: number } | null,
  maximized: false as boolean | null,
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: () => [{ hwnd: 7n, title: "Edge", zOrder: 0, isMinimized: false, isMaximized: false, isActive: true, isCloaked: false, region: { x: 0, y: 0, width: 800, height: 600 } }],
    enumMonitors: () => [{ id: 0, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, dpi: 96, scale: 100 }],
    setWindowBounds: m.setWindowBounds,
    setWindowTopmost: () => true,
    clearWindowTopmost: () => true,
    restoreAndFocusWindow: vi.fn(),
    getWindowRectByHwnd: () => (m.rect ? { ...m.rect } : null),
    isWindowMaximized: () => m.maximized,
  };
});

import { dockWindowHandler } from "../../src/tools/dock.js";

const args = { title: "Edge", corner: "bottom-right" as const, width: 480, height: 360, pin: false, margin: 8 };
// bottom-right of a 1920x1032 work area with an 8 px margin
const asked = { x: 1920 - 480 - 8, y: 1032 - 360 - 8, width: 480, height: 360 };

function body(r: { content: Array<{ text?: string }> }) {
  return JSON.parse(r.content[0]!.text!) as Record<string, any>;
}

beforeEach(() => {
  m.maximized = false;
  // The window takes whatever position it is given, at the width it allows.
  m.setWindowBounds.mockReset().mockImplementation((_h: unknown, x: number, y: number, w: number, h: number) => {
    m.rect = { x, y, width: Math.max(w, minWidth.value), height: h };
    return true;
  });
});
const minWidth = { value: 0 };

describe("internal #317 — window_dock and a window that does not take the bounds", () => {
  it("says the width differs and places the wider window inside the screen", async () => {
    minWidth.value = 516;
    const r = body(await dockWindowHandler(args));
    expect(r.ok).toBe(true);
    expect(r.requested).toEqual(asked);
    expect(r.sizeDiffers).toEqual(["width"]);
    expect(r.actual).toEqual({ x: 1920 - 516 - 8, y: asked.y, width: 516, height: 360 });
    expect(r.actual.x + r.actual.width).toBeLessThanOrEqual(1920);
    expect(r.hint).toMatch(/kept a size of its own \(516x360, not 480x360\)/);
  });

  it("keeps the top-left inside the work area when the kept size is larger than it (codex on #875)", async () => {
    minWidth.value = 0;
    m.setWindowBounds.mockImplementation((_h: unknown, x: number, y: number, w: number) => {
      m.rect = { x, y, width: w, height: 1100 };
      return true;
    });
    const r = body(await dockWindowHandler(args));
    expect(r.sizeDiffers).toEqual(["height"]);
    expect(r.actual.y).toBe(8);
  });

  it("says nothing when the window took the bounds (the control)", async () => {
    minWidth.value = 0;
    const r = body(await dockWindowHandler(args));
    expect(r.ok).toBe(true);
    expect(r.actual).toEqual(asked);
    expect(r.sizeDiffers).toBeUndefined();
    expect(r.hint).not.toMatch(/size of its own/);
    expect(m.setWindowBounds).toHaveBeenCalledTimes(1);
  });

  it("allows a pixel or two of rounding", async () => {
    minWidth.value = 482;
    const r = body(await dockWindowHandler(args));
    expect(r.sizeDiffers).toBeUndefined();
    expect(m.setWindowBounds).toHaveBeenCalledTimes(1);
  });

  it("refuses a window that stayed maximized", async () => {
    minWidth.value = 0;
    m.maximized = true;
    const r = body(await dockWindowHandler(args));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stayed maximized/);
  });

  it("decides nothing when the maximized state or the rect cannot be read", async () => {
    minWidth.value = 0;
    m.maximized = null;
    m.setWindowBounds.mockImplementation(() => { m.rect = null; return true; });
    const r = body(await dockWindowHandler(args));
    expect(r.ok).toBe(true);
    expect(r.sizeDiffers).toBeUndefined();
  });
});
