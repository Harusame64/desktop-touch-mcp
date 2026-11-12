/**
 * internal #382 / #221 — scroll(action='smart') on the image road does not bring a window on another
 * virtual desktop forward: that switches the user's desktop (the keyboard tool measured it, #221).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRestore, mockAway, listed } = vi.hoisted(() => ({
  mockRestore: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
  mockAway: vi.fn(),
  listed: { isEnabled: true as boolean },
}));

vi.mock("../../src/engine/cdp-bridge.js", () => ({
  evaluateInTab: vi.fn(), getScrollAncestorsCdp: vi.fn(), detectStickyHeaderCdp: vi.fn(),
  setScrollPositionCdp: vi.fn(), scrollVirtualListCdp: vi.fn(),
}));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getScrollAncestors: vi.fn().mockResolvedValue([]), scrollByPercent: vi.fn(), scrollElementIntoView: vi.fn(),
}));
vi.mock("../../src/engine/win32.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
  readScrollInfo: vi.fn().mockReturnValue(null),
  enumWindowsInZOrder: vi.fn(() => [
    { hwnd: 100n, title: "Docs - Editor", isCloaked: true, isEnabled: listed.isEnabled, region: { x: 0, y: 0, width: 800, height: 600 } },
  ]),
  restoreAndFocusWindow: mockRestore,
  getForegroundHwnd: vi.fn(() => 100n),
  getWindowRoot: vi.fn((h: bigint) => h),
  getWindowTitleW: vi.fn(() => "Docs - Editor"),
  getWindowClassName: vi.fn(() => "Notepad"),
  isWindowEnabled: vi.fn(() => true),
}));
vi.mock("../../src/engine/image.js", () => ({
  dHashFromRaw: vi.fn(), hammingDistance: vi.fn(), extractStripRaw: vi.fn(), detectScrollThumbFromStrip: vi.fn(),
}));
vi.mock("../../src/engine/layer-buffer.js", () => ({ captureWindowRawAndHash: vi.fn(), getCachedRaw: vi.fn() }));
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { scrollDown: vi.fn(), scrollUp: vi.fn(), scrollLeft: vi.fn(), scrollRight: vi.fn() },
}));
vi.mock("../../src/utils/desktop-config.js", () => ({ getCdpPort: vi.fn(() => 9222) }));
vi.mock("../../src/tools/_off-desktop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_off-desktop.js")>();
  return { ...actual, offDesktopTarget: mockAway };
});

const { smartScrollHandler } = await import("../../src/tools/smart-scroll.js");

const params = {
  target: "Chapter 3", windowTitle: "Docs", strategy: "image" as const, direction: "into-view" as const,
  inline: "center" as const, maxDepth: 3, retryCount: 1, verifyWithHash: false, virtualIndex: undefined,
  virtualTotal: undefined, expandHidden: false, port: 9222,
} as never;

beforeEach(() => { vi.clearAllMocks(); listed.isEnabled = true; });

describe("internal #382 — smart scroll's image road and another virtual desktop", () => {
  it("refuses, and does not bring the window forward", async () => {
    mockAway.mockResolvedValue({ hwnd: 100n, title: "Docs - Editor", sameTitleOnScreen: false });
    const r = await smartScrollHandler(params);
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.code).toBe("WindowOnOtherDesktop");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("a window on this desktop is brought forward as before (control)", async () => {
    mockAway.mockResolvedValue(null);
    await smartScrollHandler(params).catch(() => undefined);
    expect(mockRestore).toHaveBeenCalledWith(100n);
  });

  it("a window its dialog has disabled is not brought forward (internal #381: it took the dialog's focus)", async () => {
    mockAway.mockResolvedValue(null);
    listed.isEnabled = false;
    const r = await smartScrollHandler(params);
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.code).toBe("WindowBlockedByDialog");
    expect(mockRestore).not.toHaveBeenCalled();
  });
});
