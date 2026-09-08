/**
 * adr-036-hwnd-write-paths.test.ts — ADR-036 I-1 / I-3 / I-4 through the real
 * keyboard handlers.
 *
 * `adr-036-hwnd-guard-resolution.test.ts` pins the guard once it HAS the
 * handle. This file pins the three places a write could still drop it on the
 * way there, each of which was independently broken:
 *
 *   I-1  the guard descriptor        — built from the resolved title only, so
 *                                      the guard re-counted the siblings
 *   I-3  the focus step              — matched by title substring, so a sibling
 *                                      was brought to the front and the keys
 *                                      landed there whatever the guard verified
 *   I-4  the background / flash send — re-resolved by title and posted WM_CHAR
 *                                      to the first match in z-order
 *
 * The descriptor assertions run for every dispatch method on purpose. Only the
 * default foreground path builds its descriptor inline in the handler;
 * `background` and `foreground_flash` build theirs in `evaluateKeyboardGuards`,
 * so a passthrough wired only into the inline sites would pass a
 * foreground-only test and still refuse every background call.
 *
 * Fixture: two windows sharing a title, neither in the foreground, and the
 * pinned one is NOT the one the title rule would pick.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SHARED_TITLE = "pictkura — Chrome";
const SIBLING = 0x1111n;   // first title match (lowest zOrder) — the wrong window
const LIVE = 0x2222n;      // what the caller names by handle
const ELSEWHERE = 0x3333n; // foreground, unrelated — so focus really has to move

// ─── Win32: two same-titled windows, plus a foreground bystander ─────────────
//
// `restoreAndFocusWindow` moves the foreground in the fake exactly as it does on
// the desktop, because `focusWindowForKeyboard` verifies the move by
// re-enumerating: a static fake would report every focus attempt as refused and
// the handlers would return `ForegroundRestricted` before reaching the guard.
const { mockEnum, mockRestoreAndFocus, foregroundRef } = vi.hoisted(() => ({
  mockEnum: vi.fn(),
  mockRestoreAndFocus: vi.fn(),
  foregroundRef: { hwnd: 0x3333n },
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: mockEnum,
    restoreAndFocusWindow: mockRestoreAndFocus,
    getForegroundHwnd: vi.fn(() => foregroundRef.hwnd),
    getWindowClassName: vi.fn(() => "Chrome_WidgetWin_1"),
    getWindowTitleW: vi.fn(() => SHARED_TITLE),
    getWindowIdentity: vi.fn(() => ({ pid: 7, processName: "chrome.exe", processStartTimeMs: 0 })),
    getWindowProcessId: vi.fn(() => 7),
    getWindowRectByHwnd: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
  };
});

vi.mock("../../src/engine/perception/sensors-win32.js", () => ({
  refreshWin32Fluents: vi.fn(() => []),
  buildWindowIdentity: vi.fn((hwnd: string) => ({
    hwnd, pid: 7, processName: "chrome.exe", processStartTimeMs: 1700000000000,
    titleResolved: SHARED_TITLE,
  })),
}));

vi.mock("../../src/engine/perception/guards.js", () => ({
  evaluateGuards: vi.fn(() => ({
    ok: true, policy: "block", attention: "ok", results: [], failedGuard: undefined,
  })),
}));

// ─── Sinks — nothing may reach the real desktop ──────────────────────────────

const { mockType, mockPostChars, mockPostCombo, mockPostEnter } = vi.hoisted(() => ({
  mockType: vi.fn(async () => {}),
  mockPostChars: vi.fn(() => ({ full: true, sent: 8 })),
  mockPostCombo: vi.fn(() => true),
  mockPostEnter: vi.fn(() => true),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    type: (...a: unknown[]) => mockType(...(a as [])),
    pressKey: vi.fn(async () => {}),
    releaseKey: vi.fn(async () => {}),
  },
  rawKeyboard: { pressKeyDown: vi.fn(), pressKeyUp: vi.fn() },
  withKeyboardLock: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../../src/engine/bg-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/bg-input.js")>();
  return {
    ...actual,
    isBgAutoEnabled: vi.fn(() => false),
    canInjectViaPostMessage: vi.fn(() => ({ supported: true })),
    postCharsToHwnd: (...a: unknown[]) => mockPostChars(...(a as [])),
    postKeyComboToHwnd: (...a: unknown[]) => mockPostCombo(...(a as [])),
    postEnterToHwnd: (...a: unknown[]) => mockPostEnter(...(a as [])),
  };
});

// The flash path's channel choice is not what this file is about; pinning it to
// WM_CHAR keeps the delivery handle observable without a clipboard round-trip.
vi.mock("../../src/engine/background-channel-resolver.js", () => ({
  resolveBackgroundInputChannel: vi.fn(() => ({ kind: "wm_char" })),
}));

vi.mock("../../src/tools/_focus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_focus.js")>();
  return { ...actual, detectFocusLoss: vi.fn(async () => null), checkForegroundOnce: vi.fn(async () => null) };
});

// ─── The window resolver, in the two shapes the handlers actually see ────────
//
// Case 1 (explicit hwnd) returns the window; a plain `windowTitle` that matches
// a normal top-level window returns null and the handler keeps the caller's
// string. Getting this pair right is the whole reason the pin reads the public
// `hwnd` argument instead of "did the resolver return something".
vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return {
    ...actual,
    resolveWindowTarget: vi.fn(async (p: { hwnd?: string; windowTitle?: string }) =>
      p.hwnd !== undefined
        ? { hwnd: BigInt(p.hwnd), title: SHARED_TITLE, warnings: [], className: "Chrome_WidgetWin_1" }
        : null
    ),
  };
});

// ─── The guard: real, but observed ───────────────────────────────────────────
//
// Wrapping rather than stubbing. The descriptor a handler builds is the thing
// under test, and the block/pass outcome has to stay real so a descriptor that
// silently lost its handle still shows up as `ambiguous_target`.
const { mockRunActionGuard } = vi.hoisted(() => ({ mockRunActionGuard: vi.fn() }));
vi.mock("../../src/tools/_action-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_action-guard.js")>();
  mockRunActionGuard.mockImplementation(actual.runActionGuard);
  return { ...actual, runActionGuard: mockRunActionGuard };
});

const { keyboardTypeHandler, keyboardPressHandler, keyboardSequenceHandler } =
  await import("../../src/tools/keyboard.js");
import { _resetForTest as resetHotCache } from "../../src/engine/perception/hot-target-cache.js";

function win(hwnd: bigint, title: string, zOrder: number) {
  return {
    hwnd, title, zOrder,
    isActive: hwnd === foregroundRef.hwnd,
    region: { x: 0, y: 0, width: 800, height: 600 },
    isMinimized: false, isMaximized: false, className: "Chrome_WidgetWin_1", ownerHwnd: null,
  };
}

/** The descriptor the handler handed to the guard on its (single) guard call. */
function guardDescriptor(): Record<string, unknown> | null {
  expect(mockRunActionGuard).toHaveBeenCalled();
  const last = mockRunActionGuard.mock.calls.at(-1)![0] as { descriptor: Record<string, unknown> | null };
  return last.descriptor;
}

function parse(result: { content?: Array<{ type: string; text: string }> }): Record<string, any> {
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : {};
}

const TYPE_BASE = {
  text: "abcdefgh",
  use_clipboard: false,
  replaceAll: false,
  forceKeystrokes: false,
  trackFocus: false,
  settleMs: 0,
};

beforeEach(() => {
  resetHotCache();
  foregroundRef.hwnd = ELSEWHERE;
  mockEnum.mockReset();
  mockEnum.mockImplementation(() => [
    win(ELSEWHERE, "Some other app", 0),
    win(SIBLING, SHARED_TITLE, 1),
    win(LIVE, SHARED_TITLE, 2),
  ]);
  mockRestoreAndFocus.mockReset();
  // Focus really moves, so `focusWindowForKeyboard` can verify it did.
  mockRestoreAndFocus.mockImplementation((hwnd: bigint) => { foregroundRef.hwnd = hwnd; });
  mockRunActionGuard.mockClear();
  mockType.mockClear();
  mockPostChars.mockClear();
  mockPostCombo.mockClear();
  mockPostEnter.mockClear();
});

// ─── I-1: the descriptor carries the handle on every dispatch method ─────────

describe("ADR-036 I-1 — the guard descriptor carries the caller's handle", () => {
  it("refuses a title-only type with ambiguous_target — the failure this ADR starts from", async () => {
    const r = parse(await keyboardTypeHandler({
      ...TYPE_BASE, windowTitle: SHARED_TITLE, method: "foreground",
    } as never));
    expect(r.ok).toBe(false);
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(JSON.stringify(r)).toContain("ambiguous_target");
  });

  it("passes when the same call names the handle (default foreground path)", async () => {
    const r = parse(await keyboardTypeHandler({
      ...TYPE_BASE, hwnd: String(LIVE), method: "foreground",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
    expect(mockType).toHaveBeenCalled();
  });

  it("carries the handle through the shared helper on method:'background'", async () => {
    const r = parse(await keyboardTypeHandler({
      ...TYPE_BASE, hwnd: String(LIVE), method: "background",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
  });

  it("carries the handle through the shared helper on method:'foreground_flash'", async () => {
    const r = parse(await keyboardTypeHandler({
      ...TYPE_BASE, hwnd: String(LIVE), windowTitle: SHARED_TITLE, method: "foreground_flash",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
  });

  it("refuses the background call when the handle is left out — the pin is load-bearing", async () => {
    const r = parse(await keyboardTypeHandler({
      ...TYPE_BASE, windowTitle: SHARED_TITLE, method: "background",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
    expect(mockPostChars).not.toHaveBeenCalled();
  });

  it("covers keyboard:press on both its foreground and background paths", async () => {
    const fg = parse(await keyboardPressHandler({
      keys: "enter", hwnd: String(LIVE), method: "foreground", trackFocus: false, settleMs: 0,
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(fg.ok).toBe(true);

    mockRunActionGuard.mockClear();
    const bg = parse(await keyboardPressHandler({
      keys: "enter", hwnd: String(LIVE), method: "background", trackFocus: false, settleMs: 0,
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(bg.ok).toBe(true);
  });

  it("covers keyboard:sequence", async () => {
    const r = parse(await keyboardSequenceHandler({
      steps: [{ keys: "ctrl+a" }], hwnd: String(LIVE), trackFocus: false, settleMs: 0,
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE, hwnd: LIVE });
    expect(r.ok).toBe(true);
  });

  it("does not pin a handle the caller never named, even when the resolver returns one", async () => {
    // `_resolve-window.ts` Case 4: a plain `windowTitle` that matches no plain
    // top-level window is resolved through the owner chain to a common dialog,
    // and that DOES return a handle. Reading "the resolver returned something"
    // as "the caller named a handle" would pin one for every title-only call
    // and retire `ambiguous_target` by accident.
    const resolveWindowTarget = vi.mocked(
      (await import("../../src/tools/_resolve-window.js")).resolveWindowTarget
    );
    resolveWindowTarget.mockResolvedValueOnce({
      hwnd: LIVE, title: SHARED_TITLE, warnings: [], className: "#32770",
    } as never);

    const r = parse(await keyboardTypeHandler({
      ...TYPE_BASE, windowTitle: SHARED_TITLE, method: "foreground",
    } as never));
    expect(guardDescriptor()).toEqual({ kind: "window", titleIncludes: SHARED_TITLE });
    expect(r.ok).toBe(false);
  });

  it("never builds an empty needle — a titleless window stays unguarded, not matched against everything", async () => {
    // `String.includes("")` is true for every window, so a descriptor built from
    // a resolved empty title would silently address the whole desktop. ADR-038
    // lets a titleless window through only while it is the foreground one; here
    // that pass must reach the guard as "no descriptor", never as `""`.
    const TITLELESS = 0x4444n;
    foregroundRef.hwnd = TITLELESS;
    const resolveWindowTarget = vi.mocked(
      (await import("../../src/tools/_resolve-window.js")).resolveWindowTarget
    );
    resolveWindowTarget.mockResolvedValueOnce({
      hwnd: TITLELESS, title: "", warnings: [], className: "Chrome_WidgetWin_1",
    } as never);

    const r = parse(await keyboardTypeHandler({
      ...TYPE_BASE, hwnd: String(TITLELESS), method: "foreground",
    } as never));
    expect(r.ok).toBe(true);
    expect(guardDescriptor()).toBeNull();
  });
});

// ─── I-3: focus follows the handle ───────────────────────────────────────────

describe("ADR-036 I-3 — focus is taken by the named window, not by a same-titled sibling", () => {
  it("brings the named window to the front", async () => {
    await keyboardTypeHandler({ ...TYPE_BASE, hwnd: String(LIVE), method: "foreground" } as never);
    expect(mockRestoreAndFocus).toHaveBeenCalled();
    expect(mockRestoreAndFocus.mock.calls[0]![0]).toBe(LIVE);
  });

  it("brings the FIRST title match to the front without a handle — what the pin replaces", async () => {
    // Guard off, or the title-only call would be refused before it ever focused
    // anything and this control would prove nothing.
    const prev = process.env.DESKTOP_TOUCH_AUTO_GUARD;
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    try {
      await keyboardTypeHandler({ ...TYPE_BASE, windowTitle: SHARED_TITLE, method: "foreground" } as never);
      expect(mockRestoreAndFocus.mock.calls[0]![0]).toBe(SIBLING);
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
      else process.env.DESKTOP_TOUCH_AUTO_GUARD = prev;
    }
  });

  it("covers keyboard:press, whose focus call had no pin at all", async () => {
    await keyboardPressHandler({
      keys: "a", hwnd: String(LIVE), method: "foreground", trackFocus: false, settleMs: 0,
    } as never);
    expect(mockRestoreAndFocus.mock.calls[0]![0]).toBe(LIVE);
  });
});

// ─── I-4: the background and flash sends deliver to the handle ───────────────

describe("ADR-036 I-4 — background delivery is addressed to the named window", () => {
  it("posts the characters to the named window", async () => {
    await keyboardTypeHandler({ ...TYPE_BASE, hwnd: String(LIVE), method: "background" } as never);
    expect(mockPostChars).toHaveBeenCalled();
    expect(mockPostChars.mock.calls[0]![0]).toBe(LIVE);
  });

  it("posts to the first title match without a handle — what the pin replaces", async () => {
    const prev = process.env.DESKTOP_TOUCH_AUTO_GUARD;
    process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
    try {
      await keyboardTypeHandler({ ...TYPE_BASE, windowTitle: SHARED_TITLE, method: "background" } as never);
      expect(mockPostChars.mock.calls[0]![0]).toBe(SIBLING);
    } finally {
      if (prev === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
      else process.env.DESKTOP_TOUCH_AUTO_GUARD = prev;
    }
  });

  it("addresses the flash paste to the named window too", async () => {
    await keyboardTypeHandler({
      ...TYPE_BASE, hwnd: String(LIVE), windowTitle: SHARED_TITLE, method: "foreground_flash",
    } as never);
    expect(mockPostChars).toHaveBeenCalled();
    expect(mockPostChars.mock.calls[0]![0]).toBe(LIVE);
  });

  it("addresses a background key press to the named window", async () => {
    await keyboardPressHandler({
      keys: "enter", hwnd: String(LIVE), method: "background", trackFocus: false, settleMs: 0,
    } as never);
    expect(mockPostEnter).toHaveBeenCalled();
    expect(mockPostEnter.mock.calls[0]![0]).toBe(LIVE);
  });
});
