/**
 * internal #269: desktop_state.hasModal was a title regex over the windows on screen. It took
 * Notepad showing error.log for a dialog and missed Notepad's 保存しますか and VS Code's Open File
 * and save prompt, whose titles read like their apps. A modal is now told by the window it blocks —
 * a window on screen that is disabled; a dialog with no owner (a message box) still goes by its title.
 *
 * The rows are the windows measured on win2 (2026-11-10, main 55804fca, D:\git\temp\i269\*.json),
 * reduced to the fields the rule reads.
 */
import { describe, expect, it, vi } from "vitest";

const { wins } = vi.hoisted(() => ({ wins: { value: [] as unknown[] } }));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => wins.value),
    enumMonitors: vi.fn(() => [{ index: 0, isPrimary: true, region: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96 }]),
    getVirtualScreen: vi.fn(() => ({ x: 0, y: 0, width: 1920, height: 1080 })),
    getWindowProcessId: vi.fn(() => 1234),
    getProcessIdentityByPid: vi.fn(() => ({ pid: 1234, processName: "notepad.exe", processStartTimeMs: 900 })),
  };
});
vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return { ...actual, nativeViewFocus: { viewGetFocused: () => null }, nativeWin32: undefined };
});
vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return { ...actual, getFocusedAndPointInfo: vi.fn(async () => ({ focused: null, atPoint: null })) };
});
vi.mock("../../src/engine/cdp-bridge.js", () => ({ evaluateInTab: vi.fn(async () => null), DEFAULT_CDP_PORT: 9222 }));
vi.mock("../../src/engine/nutjs.js", () => ({ mouse: { getPosition: async () => ({ x: 5000, y: 5000 }) } }));

const { desktopStateHandler } = await import("../../src/tools/desktop-state.js");

const win = (hwnd: bigint, title: string, className: string, over: Record<string, unknown> = {}) => ({
  hwnd, title, className, zOrder: Number(hwnd), isActive: false, isMinimized: false, isMaximized: false,
  ownerHwnd: null, isEnabled: true, region: { x: 0, y: 0, width: 800, height: 600 }, processName: "x",
  ...over,
});
const read = async () => JSON.parse(((await desktopStateHandler({})) as { content: Array<{ text: string }> }).content[0]!.text);

describe("hasModal: a window on screen that is disabled (measured on win2)", () => {
  it.each([
    ["Notepad's 名前を付けて保存", [win(1n, "名前を付けて保存", "#32770", { ownerHwnd: 2n }), win(2n, "*無題 - メモ帳", "Notepad", { isEnabled: false })]],
    ["Notepad's 保存しますか, titled like the app", [win(1n, "メモ帳", "#32770", { ownerHwnd: 2n }), win(2n, "*無題 - メモ帳", "Notepad", { isEnabled: false })]],
    ["VS Code's Open File", [win(1n, "Open File", "#32770", { ownerHwnd: 2n }), win(2n, "Welcome - Visual Studio Code", "Chrome_WidgetWin_1", { isEnabled: false })]],
    ["VS Code's save prompt, titled like the app", [win(1n, "Visual Studio Code", "#32770", { ownerHwnd: 2n }), win(2n, "Untitled-1 - Visual Studio Code", "Chrome_WidgetWin_1", { isEnabled: false })]],
    ["an ownerless MessageBox titled 確認", [win(1n, "確認", "#32770")]],
    // A thread-modal dialog disables windows it does not own (a task-modal MessageBox, a WPF
    // ShowDialog with no Owner): the blocked window says so whatever owns what.
    ["a window disabled by a modal it does not own", [win(1n, "Options", "HwndWrapper[App;;1]"), win(2n, "Main - App", "HwndWrapper[App;;2]", { isEnabled: false })]],
    ["the dialog minimised, its owner on screen and disabled (gate 2 on #801)", [win(1n, "x", "#32770", { ownerHwnd: 2n, isMinimized: true }), win(2n, "Doc", "Notepad", { isEnabled: false })]],
  ])("%s is a modal", async (_name, rows) => {
    wins.value = rows;
    const out = await read();
    expect(out.hasModal).toBe(true);
    expect(out.pageState).toBe("dialog");
  });

  it.each([
    ["Notepad showing error.log (owns nothing)", [win(1n, "error.log - メモ帳", "Notepad")]],
    // The properties sheet's owner is a hidden, disabled StubWindow32 that the window list does not hold.
    ["a file's properties, owner not listed", [win(1n, "error.logのプロパティ", "#32770", { ownerHwnd: 9n }), win(2n, "Downloads", "CabinetWClass")]],
    ["a disabled window that is minimised", [win(1n, "Doc - App", "Notepad", { isEnabled: false, isMinimized: true })]],
    ["a disabled window on another desktop", [win(1n, "Doc - App", "Notepad", { isEnabled: false, isCloaked: true })]],
    ["a browser tab whose page title reads like a dialog", [win(1n, "Error 404 - Google Chrome", "Chrome_WidgetWin_1")]],
    ["an owned window whose owner is enabled (modeless)", [win(1n, "検索", "#32770", { ownerHwnd: 2n }), win(2n, "Doc", "Notepad")]],
    ["an ownerless dialog-class window that does not read like a dialog", [win(1n, "Settings", "#32770")]],
    ["an ownerless window of another class titled like a dialog", [win(1n, "確認", "Notepad")]],
  ])("%s is not", async (_name, rows) => {
    wins.value = rows;
    const out = await read();
    expect(out.hasModal).toBe(false);
    expect(out.pageState).not.toBe("dialog");
  });

  it.each([
    ["minimised", { isMinimized: true }],
    ["on another desktop (internal #253)", { isCloaked: true }],
  ])("an ownerless dialog %s is not (only a shown one reads)", async (_name, hidden) => {
    wins.value = [win(1n, "確認", "#32770", hidden)];
    expect((await read()).hasModal).toBe(false);
  });
});
