/**
 * internal #286 — terminal send to Windows Terminal takes the foreground without asking, and checks
 * its selected tab the way desktop_act does around its question: readable, exactly one pane, and the
 * same tab once the window is in front. The window-in-front refusal is NOT made (the user's decision
 * after gate 2 on #934: `run` leaves the terminal in front, and the next one was refused).
 *
 * Harness from `a-terminal-send-does-not-switch-the-desktop.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    // findTerminalWindow's first try (title-substring match on enum
    // result) hits the target directly when test setup uses
    // `target.title === windowTitle`. The process-identity fallback
    // (getProcessIdentityByPid / getWindowProcessId) is therefore not
    // exercised here — kept unmocked to avoid dead mock surface (Opus
    // PR #209 Round 1 P2-3); if a future test exercises an alias-style
    // `windowTitle: 'pwsh'` against a target titled differently, those
    // mocks will need to be re-added explicitly.
    getWindowClassName: vi.fn(() => "CASCADIA_HOSTING_WINDOW_CLASS"),
    getWindowProcessId: vi.fn(() => 7),
    getProcessIdentityByPid: vi.fn(() => ({ processName: "WindowsTerminal" })),
  };
});

vi.mock("../../src/engine/bg-input.js", () => ({
  // internal #340
  ctrlCNotAlone: (t: string) => t.includes("\u0003") && t !== "\u0003",
  CTRL_C_ALONE_HINT: "send U+0003 alone",
  canInjectViaPostMessage: vi.fn(() => ({ supported: false, reason: "class_unknown" })),
  postCharsToHwnd: vi.fn(),
  postEnterToHwnd: vi.fn(),
  injectViaForegroundFlash: vi.fn(() => ({ ok: true, result: {} })),
  isBgAutoEnabled: vi.fn(() => false),
  TERMINAL_WINDOW_CLASSES: new Set<string>(),
}));

vi.mock("../../src/engine/background-channel-resolver.js", () => ({
  resolveBackgroundInputChannel: vi.fn((hwnd: bigint) => ({ kind: "clipboard_flash", hwnd, pid: 42 })),
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve(null)),
  // internal #221: the desktop manager says the fixture's cloaked windows are on another desktop.
  getVirtualDesktopStatus: vi.fn(async (hs: string[]) => Object.fromEntries(hs.map((h) => [h, false]))),
  getSelectedTab: vi.fn(),
  selectedTabReadable: vi.fn(() => true),
  terminalPaneFocusable: vi.fn(() => true),
  focusTerminalPane: vi.fn(),
}));

vi.mock("../../src/engine/ocr-bridge.js", () => ({
  recognizeWindow: vi.fn(),
  ocrWordsToLines: vi.fn(),
  detectOcrLanguage: () => "en",
}));

vi.mock("../../src/engine/identity-tracker.js", () => ({
  handleObservationKey: (hwnd: bigint) => `hwnd:${hwnd}`,
  observeTarget: vi.fn(() => ({ identity: {}, invalidatedBy: null, previousTarget: null })),
  buildCacheStateHints: vi.fn(() => ({})),
  toTargetHints: vi.fn(() => ({})),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
}));

// ADR-033 PR-2: `typeViaClipboard` reports what happened to the user's
// clipboard, and `terminal(action='send')` forwards that into hints.clipboard.
// Returning `undefined` here would skip that whole branch, so these tests
// would keep passing while the plumbing was broken. `importOriginal` keeps the
// real `clipboardPasteHints` formatting rather than a copy of it.
vi.mock(import("../../src/tools/keyboard.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  typeViaClipboard: vi.fn(() => Promise.resolve({ backend: "native", clipboardRestored: true })),
}));

import { terminalSendHandler, sendFailedWarning } from "../../src/tools/terminal.js";
import * as win32 from "../../src/engine/win32.js";
import * as uia from "../../src/engine/uia-bridge.js";
import * as bg from "../../src/engine/bg-input.js";
import * as kb from "../../src/tools/keyboard.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);
const mockClass = vi.mocked(win32.getWindowClassName);
const mockTab = vi.mocked(uia.getSelectedTab);
const mockPaste = vi.mocked(kb.typeViaClipboard);
const mockFlash = vi.mocked(bg.injectViaForegroundFlash);
const mockInject = vi.mocked(bg.canInjectViaPostMessage);
const mockReadable = vi.mocked(uia.selectedTabReadable);
const mockFocusable = vi.mocked(uia.terminalPaneFocusable);
const mockPaneFocus = vi.mocked(uia.focusTerminalPane);

const WT = 100n;
const OTHER = 900n;

function win(hwnd: bigint, title: string, isActive: boolean, isMinimized = false) {
  return {
    hwnd, title, isActive, zOrder: isActive ? 0 : 1, isMinimized, isMaximized: false, isCloaked: false,
    region: { x: 0, y: 0, width: 800, height: 600 }, processName: "test.exe",
  };
}

/** Which window is in front; the focus move changes it, as Windows does. */
let front: bigint = OTHER;
let wtMinimized = false;
/** A window that refuses to come back in front (Win11's foreground lock on the restore). */
let otherRefusesFront = false;
function screen() {
  return [win(WT, "PowerShell", front === WT, wtMinimized), win(OTHER, "Editor", front === OTHER)];
}

const tab = (runtimeId: string, paneCount = 1) => ({ name: "PowerShell", runtimeId, paneCount });

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

const send = (over: Record<string, unknown> = {}) => terminalSendHandler({
  windowTitle: "PowerShell", input: "echo hi", method: "auto", pressEnter: false, focusFirst: true,
  restoreFocus: true, preferClipboard: true, pasteKey: "auto", trackFocus: false, settleMs: 0, ...over,
});

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
  // The background-road classifier, as bg-input answers for these classes.
  mockInject.mockImplementation((h: unknown) => {
    const cls = mockClass(h);
    if (cls === "CASCADIA_HOSTING_WINDOW_CLASS") return { supported: false, reason: "wt_xaml_pipeline", className: cls };
    if (cls === "ConsoleWindowClass") return { supported: true, className: cls };
    return { supported: true, className: cls, processName: cls === "" ? "" : "notepad" };
  });
  mockTab.mockResolvedValue(tab("rt-1"));
  mockReadable.mockReturnValue(true);
  mockFocusable.mockReturnValue(true);
  mockPaneFocus.mockResolvedValue("focused");
  mockFlash.mockReturnValue({ ok: true, result: {} } as never);
  delete process.env["DESKTOP_TOUCH_FORCE_FOCUS"];
});

describe("internal #286 — terminal:send to Windows Terminal through the foreground", () => {
  it("pastes when its tab is one terminal pane, and the tab is the same after the focus", async () => {
    const r = parseResult(await send());
    expect(r.ok).toBe(true);
    expect(mockPaste).toHaveBeenCalledTimes(1);
    // Read once before the focus and once after it.
    expect(mockTab).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenCalledWith(WT);
  });

  it("pastes when WT is already the window in front (run leaves it there; launch_console opens it there)", async () => {
    front = WT;
    const r = parseResult(await send({ restoreFocus: false }));
    expect(r.ok).toBe(true);
    expect(mockPaste).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tab_split", tab("rt-1", 2)],
    ["tab_not_terminal", tab("rt-1", 0)],
    ["tab_unreadable", undefined],
    ["tab_unreadable", null],
  ] as const)("refuses %s before focusing", async (detail, t) => {
    mockTab.mockResolvedValue(t as never);
    const r = parseResult(await send());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail });
    expect(r.error).toContain("Nothing was typed");
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("refuses when the selected tab changed while WT came forward, and puts the user's window back", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-2"));
    const r = parseResult(await send());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail: "tab_changed", foregroundRestored: true });
    expect(r.error).toContain('(it was "PowerShell")');
    expect(r.error).not.toContain("could not be put back");
    expect(mockPaste).not.toHaveBeenCalled();
    expect(mockRestore).toHaveBeenLastCalledWith(OTHER);
  });

  it("says so when the user's window could not be put back after a late refusal", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-2"));
    otherRefusesFront = true;
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_changed", foregroundRestored: false });
    expect(r.error).toContain("could not be put back");
  });

  it("refuses when the tab became split while WT came forward", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-1", 2));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_split" });
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("puts the user's window back after a late refusal even with restoreFocus:false (run sends it so)", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-2"));
    const r = parseResult(await send({ restoreFocus: false }));
    expect(r.context).toMatchObject({ detail: "tab_changed" });
    expect(mockRestore).toHaveBeenLastCalledWith(OTHER);
  });

  it("puts back the window in front when the focus moved, not the one in front when the call began", async () => {
    // The user moves from the editor into WT while the tab is read: nothing is to be put back.
    mockTab.mockImplementationOnce(async () => { front = WT; return tab("rt-1"); })
      .mockResolvedValueOnce(tab("rt-2"));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_changed" });
    expect(mockRestore).not.toHaveBeenCalledWith(OTHER);
  });

  it("reads a minimized WT's tab only after the focus move restored it", async () => {
    wtMinimized = true;
    mockTab.mockImplementation(async () => (wtMinimized ? undefined : tab("rt-1")));
    const r = parseResult(await send());
    expect(r.ok).toBe(true);
    expect(mockTab).toHaveBeenCalledTimes(1);
    expect(mockPaste).toHaveBeenCalledTimes(1);
  });

  it("refuses when another window came in front during the tab read after the focus move (PR codex)", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockImplementationOnce(async () => { front = OTHER; return tab("rt-1"); });
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "foreground_moved" });
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("refuses a minimized WT whose tab, once restored, is split", async () => {
    wtMinimized = true;
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_split" });
    expect(mockPaste).not.toHaveBeenCalled();
  });

  // internal #370: the paste and the Enter go to WT's focused control (an open find box, a tab item).
  it("puts the focus on the tab's pane, with WT in front, after the second tab read and before the paste", async () => {
    const order: string[] = [];
    mockTab.mockImplementation(async () => { order.push("tab"); return tab("rt-1"); });
    mockPaneFocus.mockImplementation(async () => { order.push(front === WT ? "pane(WT in front)" : "pane(WT behind)"); return "focused"; });
    mockPaste.mockImplementation(async () => { order.push("paste"); return { backend: "native", clipboardRestored: true } as never; });
    const r = parseResult(await send());
    expect(r.ok).toBe(true);
    expect(order).toEqual(["tab", "tab", "pane(WT in front)", "paste"]);
    expect(mockPaneFocus).toHaveBeenCalledWith(WT, "rt-1");
  });

  it("names the tab read after the focus move when the window was minimized (no read before)", async () => {
    wtMinimized = true;
    mockTab.mockImplementation(async () => (wtMinimized ? undefined : tab("rt-9")));
    const r = parseResult(await send());
    expect(r.ok).toBe(true);
    expect(mockPaneFocus).toHaveBeenCalledWith(WT, "rt-9");
  });

  it.each([
    ["not_focused", "pane_not_focused"],
    ["tab_changed", "tab_changed"],
  ] as const)("refuses when the pane focus answers %s, and puts the user's window back", async (answer, detail) => {
    mockPaneFocus.mockResolvedValue(answer);
    const r = parseResult(await send());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail, foregroundRestored: true });
    expect(r.error).toContain("Nothing was typed");
    expect(mockPaste).not.toHaveBeenCalled();
    expect(mockRestore).toHaveBeenLastCalledWith(OTHER);
  });

  it("says so when the pane did not take the focus and the user's window could not be put back", async () => {
    mockPaneFocus.mockResolvedValue("not_focused");
    otherRefusesFront = true;
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "pane_not_focused", foregroundRestored: false });
    expect(r.error).toContain("could not be put back");
  });

  it("refuses before anything moves when this build cannot focus the pane (an older addon)", async () => {
    mockFocusable.mockReturnValue(false);
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "pane_focus_unavailable" });
    expect(r.error).toContain("Sending again gives the same answer");
    expect(r.error).not.toContain("could not be put back");
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockTab).not.toHaveBeenCalled();
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("refuses, and does not take the foreground back, when the native side saw another window in front before SetFocus", async () => {
    // Gate 2 on #936: SetFocus activates WT, so a window the user moved to during the pane's tree reads
    // is checked natively; nothing was focused, and that window keeps the foreground.
    mockPaneFocus.mockImplementation(async () => { front = OTHER; return "foreground_moved"; });
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "foreground_moved" });
    expect(r.context).not.toHaveProperty("foregroundRestored");
    expect(mockPaste).not.toHaveBeenCalled();
    expect(mockRestore).toHaveBeenCalledTimes(1);
  });

  it("refuses when another window came in front during the pane focus", async () => {
    mockPaneFocus.mockImplementation(async () => { front = OTHER; return "focused"; });
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "foreground_moved" });
    expect(mockPaste).not.toHaveBeenCalled();
  });

  it("does not focus the pane when the window in front moved during the tab read (SetFocus would take it back)", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockImplementationOnce(async () => { front = OTHER; return tab("rt-1"); });
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "foreground_moved" });
    expect(mockPaneFocus).not.toHaveBeenCalled();
  });

  it("does not focus the pane with focusFirst:false (the key locker's exit probe) or for a window that is not WT", async () => {
    front = WT;
    expect(parseResult(await send({ focusFirst: false })).ok).toBe(true);
    mockClass.mockReturnValue("ConsoleWindowClass");
    expect(parseResult(await send({ method: "foreground" })).ok).toBe(true);
    expect(mockPaneFocus).not.toHaveBeenCalled();
    expect(mockFocusable).not.toHaveBeenCalled();
  });

  it("checks the same way on method:'foreground' (which a run's exit-mode send forces)", async () => {
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await send({ method: "foreground" }));
    expect(r.context).toMatchObject({ detail: "tab_split" });
  });

  it("does not check with focusFirst:false: the caller types into the window in front on purpose", async () => {
    front = WT;
    const r = parseResult(await send({ focusFirst: false }));
    expect(r.ok).toBe(true);
    expect(mockTab).not.toHaveBeenCalled();
  });

  it("refuses with its own detail when this build cannot read a tab at all, without reading one", async () => {
    mockReadable.mockReturnValue(false);
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_reader_unavailable" });
    expect(r.error).toContain("Sending again gives the same answer");
    expect(mockTab).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("checks a window the classifier calls Windows Terminal by its process, whatever its class", async () => {
    mockClass.mockReturnValue("SomeOtherHostClass");
    mockInject.mockReturnValue({ supported: false, reason: "wt_xaml_pipeline", className: "SomeOtherHostClass", processName: "WindowsTerminal" });
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_split" });
  });

  it("checks a window whose class and process both read empty (a failed read)", async () => {
    mockClass.mockReturnValue("");
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_split" });
  });

  it("checks a window the classifier could not read at all (class_unknown)", async () => {
    mockInject.mockReturnValue({ supported: false, reason: "class_unknown" });
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_split" });
  });

  it("refuses a minimized WT at once when no tab can be read here, without restoring it", async () => {
    wtMinimized = true;
    mockReadable.mockReturnValue(false);
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_reader_unavailable" });
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it("tries the put-back again through AttachThreadInput before saying it failed", async () => {
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-2"));
    mockRestore.mockImplementation((h: unknown, o?: unknown) => {
      if (h === WT) front = WT;
      if (h === OTHER && (o as { force?: boolean } | undefined)?.force) front = OTHER;
      return { x: 0, y: 0, width: 800, height: 600 };
    });
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_changed", foregroundRestored: true });
    expect(mockRestore).toHaveBeenLastCalledWith(OTHER, { force: true });
  });

  it("says WT was left in front when no window was in front before (nothing to put back)", async () => {
    front = 0n;
    mockTab.mockResolvedValueOnce(tab("rt-1")).mockResolvedValueOnce(tab("rt-2"));
    const r = parseResult(await send());
    expect(r.context).toMatchObject({ detail: "tab_changed", foregroundRestored: false });
    expect(r.error).toContain("could not be put back");
  });

  it.each(["ConsoleWindowClass", "Notepad"])("does not check a %s window (control)", async (cls) => {
    mockClass.mockReturnValue(cls);
    const r = parseResult(await send({ method: "foreground" }));
    expect(r.ok).toBe(true);
    expect(mockTab).not.toHaveBeenCalled();
  });
});

describe("internal #286 — terminal:send method:'foreground_flash' to Windows Terminal", () => {
  const flash = () => send({ method: "foreground_flash" });

  it("refuses a split tab, and does not flash", async () => {
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await flash());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail: "tab_split", method: "foreground_flash" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("refuses a minimized WT (the flash does not restore it), and does not flash", async () => {
    wtMinimized = true;
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "minimized", method: "foreground_flash" });
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("flashes into WT that is the window in front", async () => {
    front = WT;
    const r = parseResult(await flash());
    expect(r.ok).toBe(true);
    expect(mockFlash).toHaveBeenCalledTimes(1);
  });

  it("does not check, and adds no pane options, with focusFirst:false (the key locker's exit probe)", async () => {
    mockTab.mockResolvedValue(tab("rt-1", 2));
    const r = parseResult(await send({ method: "foreground_flash", focusFirst: false }));
    expect(r.ok).toBe(true);
    expect(mockTab).not.toHaveBeenCalled();
    const opts = mockFlash.mock.calls[0]![3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("focusTerminalPane");
    expect(opts).not.toHaveProperty("expectedTabRuntimeId");
  });

  it.each([
    ["terminal_tab_changed", "tab_changed"],
    ["terminal_focus_failed", "pane_not_focused"],
  ] as const)("says nothing was typed when the flash fails with %s", async (reason, detail) => {
    mockFlash.mockReturnValue({ ok: false, reason } as never);
    const r = parseResult(await flash());
    expect(r.code).toBe("WindowsTerminalTargetUnsafe");
    expect(r.context).toMatchObject({ detail, method: "foreground_flash", foregroundRestored: true });
    expect(r.error).toContain("Nothing was typed");
  });

  it.each([
    ["terminal_tab_changed", "tab_changed", WT],
    ["terminal_focus_failed", "pane_not_focused", WT],
    // A third window in front is not the user's window back either (agy on #934).
    ["terminal_tab_changed", "tab_changed", 777n],
    ["terminal_focus_failed", "pane_not_focused", 777n],
  ] as const)("says the user's window was not put back when the flash fails with %s and %s is in front", async (reason, detail, after) => {
    mockFlash.mockImplementation(() => { front = after; return { ok: false, reason } as never; });
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail, foregroundRestored: false });
    expect(r.error).toContain("could not be put back");
  });

  it("says the user's window was not put back when the window in front cannot be read before or after the flash", async () => {
    // The tab read is the last step before the flash, so from there on the foreground read throws
    // (agy on #934: `now !== flashPrev` alone reads two failed reads as "back").
    mockTab.mockImplementation(async () => {
      mockEnum.mockImplementation(() => { throw new Error("enum failed"); });
      return tab("rt-1");
    });
    mockFlash.mockReturnValue({ ok: false, reason: "terminal_focus_failed" } as never);
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "pane_not_focused", foregroundRestored: false });
    expect(r.error).toContain("could not be put back");
  });

  it("does not say so when the flash fails and the user's window is back in front", async () => {
    mockFlash.mockReturnValue({ ok: false, reason: "terminal_focus_failed" } as never);
    const r = parseResult(await flash());
    expect(r.context).toMatchObject({ detail: "pane_not_focused", foregroundRestored: true });
    expect(r.error).not.toContain("could not be put back");
  });

  it("hands the flash the tab to hold to and asks it to focus the terminal pane", async () => {
    const r = parseResult(await flash());
    expect(r.ok).toBe(true);
    expect(mockFlash).toHaveBeenCalledWith(WT, 42, "echo hi",
      expect.objectContaining({ focusTerminalPane: true, expectedTabRuntimeId: "rt-1" }));
  });
});

describe("internal #286 — terminal:run says which check refused the send", () => {
  it("carries context.detail next to the code", () => {
    expect(sendFailedWarning({ code: "WindowsTerminalTargetUnsafe", context: { detail: "tab_split" } }))
      .toBe("terminal(action='send') failed: WindowsTerminalTargetUnsafe (tab_split)");
  });
  it("says the terminal was left in front of the user's window", () => {
    expect(sendFailedWarning({ code: "WindowsTerminalTargetUnsafe", context: { detail: "tab_changed", foregroundRestored: false } }))
      .toContain("could not be put back — tell the user first");
    expect(sendFailedWarning({ code: "WindowsTerminalTargetUnsafe", context: { detail: "tab_changed", foregroundRestored: true } }))
      .toBe("terminal(action='send') failed: WindowsTerminalTargetUnsafe (tab_changed)");
  });
  it("is unchanged for a code without a detail, and for no code", () => {
    expect(sendFailedWarning({ code: "ForegroundRestricted" })).toBe("terminal(action='send') failed: ForegroundRestricted");
    expect(sendFailedWarning({})).toBe("terminal(action='send') failed");
  });
});
