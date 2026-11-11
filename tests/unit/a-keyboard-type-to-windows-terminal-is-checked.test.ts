/**
 * internal #372 — keyboard type into Windows Terminal makes the checks terminal makes (internal #286,
 * #370): win2's spike on main typed into a split tab's focused pane and into an open find box with
 * ok:true, and the flash into the Settings tab lost the text with ok:true.
 *
 * Harness from `a-keyboard-does-not-switch-the-desktop.test.ts`; the WT cells mirror
 * `a-terminal-send-to-windows-terminal-is-checked.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowClassName: vi.fn(() => "CASCADIA_HOSTING_WINDOW_CLASS"),
  };
});

vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: vi.fn(),
  isAutoGuardEnabled: vi.fn(() => false),
  validateAndPrepareFix: vi.fn(() => null),
  consumeFix: vi.fn(),
  assertKeyboardDestination: vi.fn(() => ({ ok: true })),
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn(),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve("")),
  getTextViaValuePattern: vi.fn(() => Promise.resolve(null)),
  getVirtualDesktopStatus: vi.fn(async (hs: string[]) => Object.fromEntries(hs.map((h) => [h, false]))),
  getSelectedTab: vi.fn(),
  selectedTabReadable: vi.fn(() => true),
  terminalPaneFocusable: vi.fn(() => true),
  focusTerminalPane: vi.fn(),
}));

// internal #371: the client's own tab, read from the live process tree in production.
vi.mock("../../src/engine/wt-own-tab.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/wt-own-tab.js")>()),
  ownTabTitle: vi.fn(async () => ({ state: "not_in_wt" })),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
  withKeyboardLock: async (fn: () => unknown) => fn(),
  rawKeyboard: { type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
}));

vi.mock("../../src/engine/bg-input.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/bg-input.js")>()),
  canInjectViaPostMessage: vi.fn(),
  injectViaForegroundFlash: vi.fn(() => ({ ok: true, result: {} })),
}));

vi.mock("../../src/engine/background-channel-resolver.js", () => ({
  resolveBackgroundInputChannel: vi.fn((hwnd: bigint) => ({ kind: "clipboard_flash", hwnd, pid: 42 })),
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
  checkForegroundOnce: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/tools/_type-focus.js", () => ({
  focusedControlThatTakesNoText: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async ({ windowTitle }) => ({ title: windowTitle, warnings: [] })),
}));

import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
import * as win32 from "../../src/engine/win32.js";
import * as uia from "../../src/engine/uia-bridge.js";
import * as bg from "../../src/engine/bg-input.js";
import * as nut from "../../src/engine/nutjs.js";
import * as typeFocus from "../../src/tools/_type-focus.js";
import * as ownTab from "../../src/engine/wt-own-tab.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);
const mockClass = vi.mocked(win32.getWindowClassName);
const mockTab = vi.mocked(uia.getSelectedTab);
const mockFocusable = vi.mocked(uia.terminalPaneFocusable);
const mockPaneFocus = vi.mocked(uia.focusTerminalPane);
const mockInject = vi.mocked(bg.canInjectViaPostMessage);
const mockFlash = vi.mocked(bg.injectViaForegroundFlash);
const mockType = vi.mocked(nut.keyboard.type);

const WT = 100n;
const OTHER = 900n;

let front: bigint = OTHER;
let wtMinimized = false;
let otherRefusesFront = false;
function win(hwnd: bigint, title: string, isActive: boolean, isMinimized = false) {
  return {
    hwnd, title, isActive, zOrder: isActive ? 0 : 1, isMinimized, isMaximized: false, isCloaked: false,
    region: { x: 0, y: 0, width: 800, height: 600 }, processName: "test.exe",
  };
}
function screen() {
  return [win(WT, "PowerShell", front === WT, wtMinimized), win(OTHER, "Editor", front === OTHER)];
}
const tab = (runtimeId: string, paneCount = 1) => ({ name: "PowerShell", runtimeId, paneCount });
function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}
const type = (over: Record<string, unknown> = {}) => keyboardTypeHandler({
  text: "echo hi", windowTitle: "PowerShell", method: "foreground", use_clipboard: false, replaceAll: false,
  forceKeystrokes: false, trackFocus: false, settleMs: 0, ...over,
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  front = OTHER;
  wtMinimized = false;
  otherRefusesFront = false;
  mockEnum.mockImplementation(() => screen());
  mockRestore.mockImplementation((h: unknown) => {
    if (h === WT) { front = WT; wtMinimized = false; }
    if (h === OTHER && !otherRefusesFront) front = OTHER;
    return { x: 0, y: 0, width: 800, height: 600 };
  });
  mockClass.mockReturnValue("CASCADIA_HOSTING_WINDOW_CLASS");
  mockInject.mockImplementation((h: unknown) => (mockClass(h as bigint) === "CASCADIA_HOSTING_WINDOW_CLASS"
    ? { supported: false, reason: "wt_xaml_pipeline", className: "CASCADIA_HOSTING_WINDOW_CLASS" }
    : { supported: true, className: "Notepad" }) as never);
  mockTab.mockResolvedValue(tab("rt-1"));
  vi.mocked(ownTab.ownTabTitle).mockResolvedValue({ state: "not_in_wt" });
  mockFocusable.mockReturnValue(true);
  mockPaneFocus.mockResolvedValue("focused");
  mockFlash.mockReturnValue({ ok: true, result: {} } as never);
  delete process.env["DESKTOP_TOUCH_FORCE_FOCUS"];
});

describe("internal #372 — keyboard type to Windows Terminal through the foreground", () => {
  it("reads the tab with WT behind, again with WT in front, focuses the pane, then types — and skips the focused-control read", async () => {
    const where = () => (front === WT ? "WT in front" : "WT behind");
    const order: string[] = [];
    mockTab.mockImplementation(async () => { order.push(`tab(${where()})`); return tab("rt-1"); });
    mockPaneFocus.mockImplementation(async () => { order.push(`pane(${where()})`); return "focused"; });
    vi.mocked(typeFocus.focusedControlThatTakesNoText).mockImplementation(async () => { order.push("focused-control read"); return null; });
    mockType.mockImplementation(async () => { order.push("type"); return undefined as never; });
    const r = parseResult(await type());
    expect(r.ok).toBe(true);
    expect([...new Set(order)]).toEqual(["tab(WT behind)", "tab(WT in front)", "pane(WT in front)", "type"]);
    expect(mockPaneFocus).toHaveBeenCalledWith(WT, "rt-1");
  });

  it("still asks the focused-control read for a window that is not WT", async () => {
    mockClass.mockReturnValue("Notepad");
    await type();
    expect(typeFocus.focusedControlThatTakesNoText).toHaveBeenCalled();
  });

  it("sends no Ctrl+A (replaceAll) when the pane focus refuses", async () => {
    mockPaneFocus.mockResolvedValue("not_focused");
    const r = parseResult(await type({ replaceAll: true }));
    expect(r.context).toMatchObject({ detail: "pane_not_focused" });
    expect(nut.keyboard.pressKey).not.toHaveBeenCalled();
    expect(mockType).not.toHaveBeenCalled();
  });

  it.each([
    ["tab_split", tab("rt-1", 2)],
    ["tab_not_terminal", tab("rt-1", 0)],
    ["tab_unreadable", undefined],
  ] as const)("refuses %s before bringing WT forward, and types nothing", async (detail, t) => {
    mockTab.mockResolvedValue(t as never);
    const r = parseResult(await type());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail });
    expect(r.error).toContain("Nothing was typed");
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockType).not.toHaveBeenCalled();
  });

  it.each([
    ["not_focused", "pane_not_focused"],
    ["tab_changed", "tab_changed"],
  ] as const)("refuses when the pane focus answers %s, and puts the user's window back", async (answer, detail) => {
    mockPaneFocus.mockResolvedValue(answer);
    const r = parseResult(await type());
    expect(r.context).toMatchObject({ detail, foregroundRestored: true });
    expect(mockType).not.toHaveBeenCalled();
    expect(mockRestore).toHaveBeenLastCalledWith(OTHER);
  });

  it("refuses when the tab changed while WT came forward", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-2"));
    const r = parseResult(await type());
    expect(r.context).toMatchObject({ detail: "tab_changed" });
    expect(mockType).not.toHaveBeenCalled();
  });

  it("refuses before anything moves when this build cannot focus the pane", async () => {
    mockFocusable.mockReturnValue(false);
    const r = parseResult(await type());
    expect(r.context).toMatchObject({ detail: "pane_focus_unavailable" });
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockType).not.toHaveBeenCalled();
  });

  it("checks a WT that is already in front, and has nothing to put back", async () => {
    front = WT;
    mockPaneFocus.mockResolvedValue("not_focused");
    const r = parseResult(await type());
    expect(r.context).toMatchObject({ detail: "pane_not_focused" });
    expect(r.context).not.toHaveProperty("foregroundRestored");
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("refuses (no put-back) when another window came in front during the pane focus", async () => {
    mockPaneFocus.mockImplementation(async () => { front = OTHER; return "focused"; });
    const r = parseResult(await type());
    expect(r.context).toMatchObject({ detail: "foreground_moved" });
    expect(mockType).not.toHaveBeenCalled();
  });

  it("refuses when the tab read before the move throws inside the focus step, rather than typing unchecked", async () => {
    vi.mocked(uia.selectedTabReadable).mockImplementationOnce(() => { throw new Error("boom"); });
    const r = parseResult(await type());
    expect(r.context).toMatchObject({ detail: "tab_unreadable" });
    expect(mockType).not.toHaveBeenCalled();
  });

  // internal #371
  it("refuses the tab the client runs in before anything moves", async () => {
    vi.mocked(ownTab.ownTabTitle).mockResolvedValue({ state: "title", title: "◐ PowerShell" });
    const r = parseResult(await type());
    expect(r.context).toMatchObject({ detail: "own_tab" });
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockType).not.toHaveBeenCalled();
  });

  it("types, and says the check could not run, when the client's tab cannot be read", async () => {
    vi.mocked(ownTab.ownTabTitle).mockResolvedValue({ state: "unknown", why: "no ancestor below Windows Terminal has a console window" });
    const r = parseResult(await type());
    expect(r.ok).toBe(true);
    expect(mockType).toHaveBeenCalled();
    expect(JSON.stringify(r)).toMatch(/could not be checked/);
  });

  it("does not check a window that is not WT", async () => {
    mockClass.mockReturnValue("Notepad");
    await type();
    expect(mockTab).not.toHaveBeenCalled();
    expect(mockPaneFocus).not.toHaveBeenCalled();
  });

  it("does not check a window whose class cannot be read (keyboard types into every kind of window)", async () => {
    mockInject.mockReturnValue({ supported: false, reason: "class_unknown" } as never);
    await type();
    expect(mockTab).not.toHaveBeenCalled();
  });
});

describe("internal #372 — keyboard type to Windows Terminal with method:'foreground_flash'", () => {
  const flash = () => type({ method: "foreground_flash" });

  it("refuses a split tab and does not flash", async () => {
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "tab_split", method: "foreground_flash" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("refuses the Settings tab (no pane), where the flash lost the text", async () => {
    mockTab.mockResolvedValue(tab("rt-1", 0));
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "tab_not_terminal" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("refuses a minimized WT (the flash does not restore it)", async () => {
    wtMinimized = true;
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "minimized" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("flashes, and says the check could not run, when the client's tab cannot be read", async () => {
    vi.mocked(ownTab.ownTabTitle).mockResolvedValue({ state: "unknown", why: "x" });
    const r = parseResult(await flash());
    expect(r.ok).toBe(true);
    expect(r.hints.warnings.join(" ")).toMatch(/could not be checked/);
  });

  it("refuses the client's tab on the flash too, and does not flash", async () => {
    vi.mocked(ownTab.ownTabTitle).mockResolvedValue({ state: "title", title: "PowerShell" });
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "own_tab", method: "foreground_flash" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("asks the flash to focus the pane of the tab read", async () => {
    const r = parseResult(await flash());
    expect(r.ok).toBe(true);
    const opts = mockFlash.mock.calls[0]![3] as Record<string, unknown>;
    expect(opts).toMatchObject({ focusTerminalPane: true, expectedTabRuntimeId: "rt-1", pressEnter: false });
  });

  it.each([
    ["terminal_tab_changed", "tab_changed"],
    ["terminal_focus_failed", "pane_not_focused"],
  ] as const)("says nothing was typed when the flash fails with %s", async (reason, detail) => {
    mockFlash.mockReturnValue({ ok: false, reason } as never);
    const r = parseResult(await flash());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail, method: "foreground_flash", foregroundRestored: true });
  });

});
