/**
 * internal #401 (gate 2 on #970) — BrowserTargetMinimized names the CDP browser's minimized window by
 * hwnd when it is the only one; with several, or no known process, it names none.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ pid: 4242 as number | undefined, windows: [] as Array<{ hwnd: bigint; isMinimized: boolean; className?: string }>, pids: new Map<bigint, number>() }));
vi.mock("../../src/engine/cdp-bridge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/cdp-bridge.js")>()),
  getBrowserProcessId: vi.fn(async () => { if (m.pid === undefined) throw new Error("no CDP"); return m.pid; }),
}));
vi.mock("../../src/engine/win32.js", async (orig) => ({
  ...(await orig<typeof import("../../src/engine/win32.js")>()),
  enumWindowsInZOrder: () => m.windows,
  getWindowProcessId: (h: bigint) => m.pids.get(h) ?? 0,
}));
const { minimizedBrowserFrame } = await import("../../src/tools/browser.js");

const w = (hwnd: bigint, isMinimized: boolean, pid: number, className = "Chrome_WidgetWin_1") => {
  m.pids.set(hwnd, pid);
  return { hwnd, isMinimized, className };
};

describe("minimizedBrowserFrame", () => {
  beforeEach(() => { m.pid = 4242; m.pids.clear(); });
  it("the one minimized window of the CDP browser", async () => {
    m.windows = [w(1n, false, 4242), w(2n, true, 4242), w(3n, true, 999)];
    expect(await minimizedBrowserFrame(9222)).toBe(2n);
  });
  it("two minimized browser windows: none named", async () => {
    m.windows = [w(2n, true, 4242), w(4n, true, 4242)];
    expect(await minimizedBrowserFrame(9222)).toBeUndefined();
  });
  it("not a Chromium window of that process: not counted", async () => {
    m.windows = [w(2n, true, 4242, "Notepad"), w(5n, true, 4242)];
    expect(await minimizedBrowserFrame(9222)).toBe(5n);
  });
  it("the browser's process is not known: none named", async () => {
    m.pid = undefined;
    m.windows = [w(2n, true, 4242)];
    expect(await minimizedBrowserFrame(9222)).toBeUndefined();
  });
  it("process id 0 is not known (as #966 reads it), even where a window's own pid reads 0", async () => {
    m.pid = 0;
    m.windows = [w(6n, true, 0)];
    expect(await minimizedBrowserFrame(9222)).toBeUndefined();
  });
});
