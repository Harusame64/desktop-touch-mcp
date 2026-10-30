/**
 * internal #320 — focus_window with chromeTabUrlContains, given the window's title from before the
 * switch, activated the tab and then answered WindowNotFound: the window's title had become the
 * activated tab's (win2, Edge 156, 2026-10-28).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(),
  restoreAndFocusWindow: vi.fn(),
  getWindowTitleW: vi.fn(),
}));
vi.mock("../../src/engine/window-cache.js", () => ({ updateWindowCache: vi.fn() }));
vi.mock("../../src/engine/cdp-bridge.js", () => ({ listTabs: vi.fn(), activateTab: vi.fn(), DEFAULT_CDP_PORT: 9222 }));
vi.mock("../../src/engine/uia-bridge.js", () => ({ getVirtualDesktopStatus: vi.fn() }));
vi.mock("../../src/engine/nutjs.js", () => ({ getActiveWindow: vi.fn() }));

import { focusWindowHandler } from "../../src/tools/window.js";
import * as win32 from "../../src/engine/win32.js";
import * as cdp from "../../src/engine/cdp-bridge.js";

const EDGE = " および他 1 ページ - [InPrivate] - Microsoft Edge";
const win = (hwnd: bigint, title: string, isActive = false) => ({
  hwnd, title, isActive, zOrder: 0, isMinimized: false, isMaximized: false,
  region: { x: 0, y: 0, width: 800, height: 600 }, processName: "msedge.exe",
});

/** The window list before the activation, then after it; focus lands on whatever was restored. */
function windowsAcrossTheSwitch(before: ReturnType<typeof win>[], after: ReturnType<typeof win>[]) {
  let switched = false;
  let focused: bigint | null = null;
  vi.mocked(cdp.activateTab).mockImplementation(async () => { switched = true; });
  vi.mocked(win32.restoreAndFocusWindow).mockImplementation((h: unknown) => { focused = h as bigint; return { x: 0, y: 0, width: 800, height: 600 }; });
  vi.mocked(win32.enumWindowsInZOrder).mockImplementation(() =>
    (switched ? after : before).map((w) => ({ ...w, isActive: w.hwnd === focused })));
}

function parse(r: { content: { text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

const call = (title: string) => focusWindowHandler({ title, chromeTabUrlContains: "s308.html", cdpPort: 9222 });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["DESKTOP_TOUCH_FORCE_FOCUS"];
  vi.mocked(cdp.listTabs).mockResolvedValue([
    { id: "P", type: "page", url: "file:///p307.html", title: "P307-PAGE" },
    { id: "S", type: "page", url: "file:///s308.html", title: "S308-PAGE" },
  ] as never);
});

describe("internal #320 — focus_window follows the window to the activated tab", () => {
  it("focuses the window named by its title from before the switch", async () => {
    windowsAcrossTheSwitch([win(10n, "P307-PAGE" + EDGE)], [win(10n, "S308-PAGE" + EDGE)]);
    const r = parse(await call("P307-PAGE" + EDGE));
    expect(r.ok).toBe(true);
    expect(r.focused).toBe("S308-PAGE" + EDGE);
    expect(r.activatedTab).toBe("S308-PAGE");
  });

  it("still focuses by a title that matches after the switch (the control)", async () => {
    windowsAcrossTheSwitch([win(10n, "P307-PAGE" + EDGE)], [win(10n, "S308-PAGE" + EDGE)]);
    const r = parse(await call("S308-PAGE"));
    expect(r.ok).toBe(true);
    expect(vi.mocked(win32.restoreAndFocusWindow).mock.calls[0]![0]).toBe(10n);
  });

  it("does not follow a named window that is not showing the activated tab", async () => {
    // Two windows: the title named window 10, which has since moved to another page; the tab is in 20.
    windowsAcrossTheSwitch(
      [win(10n, "P307-PAGE" + EDGE), win(20n, "Other" + EDGE)],
      [win(10n, "Q-PAGE" + EDGE), win(20n, "S308-PAGE" + EDGE)],
    );
    const r = parse(await call("P307-PAGE" + EDGE));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("WindowNotFound");
    expect(r.context.activatedTab).toBe("S308-PAGE");
    expect(win32.restoreAndFocusWindow).not.toHaveBeenCalled();
  });
});
