/**
 * resolve-log-keyboard-sink.test.ts — ADR-035 Phase 1, keyboard end of the
 * instrumentation.
 *
 * The `resolve` half of Phase 1 is only half the evidence. ADR-035 §7 can only
 * confirm the zero-match hypothesis H2 by joining a resolution to the write it
 * produced, so the dispatch events have to be emitted by the REAL handlers on
 * the REAL branches — a unit test of `logDispatchSink` in isolation would pass
 * even if no handler ever called it (plan §2, Round 13 Codex).
 *
 * So this drives `keyboardTypeHandler` down its two production channels and
 * asserts which sink was recorded and against which handle:
 *   - background (WM_CHAR to a resolved HWND)  → `sink:"wm_char"`, target set
 *   - foreground (clipboard paste, no handle)  → `sink:"clipboard_paste"`, target null
 *
 * The mock layout follows `keyboard-destination-required.test.ts`: sinks stubbed
 * at the nut.js / bg-input boundary, the guard layer stubbed to pass, everything
 * under test left real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Sinks ───────────────────────────────────────────────────────────────────
const mockType = vi.fn(() => Promise.resolve());
const mockPressKey = vi.fn(() => Promise.resolve());
const mockReleaseKey = vi.fn(() => Promise.resolve());
vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    type: (...a: unknown[]) => mockType(...(a as [])),
    pressKey: (...a: unknown[]) => mockPressKey(...(a as [])),
    releaseKey: (...a: unknown[]) => mockReleaseKey(...(a as [])),
  },
  rawKeyboard: { pressKeyDown: vi.fn(), pressKeyUp: vi.fn() },
  withKeyboardLock: (fn: () => Promise<unknown>) => fn(),
}));

const mockPostChars = vi.fn(() => ({ full: true, sent: 8 }));
vi.mock("../../src/engine/bg-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/bg-input.js")>();
  return {
    ...actual,
    isBgAutoEnabled: vi.fn(() => false),
    canInjectViaPostMessage: vi.fn(() => ({ supported: true })),
    postCharsToHwnd: (...a: unknown[]) => mockPostChars(...(a as [])),
  };
});

// ─── Diagnostic log ──────────────────────────────────────────────────────────
const mockLogDiagnostic = vi.fn();
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return { ...actual, logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])) };
});

// ─── Guard layer: pass-through, so the perception subsystem stays out ────────
vi.mock("../../src/tools/_action-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_action-guard.js")>();
  return {
    ...actual,
    runActionGuard: vi.fn(async () => ({
      block: false,
      summary: { kind: "auto", status: "ok", canContinue: true, next: "" },
    })),
  };
});

vi.mock("../../src/engine/perception/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/perception/registry.js")>();
  return { ...actual, evaluatePreToolGuards: vi.fn(async () => ({ ok: true, policy: "allow" })), buildEnvelopeFor: vi.fn(() => undefined) };
});

vi.mock("../../src/tools/_focus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_focus.js")>();
  return { ...actual, detectFocusLoss: vi.fn(async () => null), checkForegroundOnce: vi.fn(async () => null) };
});

const TARGET_HWND = 0x100n;
const OTHER_HWND = 0x200n;
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [
      { hwnd: TARGET_HWND, title: "Untitled - Notepad", region: { x: 0, y: 0, width: 100, height: 100 }, zOrder: 0, isMinimized: false, isMaximized: false, isActive: true, className: "Notepad", ownerHwnd: null },
      { hwnd: OTHER_HWND, title: "notes - Notepad", region: { x: 0, y: 0, width: 100, height: 100 }, zOrder: 1, isMinimized: false, isMaximized: false, isActive: false, className: "Notepad", ownerHwnd: null },
    ]),
    getWindowClassName: vi.fn(() => "Notepad"),
    restoreAndFocusWindow: vi.fn(),
    getForegroundHwnd: vi.fn(() => TARGET_HWND),
    getWindowTitleW: vi.fn(() => "Untitled - Notepad"),
    getWindowIdentity: vi.fn(() => ({ pid: 7, processName: "notepad.exe", processStartTimeMs: 0 })),
  };
});

vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return { ...actual, resolveWindowTarget: vi.fn(async () => null) };
});

const { keyboardTypeHandler, keyboardSequenceHandler } = await import("../../src/tools/keyboard.js");

function events(kind: string): Array<Record<string, any>> {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, any>)
    .filter((e) => e.kind === kind);
}

const BASE = {
  text: "abcdefgh",
  use_clipboard: false,
  replaceAll: false,
  forceKeystrokes: false,
  trackFocus: false,
  settleMs: 0,
  windowTitle: "Notepad",
};

beforeEach(() => {
  mockLogDiagnostic.mockClear();
  mockType.mockClear();
  mockPostChars.mockClear();
});

describe("ADR-035 Phase 1 — keyboard dispatch sinks (real handler, real branches)", () => {
  it("background WM_CHAR records sink:'wm_char' against the resolved handle", async () => {
    await keyboardTypeHandler({ ...BASE, method: "background" } as never);
    expect(mockPostChars).toHaveBeenCalled();
    const sinks = events("dispatch_sink");
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toMatchObject({
      sink: "wm_char",
      tool: "keyboard:type",
      targetHwnd: String(TARGET_HWND),
    });
  });

  it("foreground clipboard paste records sink:'clipboard_paste' with NO handle", async () => {
    await keyboardTypeHandler({ ...BASE, method: "foreground", use_clipboard: true } as never);
    const sinks = events("dispatch_sink");
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toMatchObject({
      sink: "clipboard_paste",
      tool: "keyboard:type",
      // The foreground path has no destination handle by construction — the
      // keys go to whatever is focused, which is the whole point of recording
      // `fgHwnd` here.
      targetHwnd: null,
      fgHwnd: String(TARGET_HWND),
    });
  });

  it("foreground keystrokes record sink:'sendinput', so the non-clipboard branch is not blind", async () => {
    await keyboardTypeHandler({ ...BASE, method: "foreground" } as never);
    expect(mockType).toHaveBeenCalled();
    const sinks = events("dispatch_sink");
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toMatchObject({ sink: "sendinput", tool: "keyboard:type", targetHwnd: null });
  });

  it("the background destination re-resolution is logged as its own §2 #8 resolver", async () => {
    await keyboardTypeHandler({ ...BASE, method: "background" } as never);
    const resolves = events("resolve").filter((e) => e.resolver === "keyboardBackgroundType");
    expect(resolves).toHaveLength(1);
    // Two windows carry "Notepad" — exactly the silent multi-match H1 shape.
    expect(resolves[0]).toMatchObject({ matchCount: 2, chosen: { hwnd: String(TARGET_HWND) } });
    expect(resolves[0]!.others.map((o: any) => o.hwnd)).toEqual([String(OTHER_HWND)]);
  });

  // ── Sequence: the event must describe a dispatch that really happened ─────
  //
  // `rawKeyboard` is SendInput — routed by focus, not addressed to a handle —
  // and the first step can still be refused by `assertKeyComboSafe` after the
  // destination has been resolved. Both were wrong in the first cut of this
  // instrumentation (Codex Round 1 P2).
  it("sequence records sink:'rawkeyboard' with NO handle, because SendInput follows focus", async () => {
    await keyboardSequenceHandler({
      steps: [{ keys: "ctrl+a" }, { keys: "ctrl+c" }],
      windowTitle: "Notepad",
      trackFocus: false,
      settleMs: 0,
    } as never);
    const sinks = events("dispatch_sink");
    // One event for the whole sequence, not one per step.
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toMatchObject({
      sink: "rawkeyboard",
      tool: "keyboard:sequence",
      targetHwnd: null,
      fgHwnd: String(TARGET_HWND),
    });
    // The window it MEANT to reach is recoverable from the resolve event that
    // shares this call's correlation id.
    const focus = events("resolve").find((e) => e.resolver === "focusWindowForKeyboard");
    expect(focus?.chosen?.hwnd).toBe(String(TARGET_HWND));
  });

  it("a sequence refused at its first step records NO dispatch", async () => {
    await keyboardSequenceHandler({
      steps: [{ keys: "win+r" }],           // blocked — never reaches rawKeyboard
      windowTitle: "Notepad",
      trackFocus: false,
      settleMs: 0,
    } as never);
    expect(events("dispatch_sink")).toHaveLength(0);
  });

  it("focusWindowForKeyboard logs its active-first tie-break as §2 #3", async () => {
    await keyboardTypeHandler({ ...BASE, method: "foreground" } as never);
    const resolves = events("resolve").filter((e) => e.resolver === "focusWindowForKeyboard");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({ matchCount: 2, chosen: { hwnd: String(TARGET_HWND), isActive: true } });
  });
});
