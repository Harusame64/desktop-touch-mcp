/**
 * internal llm22 drive F5 (win2, 2026-10-04, P1): `window_dock(title:'電卓')` on a minimised
 * Calculator moved its hidden, frozen content window (listed above the minimised frame), set it
 * topmost, and answered ok — while the Calculator the user sees stayed minimised. A shown window is
 * docked before a hidden one with the same title; a title that matches only hidden windows is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enumWindowsInZOrder: vi.fn(), setWindowBounds: vi.fn(), restore: vi.fn(), pin: vi.fn(), unpin: vi.fn() }));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: mocks.enumWindowsInZOrder,
    enumMonitors: () => [{ id: 0, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, dpi: 96, scale: 100 }],
    setWindowBounds: mocks.setWindowBounds,
    setWindowTopmost: mocks.pin,
    restoreAndFocusWindow: mocks.restore,
    clearWindowTopmost: mocks.unpin,
    getWindowRectByHwnd: () => ({ x: 8, y: 8, width: 400, height: 600 }),
  };
});

import { dockWindowHandler } from "../../src/tools/dock.js";
import { pinWindowHandler, unpinWindowHandler } from "../../src/tools/pin.js";
import { titleMatchesShownFirst } from "../../src/tools/_title-pick.js";

const base = { region: { x: 0, y: 1, width: 884, height: 591 }, isActive: false, isMaximized: false };
const content = { ...base, hwnd: 4131504n, title: "電卓", zOrder: 0, isMinimized: false, isCloaked: true };
const frame = { ...base, hwnd: 656956n, title: "電卓", zOrder: 12, isMinimized: true, region: { x: 0, y: 0, width: 0, height: 0 } };
const args = { corner: "top-left" as const, width: 400, height: 600, pin: false, margin: 8 };

beforeEach(() => {
  mocks.pin.mockReset().mockReturnValue(true);
  mocks.unpin.mockReset().mockReturnValue(true);
  mocks.setWindowBounds.mockReset().mockReturnValue(true);
  mocks.restore.mockReset();
});

describe("titleMatchesShownFirst", () => {
  it("orders shown matches before hidden ones, keeping z-order within each", () => {
    const shown2 = { ...frame, hwnd: 2n, zOrder: 13 };
    expect(titleMatchesShownFirst([content, frame, shown2], "電卓").map((w) => w.hwnd)).toEqual([656956n, 2n, 4131504n]);
  });
});

describe("window_dock", () => {
  it("docks the shown frame, not the hidden content listed above it", async () => {
    mocks.enumWindowsInZOrder.mockReturnValue([content, frame]);
    await dockWindowHandler({ title: "電卓", ...args });
    const moved = mocks.setWindowBounds.mock.calls.map((c) => c[0]);
    expect(moved).toContain(656956n);
    expect(moved).not.toContain(4131504n);
  });

  it("refuses when only a hidden window matches, instead of answering ok", async () => {
    mocks.enumWindowsInZOrder.mockReturnValue([content]);
    const result = await dockWindowHandler({ title: "電卓", ...args });
    const body = JSON.parse((result.content[0] as { text: string }).text) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/only a hidden one/);
    expect(mocks.setWindowBounds).not.toHaveBeenCalled();
  });
});

describe("window_dock pin / unpin", () => {
  it("pins the shown (minimised) frame, not the hidden content", async () => {
    mocks.enumWindowsInZOrder.mockReturnValue([content, frame]);
    await pinWindowHandler({ title: "電卓" });
    expect(mocks.pin.mock.calls.map((c) => c[0])).toEqual([656956n]);
  });

  it("refuses to pin when only a hidden window matches", async () => {
    mocks.enumWindowsInZOrder.mockReturnValue([content]);
    const result = await pinWindowHandler({ title: "電卓" });
    expect((result.content[0] as { text: string }).text).toMatch(/only a hidden one/);
    expect(mocks.pin).not.toHaveBeenCalled();
  });

  it("still unpins a hidden window, so a topmost flag set on one can be taken off", async () => {
    mocks.enumWindowsInZOrder.mockReturnValue([content]);
    await unpinWindowHandler({ title: "電卓" });
    expect(mocks.unpin.mock.calls.map((c) => c[0])).toEqual([4131504n]);
  });
});

describe("window_dock pin / unpin — gate 2 on #772", () => {
  it("says a pinned window is minimised, instead of a bare ok", async () => {
    mocks.enumWindowsInZOrder.mockReturnValue([frame]);
    const body = JSON.parse(((await pinWindowHandler({ title: "電卓" })).content[0] as { text: string }).text) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, minimized: true });
  });

  it("unpins the hidden match that carries the flag, even while the shown frame matches too", async () => {
    mocks.enumWindowsInZOrder.mockReturnValue([{ ...content, exStyle: 0x200008 }, { ...frame, exStyle: 0x200000 }]);
    await unpinWindowHandler({ title: "電卓" });
    expect(mocks.unpin.mock.calls.map((c) => c[0])).toEqual([4131504n]);
  });
});
