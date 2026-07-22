/**
 * terminal-paneid-target.test.ts — ADR-014 R3 OQ-W-16-bis Phase 1.
 *
 * The optional `paneId` (decimal hwnd) target on terminal read/send:
 *   - findTerminalWindowByHwnd: exact-hwnd, ConsoleWindowClass-only, live-or-null.
 *   - send resolves the window DIRECTLY by hwnd (survives a title change); malformed / gone → typed decline.
 *   - read resolves via resolveTitleByHwnd (title-keyed downstream), safe-declines on a non-unique title.
 *
 * Mock surface mirrors terminal-send-console-paste.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowClassName: vi.fn(() => "ConsoleWindowClass"),
    getProcessIdentityByPid: vi.fn(() => ({ processName: "pwsh.exe", processStartTimeMs: 0 })),
  };
});

vi.mock("../../src/engine/bg-input.js", () => ({
  canInjectViaPostMessage: vi.fn(() => ({ supported: true })),
  postCharsToHwnd: vi.fn((_hwnd: unknown, chunk: string) => ({ sent: chunk.length, full: true })),
  postEnterToHwnd: vi.fn(),
  isBgAutoEnabled: vi.fn(() => true),
  injectViaForegroundFlash: vi.fn(),
  pasteIntoConsoleNoFocus: vi.fn(() => Promise.resolve({ ok: true })),
  TERMINAL_WINDOW_CLASSES: new Set<string>(["ConsoleWindowClass"]),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve("dtmdogfood@host:~$ ")),
}));

vi.mock("../../src/engine/ocr-bridge.js", () => ({
  recognizeWindow: vi.fn(),
  ocrWordsToLines: vi.fn(),
  detectOcrLanguage: () => "en",
}));

vi.mock("../../src/engine/identity-tracker.js", () => ({
  observeTarget: vi.fn(() => ({ identity: {}, invalidatedBy: null, previousTarget: null })),
  buildCacheStateHints: vi.fn(() => ({})),
  toTargetHints: vi.fn(() => ({})),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { type: vi.fn(), pressKey: vi.fn(), releaseKey: vi.fn() },
}));

vi.mock("../../src/tools/keyboard.js", () => ({
  typeViaClipboard: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

import {
  findTerminalWindowByHwnd,
  terminalSendHandler,
  terminalReadHandler,
  terminalDispatchHandler,
  paneIdMissSuggest,
  isPaneShellAlive,
} from "../../src/tools/terminal.js";
import * as win32 from "../../src/engine/win32.js";
import * as bgInput from "../../src/engine/bg-input.js";
import * as uia from "../../src/engine/uia-bridge.js";

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockChars = vi.mocked(bgInput.postCharsToHwnd);
const mockUia = vi.mocked(uia.getTextViaTextPattern);
const mockIdentity = vi.mocked(win32.getProcessIdentityByPid);

function fakeWindow(title: string, hwnd: bigint, className = "ConsoleWindowClass") {
  return {
    hwnd,
    title,
    className,
    isActive: true,
    zOrder: 0,
    isMinimized: false,
    isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 },
    processName: "powershell.exe",
  } as unknown as win32.WindowZInfo;
}

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const sendArgs = (over: Record<string, unknown>) => ({
  windowTitle: "ignored", input: "echo hi", method: "background" as const, chunkSize: 100,
  pressEnter: false, focusFirst: false, restoreFocus: false, preferClipboard: false,
  pasteKey: "auto" as const, trackFocus: false, settleMs: 0, ...over,
});

const readArgs = (over: Record<string, unknown>) => ({
  windowTitle: "ignored", lines: 50, stripAnsi: true, source: "uia" as const, ...over,
});

beforeEach(() => {
  mockEnum.mockReset();
  mockChars.mockClear();
});

describe("findTerminalWindowByHwnd (Phase 1)", () => {
  it("returns the window with the EXACT hwnd when it is a ConsoleWindowClass", () => {
    mockEnum.mockReturnValue([fakeWindow("a", 10n), fakeWindow("b", 20n)]);
    expect(findTerminalWindowByHwnd(20n)?.hwnd).toBe(20n);
  });
  it("returns null when the hwnd is not present (vanished pane)", () => {
    mockEnum.mockReturnValue([fakeWindow("a", 10n)]);
    expect(findTerminalWindowByHwnd(99n)).toBeNull();
  });
  it("returns null when the hwnd exists but is NOT a ConsoleWindowClass (e.g. WT)", () => {
    mockEnum.mockReturnValue([fakeWindow("wt", 30n, "CASCADIA_HOSTING_WINDOW_CLASS")]);
    expect(findTerminalWindowByHwnd(30n)).toBeNull();
  });
});

describe("terminal send paneId (Phase 1 — hwnd-direct, survives title drift)", () => {
  it("routes the send to the EXACT hwnd, not a same-title sibling", async () => {
    // Two same-title consoles: a title-substring lookup would be ambiguous, but paneId binds by hwnd.
    // The test's purpose is the ROUTING (which hwnd the WM_CHAR reaches); the full delivery-verification
    // path (post-send echo read-back) is exercised by the live dogfood, not asserted here.
    mockEnum.mockReturnValue([fakeWindow("dtmdogfood@host: ~", 111n), fakeWindow("dtmdogfood@host: ~", 222n)]);
    mockUia.mockResolvedValue("dtmdogfood@host: ~ whoami");
    await terminalSendHandler(sendArgs({ paneId: "222", input: "whoami" }));
    // WM_CHAR (background) went to hwnd 222 — never the same-title sibling 111.
    expect(mockChars).toHaveBeenCalled();
    expect(mockChars.mock.calls[0][0]).toBe(222n);
  });
  it("declines a malformed paneId with a typed window-not-found", async () => {
    mockEnum.mockReturnValue([fakeWindow("x", 1n)]);
    const r = parseResult(await terminalSendHandler(sendArgs({ paneId: "not-a-number" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
  it("declines a vanished / non-console paneId", async () => {
    mockEnum.mockReturnValue([fakeWindow("x", 1n)]);
    const r = parseResult(await terminalSendHandler(sendArgs({ paneId: "999" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
});

describe("terminal DISPATCHER paneId-only (Phase 1 — schema gate, the real call path)", () => {
  // The dispatcher re-parses args against the strict union (parseActionArgsOrFail). This is the path the
  // examples exercise (paneId, NO windowTitle) — the handler-direct tests above bypass it. A required
  // windowTitle would reject these with InvalidArgs (Fable P1-1).
  it("accepts a paneId-only SEND (no windowTitle) and routes to the hwnd", async () => {
    mockEnum.mockReturnValue([fakeWindow("dtm-locker-console-x", 222n)]);
    mockUia.mockResolvedValue("dtm-locker-console-x whoami");
    const r = parseResult(await terminalDispatchHandler({ action: "send", paneId: "222", input: "whoami", method: "background" } as never));
    expect(r.code).not.toBe("InvalidArgs");
    expect(mockChars.mock.calls[0]?.[0]).toBe(222n);
  });
  it("accepts a paneId-only READ (no windowTitle)", async () => {
    mockEnum.mockReturnValue([fakeWindow("dtm-locker-console-y", 222n), fakeWindow("PowerShell", 111n)]);
    mockUia.mockResolvedValue("dtm-locker-console-y ready");
    const r = parseResult(await terminalDispatchHandler({ action: "read", paneId: "222" } as never));
    expect(r.code).not.toBe("InvalidArgs");
    expect(String(r.text)).toContain("ready");
  });
  it("rejects a SEND with NEITHER windowTitle nor paneId (typed, not a crash)", async () => {
    mockEnum.mockReturnValue([]);
    const r = parseResult(await terminalDispatchHandler({ action: "send", input: "whoami" } as never));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/windowTitle or paneId/);
  });
});

describe("terminal read paneId (Phase 1 — safe-declines on a non-unique title)", () => {
  it("reads the pane when its title is still unique (happy path)", async () => {
    mockEnum.mockReturnValue([fakeWindow("dtm-locker-console-abc", 222n), fakeWindow("PowerShell", 111n)]);
    mockUia.mockResolvedValue("dtmdogfood@host:~$ ready");
    const r = parseResult(await terminalReadHandler(readArgs({ paneId: "222" })));
    expect(r.ok).not.toBe(false);
    expect(String(r.text)).toContain("ready");
  });
  it("declines (never wrong-reads) when the pane's title is no longer unique", async () => {
    // Same-title sibling ⇒ resolveTitleByHwnd cannot hand a unique title to the UIA read ⇒ decline.
    mockEnum.mockReturnValue([fakeWindow("dtmdogfood@host: ~", 111n), fakeWindow("dtmdogfood@host: ~", 222n)]);
    const r = parseResult(await terminalReadHandler(readArgs({ paneId: "222" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
  it("declines a malformed paneId", async () => {
    mockEnum.mockReturnValue([fakeWindow("x", 1n)]);
    const r = parseResult(await terminalReadHandler(readArgs({ paneId: "bad" })));
    expect(r.code).toBe("TerminalWindowNotFound");
  });
});

describe("paneIdMissSuggest — shape-aware recovery hints (dogfood 2026-07)", () => {
  it("detects a windowTitle passed into the paneId slot and points at the paneId field", () => {
    const s = paneIdMissSuggest("dtm-locker-console-9dc7d7db");
    expect(s.join(" ")).toMatch(/windowTitle.*NOT its .?paneId/i);
    // Must NOT emit the generic 'run desktop_discover / partial title' misdirection.
    expect(s.join(" ")).not.toMatch(/desktop_discover/i);
  });
  it("flags a genuinely malformed handle and points at launch_console reuse", () => {
    const s = paneIdMissSuggest("not-a-handle");
    expect(s.join(" ")).toMatch(/malformed/i);
    expect(s.join(" ")).toMatch(/fresh:false/);
  });
  it("for a well-formed-but-gone handle explains the wt inactive-tab case", () => {
    const s = paneIdMissSuggest("wt:31264:13322426700123");
    expect(s.join(" ")).toMatch(/ACTIVE tab/i);
  });
  it("read surfaces the windowTitle-mixup suggest, not the generic title hint", async () => {
    mockEnum.mockReturnValue([fakeWindow("dtm-locker-console-9dc7d7db", 222n)]);
    const r = parseResult(await terminalReadHandler(readArgs({ paneId: "dtm-locker-console-9dc7d7db" })));
    expect(r.code).toBe("TerminalWindowNotFound");
    expect(JSON.stringify(r.suggest)).toMatch(/windowTitle/i);
  });
});

describe("isPaneShellAlive — wt closed-tab vs inactive-tab (Codex PR #546 #3)", () => {
  it("returns true for undefined / classic / malformed (nothing wt-specific to decide)", () => {
    expect(isPaneShellAlive(undefined)).toBe(true);
    expect(isPaneShellAlive("12345678")).toBe(true); // classic — liveness owned by isWindowStillAlive(hwnd)
    expect(isPaneShellAlive("dtm-locker-console-abc")).toBe(true); // malformed
  });
  it("returns true when the wt shell pid is alive with the matching start time (inactive tab → pause)", () => {
    mockIdentity.mockReturnValue({ processName: "pwsh.exe", processStartTimeMs: 13322426700123 } as never);
    expect(isPaneShellAlive("wt:31264:13322426700123")).toBe(true);
  });
  it("returns false when the wt shell is gone (startTime 0) or pid reused (mismatch) → closed tab", () => {
    mockIdentity.mockReturnValue({ processName: "", processStartTimeMs: 0 } as never);
    expect(isPaneShellAlive("wt:31264:13322426700123")).toBe(false);
    mockIdentity.mockReturnValue({ processName: "other.exe", processStartTimeMs: 999 } as never);
    expect(isPaneShellAlive("wt:31264:13322426700123")).toBe(false);
  });
});

describe("terminal run paneId (F-4 — parity with read/send)", () => {
  // Bounded timeout so the poll loop returns fast (reason:'timeout'); the point of this test is that a
  // classic paneId RESOLVES (not declined), not the wait semantics — so we cap timeoutMs at the min (500).
  const runArgs = (over: Record<string, unknown>) => ({
    action: "run" as const, input: "whoami", until: { mode: "quiet" as const, quietMs: 50 }, timeoutMs: 500, ...over,
  });
  it("resolves a classic paneId to the pane title and runs against it (not declined)", async () => {
    mockEnum.mockReturnValue([fakeWindow("dtm-locker-console-abc", 222n), fakeWindow("PowerShell", 111n)]);
    mockUia.mockResolvedValue("dtm-locker-console-abc whoami\nuser\n");
    const r = parseResult(await terminalDispatchHandler(runArgs({ paneId: "222" }) as never));
    // A resolved paneId must NOT short-circuit as a decline — it enters the run pipeline.
    expect(r.code).not.toBe("InvalidArgs");
    expect(r.code).not.toBe("TerminalWindowNotFound");
  });
  it("declines a windowTitle-shaped paneId with the shape-aware suggest", async () => {
    mockEnum.mockReturnValue([fakeWindow("dtm-locker-console-abc", 222n)]);
    const r = parseResult(await terminalDispatchHandler(runArgs({ paneId: "dtm-locker-console-abc" }) as never));
    expect(r.code).toBe("TerminalWindowNotFound");
    expect(JSON.stringify(r.suggest)).toMatch(/windowTitle/i);
  });
  it("rejects a run with NEITHER windowTitle nor paneId (typed)", async () => {
    mockEnum.mockReturnValue([]);
    const r = parseResult(await terminalDispatchHandler({ action: "run", input: "whoami" } as never));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/windowTitle or paneId/);
  });
});
