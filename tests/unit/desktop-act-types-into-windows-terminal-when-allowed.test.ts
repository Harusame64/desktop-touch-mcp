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
const { state } = vi.hoisted(() => ({ state: { cloaked: false, reason: "wt_xaml_pipeline", pid: 11 } }));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [wtWindow({ isCloaked: state.cloaked })]),
    getForegroundHwnd: vi.fn(() => 0x999n),
    getWindowTitleW: vi.fn(() => "PowerShell"),
    getWindowIdentity: vi.fn(() => ({ pid: state.pid, processName: "WindowsTerminal", processStartTimeMs: 1000 })),
  };
});

const mockFlash = vi.fn((..._a: unknown[]) => ({ ok: true, result: {} }));
const mockPostChars = vi.fn();
vi.mock("../../src/engine/bg-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/bg-input.js")>();
  return {
    ...actual,
    canInjectViaPostMessage: vi.fn(() => ({ supported: false, reason: state.reason, className: "CASCADIA_HOSTING_WINDOW_CLASS" })),
    postCharsToHwnd: (...a: unknown[]) => mockPostChars(...a),
    injectViaForegroundFlash: (...a: unknown[]) => mockFlash(...a),
  };
});

vi.mock("../../src/engine/background-channel-resolver.js", () => ({
  resolveBackgroundInputChannel: vi.fn((hwnd: bigint) => ({ kind: "clipboard_flash", hwnd, pid: 42, constraints: { maxBytes: 5120, singleLineOnly: true } })),
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

/** `readMs`: how long the person took to answer (a cancel sooner than 500 ms is a client that cannot ask). */
function asking(answer: Awaited<ReturnType<AskContext["ask"]>>, readMs = 0) {
  const ask = vi.fn(async () => {
    if (readMs > 0) vi.spyOn(Date, "now").mockReturnValue(Date.now() + readMs);
    return answer;
  });
  return { ctx: { ask } as AskContext, ask };
}

const act = (text: string, ctx: AskContext | null) =>
  runWithAskContext(ctx, () => createDesktopExecutor({ windowTitle: "PowerShell" })(terminalInput, "type", text));

beforeEach(() => {
  vi.clearAllMocks();
  resetRememberedTerminalForeground();
  state.cloaked = false;
  state.reason = "wt_xaml_pipeline";
  state.pid = 11;
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
    const err = await act("echo hi", asking(answer, 8_000).ctx).catch((e) => e);
    vi.restoreAllMocks();
    expect(err?.name).toBe("TerminalForegroundRefusal");
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
    mockFlash.mockReturnValueOnce({ ok: false, reason: "foreground_restore_failed" } as never);
    const err = await act("echo hi", asking({ action: "accept", content: {} }).ctx).catch((e) => e);
    expect(err?.callerDetail).toMatch(/failed \(foreground_restore_failed\).*not known/);
  });

  it("does not ask when DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND=1", async () => {
    process.env.DESKTOP_TOUCH_ALLOW_TERMINAL_FOREGROUND = "1";
    const { ctx, ask } = asking({ action: "decline" });
    await act("echo hi", ctx);
    expect(ask).not.toHaveBeenCalled();
    expect(mockFlash).toHaveBeenCalledTimes(1);
  });

  it("does not ask, or paste, for a window refused for another reason (not Windows Terminal)", async () => {
    state.reason = "class_unknown";
    const { ctx, ask } = asking({ action: "accept", content: {} });
    const err = await act("echo hi", ctx).catch((e) => e);
    expect(err?.name).toBe("BackgroundTerminalUnsupportedError");
    expect(ask).not.toHaveBeenCalled();
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("reads an instant cancel (claude -p) as a client that cannot ask", async () => {
    const err = await act("echo hi", asking({ action: "cancel" }).ctx).catch((e) => e);
    expect(err?.callerDetail).toMatch(/cannot ask the user/);
  });

  it("accepts a trailing \\r alone as Enter, as terminal send does", async () => {
    await act("dir\r", asking({ action: "accept", content: {} }).ctx);
    expect(mockFlash).toHaveBeenCalledWith(WT, 42, "dir", { pressEnter: true });
  });

  it("does not ask about text longer than one paste takes", async () => {
    const { ctx, ask } = asking({ action: "accept", content: {} });
    // 2560 UTF-16 units is 5120 bytes, which the flash refuses (`validate_input`: at the limit).
    const err = await act("x".repeat(2560), ctx).catch((e) => e);
    expect(err?.callerDetail).toMatch(/longer than one paste/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("looks again after the answer: a terminal moved to another desktop meanwhile is not brought forward", async () => {
    const ask = vi.fn(async () => { state.cloaked = true; return { action: "accept" as const, content: {} }; });
    const err = await act("echo hi", { ask } as AskContext).catch((e) => e);
    expect(err?.callerDetail).toMatch(/another virtual desktop/);
    expect(mockFlash).not.toHaveBeenCalled();
  });

  it("says nothing was typed when the flash failed before taking the foreground", async () => {
    mockFlash.mockReturnValueOnce({ ok: false, reason: "foreground_steal_denied" } as never);
    const err = await act("echo hi", asking({ action: "accept", content: {} }).ctx).catch((e) => e);
    // Refused (foreground_not_allowed), not executor_failed: that advice would type it again.
    expect(err?.name).toBe("TerminalForegroundRefusal");
    expect(err?.callerDetail).toMatch(/nothing was typed/);
  });

  it("asks about what is typed and where, on one line", async () => {
    const { ctx, ask } = asking({ action: "accept", content: {} });
    await act("echo hi", ctx);
    const form = (ask.mock.calls[0] as unknown as [{ message: string }])[0];
    expect(form.message).toBe('Type "echo hi" into Windows Terminal (PowerShell)? Takes the foreground ~0.1 s.');
  });

  it("says a failed paste after an Accept may have typed, under the reason that forbids another road", async () => {
    mockFlash.mockReturnValueOnce({ ok: false, reason: "send_input_failed" } as never);
    const err = await act("echo hi", asking({ action: "accept", content: {} }).ctx).catch((e) => e);
    expect(err?.name).toBe("TerminalForegroundRefusal");
    expect(err?.callerDetail).toMatch(/not known/);
  });

  it("does not type into another window that took the handle while the user was answering (PR codex P1)", async () => {
    const ask = vi.fn(async () => { state.pid = 77; return { action: "accept" as const, content: {} }; });
    const err = await act("echo hi", { ask } as AskContext).catch((e) => e);
    expect(err?.callerDetail).toMatch(/handle now names another window/);
    expect(mockFlash).not.toHaveBeenCalled();
  });
});
