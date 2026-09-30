/**
 * internal #227 — desktop_act and a Windows Terminal window.
 *
 * WT takes no posted characters (`wt_xaml_pipeline`), so the background send always failed and the
 * act ended `executor_failed`. Now the user is asked, and on Accept the text is pasted through the
 * foreground (the road `terminal(send, method:'foreground_flash')` takes). Built on the production
 * closures (`createDesktopExecutor` without injected deps), as `resolve-log-desktop-act.test.ts` is.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const WT = 0x100n;
const wtWindow = (extra: Record<string, unknown> = {}) => ({
  hwnd: WT, title: "PowerShell", region: { x: 0, y: 0, width: 100, height: 100 }, zOrder: 0,
  isMinimized: false, isMaximized: false, isActive: false, className: "CASCADIA_HOSTING_WINDOW_CLASS", ownerHwnd: null, ...extra,
});
const { state } = vi.hoisted(() => ({ state: { cloaked: false } }));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [wtWindow({ isCloaked: state.cloaked })]),
    getForegroundHwnd: vi.fn(() => 0x999n),
    getWindowTitleW: vi.fn(() => "PowerShell"),
    getWindowIdentity: vi.fn(() => ({ pid: 11, processName: "WindowsTerminal.exe", processStartTimeMs: 0 })),
  };
});

const mockFlash = vi.fn((..._a: unknown[]) => ({ ok: true, result: {} }));
const mockPostChars = vi.fn();
vi.mock("../../src/engine/bg-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/bg-input.js")>();
  return {
    ...actual,
    canInjectViaPostMessage: vi.fn(() => ({ supported: false, reason: "wt_xaml_pipeline", className: "CASCADIA_HOSTING_WINDOW_CLASS" })),
    postCharsToHwnd: (...a: unknown[]) => mockPostChars(...a),
    injectViaForegroundFlash: (...a: unknown[]) => mockFlash(...a),
  };
});

vi.mock("../../src/engine/background-channel-resolver.js", () => ({
  resolveBackgroundInputChannel: vi.fn((hwnd: bigint) => ({ kind: "clipboard_flash", hwnd, pid: 42 })),
}));

vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/uia-bridge.js")>()),
  // A cloaked window here is on another desktop (internal #221).
  getVirtualDesktopStatus: vi.fn(async (hs: string[]) => Object.fromEntries(hs.map((h) => [h, false]))),
}));

const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
const { runWithAskContext, resetRememberedTerminalForeground } = await import("../../src/tools/_ask-user.js");
type UiEntity = import("../../src/engine/world-graph/types.js").UiEntity;
type AskContext = import("../../src/tools/_ask-user.js").AskContext;

const terminalInput = {
  entityId: "e1", role: "textbox", label: "terminal input", confidence: 0.9, sources: ["terminal"],
  affordances: [{ verb: "type", executors: ["terminal"], confidence: 0.9, preconditions: [], postconditions: [] }],
  generation: "gen-1", evidenceDigest: "d-e1",
} as unknown as UiEntity;

function asking(answer: Awaited<ReturnType<AskContext["ask"]>>) {
  const ask = vi.fn(async () => answer);
  return { ctx: { ask } as AskContext, ask };
}

const act = (text: string, ctx: AskContext | null) =>
  runWithAskContext(ctx, () => createDesktopExecutor({ windowTitle: "PowerShell" })(terminalInput, "type", text));

beforeEach(() => {
  vi.clearAllMocks();
  resetRememberedTerminalForeground();
  state.cloaked = false;
  delete process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND;
});

describe("internal #227 — desktop_act types into Windows Terminal only when the user allows it", () => {
  it("asks, and on Accept pastes through the foreground; a trailing newline is sent as Enter", async () => {
    const { ctx, ask } = asking({ action: "accept", content: { dontAskAgain: false } });
    await act("echo hi\n", ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(mockFlash).toHaveBeenCalledWith(WT, 42, "echo hi", { pressEnter: true });
    expect(mockPostChars).not.toHaveBeenCalled();
  });

  it("pastes without Enter when the text has no trailing newline", async () => {
    await act("echo hi", asking({ action: "accept", content: {} }).ctx);
    expect(mockFlash).toHaveBeenCalledWith(WT, 42, "echo hi", { pressEnter: false });
  });

  it.each([
    [{ action: "decline" as const }, /the user declined/],
    [{ action: "cancel" as const }, /the question was dismissed/],
  ])("types nothing, and says why, on %o", async (answer, detail) => {
    const err = await act("echo hi", asking(answer).ctx).catch((e) => e);
    expect(err?.callerDetail).toMatch(detail);
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("types nothing when the call cannot ask, and names the ways the user can allow it", async () => {
    const err = await act("echo hi", null).catch((e) => e);
    expect(err?.callerDetail).toMatch(/cannot ask the user.*foreground_flash.*DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND=1/);
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("does not ask about more than one line, and types nothing", async () => {
    const { ctx, ask } = asking({ action: "accept", content: {} });
    const err = await act("echo a\necho b", ctx).catch((e) => e);
    expect(err?.callerDetail).toMatch(/more than one line/);
    expect(ask).not.toHaveBeenCalled();
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("does not ask about a terminal on another virtual desktop, and types nothing (internal #221)", async () => {
    state.cloaked = true;
    const { ctx, ask } = asking({ action: "accept", content: {} });
    const err = await act("echo hi", ctx).catch((e) => e);
    expect(err?.callerDetail).toMatch(/another virtual desktop/);
    expect(ask).not.toHaveBeenCalled();
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("says the paste failed, without claiming nothing was typed", async () => {
    mockFlash.mockReturnValueOnce({ ok: false, reason: "foreground_steal_denied" } as never);
    const err = await act("echo hi", asking({ action: "accept", content: {} }).ctx).catch((e) => e);
    expect(err?.callerDetail).toMatch(/failed \(foreground_steal_denied\).*not known/);
  });

  it("does not ask when DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND=1", async () => {
    process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND = "1";
    const { ctx, ask } = asking({ action: "decline" });
    await act("echo hi", ctx);
    expect(ask).not.toHaveBeenCalled();
    expect(mockFlash).toHaveBeenCalledTimes(1);
  });
});
