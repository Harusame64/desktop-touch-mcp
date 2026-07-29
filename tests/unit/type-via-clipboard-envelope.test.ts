/**
 * type-via-clipboard-envelope.test.ts — ADR-033 PR-2 (P2-2b).
 *
 * `typeViaClipboard` borrows the user's clipboard and is supposed to give it
 * back. Sometimes it cannot: another process wrote to the clipboard first, the
 * saved content is too large for the fallback's command line, or the save never
 * worked at all. Until PR-2 the function returned `Promise<void>`, so none of
 * that could reach anybody — the user simply found their clipboard replaced.
 *
 * The disclosure only exists if it survives the whole way to the response, so
 * what is pinned here is the END of the chain, in BOTH tools that paste:
 * `keyboard(action='type')` and `terminal(action='send')`. The addon is faked
 * at the native-engine boundary, so the real `typeViaClipboard` runs and the
 * assertions cover the production plumbing rather than a stub of it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const nativeState: { available: boolean; composite: ReturnType<typeof vi.fn> } = {
  available: true,
  composite: vi.fn(),
};

vi.mock(import("../../src/engine/native-engine.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hasNativeTypeViaClipboard: () => nativeState.available,
    nativeWin32: {
      ...(actual.nativeWin32 ?? {}),
      win32TypeViaClipboard: (...a: unknown[]) => nativeState.composite(...a),
    } as unknown as typeof actual.nativeWin32,
  };
});

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    type: vi.fn(() => Promise.resolve()),
    pressKey: vi.fn(() => Promise.resolve()),
    releaseKey: vi.fn(() => Promise.resolve()),
  },
  withKeyboardLock: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
  rawKeyboard: {},
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => [
      {
        hwnd: 0x100n,
        title: "Notepad",
        region: { x: 0, y: 0, width: 100, height: 100 },
        zOrder: 0,
        isMinimized: false,
        isMaximized: false,
        isActive: true,
      },
    ]),
    getWindowClassName: vi.fn(() => "Notepad"),
    restoreAndFocusWindow: vi.fn(),
    getWindowProcessId: vi.fn(() => 4242),
    getProcessIdentityByPid: vi.fn(() => ({
      pid: 4242,
      processName: "pwsh",
      processStartTimeMs: 0,
    })),
  };
});

vi.mock("../../src/tools/_focus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_focus.js")>();
  return {
    ...actual,
    detectFocusLoss: vi.fn(() => Promise.resolve(null)),
    checkForegroundOnce: vi.fn(() => Promise.resolve(null)),
  };
});

vi.mock("../../src/tools/_action-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_action-guard.js")>();
  return { ...actual, isAutoGuardEnabled: vi.fn(() => false) };
});

vi.mock("../../src/engine/bg-input.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/bg-input.js")>();
  return {
    ...actual,
    isBgAutoEnabled: vi.fn(() => false),
    canInjectViaPostMessage: vi.fn(() => ({ supported: false })),
  };
});

vi.mock("../../src/engine/identity-tracker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/identity-tracker.js")>();
  return {
    ...actual,
    observeTarget: vi.fn(() => ({ identity: {}, invalidatedBy: null, previousTarget: null })),
    toTargetHints: vi.fn(() => ({})),
  };
});

const { keyboardTypeHandler } = await import("../../src/tools/keyboard.js");
const { terminalSendHandler } = await import("../../src/tools/terminal.js");
const win32 = await import("../../src/engine/win32.js");

function body(r: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
}

function clipboardHints(r: Record<string, unknown>): Record<string, unknown> | undefined {
  return (r.hints as Record<string, unknown> | undefined)?.clipboard as
    | Record<string, unknown>
    | undefined;
}

/** A native composite result. `over` shapes the interesting cases. */
function nativeResult(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    verify: {
      ok: true,
      expectedBytes: 10,
      inSessionReadable: true,
      inSessionBytes: 10,
      inSessionMatch: true,
      postCloseChecked: true,
      postCloseBytes: 10,
      postCloseMatch: true,
      sequenceAfterWrite: 5,
    },
    pasted: true,
    clipboardRestored: true,
    restoreSkippedRace: false,
    skippedFormats: [],
    settleMs: 120,
    ...over,
  };
}

const keyboardArgs = {
  text: "hello",
  method: "foreground" as const,
  use_clipboard: true,
  replaceAll: false,
  forceKeystrokes: false,
  trackFocus: false,
  settleMs: 0,
};

const terminalArgs = {
  windowTitle: "Notepad",
  input: "echo hi",
  method: "foreground" as const,
  chunkSize: 100,
  pressEnter: false,
  focusFirst: false,
  restoreFocus: false,
  preferClipboard: true,
  pasteKey: "auto" as const,
  trackFocus: false,
  settleMs: 0,
};

beforeEach(() => {
  nativeState.composite.mockReset();
  nativeState.available = true;
});

describe("ADR-033 — the clipboard side effect reaches the keyboard envelope", () => {
  it("reports the backend and a completed restore", async () => {
    nativeState.composite.mockResolvedValue(nativeResult());
    const r = body(await keyboardTypeHandler(keyboardArgs));
    expect(r.ok).toBe(true);
    expect(clipboardHints(r)).toEqual({ backend: "native", restored: true });
  });

  it("reports a restore skipped because another process wrote first", async () => {
    nativeState.composite.mockResolvedValue(
      nativeResult({ clipboardRestored: false, restoreSkippedRace: true }),
    );
    const r = body(await keyboardTypeHandler(keyboardArgs));
    const c = clipboardHints(r)!;
    expect(c.restored).toBe(false);
    expect(c.restoreSkippedRace).toBe(true);
  });

  it("reports formats the snapshot could not carry", async () => {
    nativeState.composite.mockResolvedValue(
      nativeResult({ skippedFormats: [{ formatId: 2, reason: "non_hglobal" }] }),
    );
    const c = clipboardHints(body(await keyboardTypeHandler(keyboardArgs)))!;
    expect(c.skippedFormats).toEqual([{ formatId: 2, reason: "non_hglobal" }]);
  });

  it("says nothing about the clipboard when the call did not use it", async () => {
    // The keystroke path borrows nothing, so a `clipboard` block there would be
    // describing a side effect that never happened.
    const r = body(await keyboardTypeHandler({ ...keyboardArgs, use_clipboard: false }));
    expect(r.ok).toBe(true);
    expect(clipboardHints(r)).toBeUndefined();
    expect(nativeState.composite).not.toHaveBeenCalled();
  });

  it("reaches the envelope on the AUTO-clipboard path too", async () => {
    // Non-ASCII text is promoted to the clipboard without the caller asking, so
    // this is the case where the user is LEAST likely to expect their clipboard
    // to be touched — and the one where the disclosure matters most.
    nativeState.composite.mockResolvedValue(
      nativeResult({ clipboardRestored: false, restoreSkippedRace: true }),
    );
    const r = body(
      await keyboardTypeHandler({ ...keyboardArgs, text: "日本語", use_clipboard: false }),
    );
    expect(r.method).toBe("clipboard-auto");
    expect(clipboardHints(r)!.restoreSkippedRace).toBe(true);
  });
});

describe("ADR-033 — the clipboard side effect reaches the terminal envelope", () => {
  it("reports the backend and a completed restore", async () => {
    nativeState.composite.mockResolvedValue(nativeResult());
    const r = body(await terminalSendHandler(terminalArgs));
    expect(r.ok).toBe(true);
    expect(clipboardHints(r)).toEqual({ backend: "native", restored: true });
  });

  it("reports a restore skipped because another process wrote first", async () => {
    nativeState.composite.mockResolvedValue(
      nativeResult({ clipboardRestored: false, restoreSkippedRace: true }),
    );
    const c = clipboardHints(body(await terminalSendHandler(terminalArgs)))!;
    expect(c.restored).toBe(false);
    expect(c.restoreSkippedRace).toBe(true);
  });

  it("keeps the target hints it already published", async () => {
    // The clipboard block is added ALONGSIDE `hints.target`, not in place of it.
    nativeState.composite.mockResolvedValue(nativeResult());
    const r = body(await terminalSendHandler(terminalArgs));
    expect((r.hints as Record<string, unknown>).target).toBeDefined();
  });

  it("says nothing about the clipboard when preferClipboard is off", async () => {
    const r = body(await terminalSendHandler({ ...terminalArgs, preferClipboard: false }));
    expect(r.ok).toBe(true);
    expect(clipboardHints(r)).toBeUndefined();
    expect(nativeState.composite).not.toHaveBeenCalled();
  });
});

// ── I-26: which paste chord `pasteKey:'auto'` picks ─────────────────────────

describe("ADR-033 I-26 — pasteKey:'auto' picks the chord the target actually pastes on", () => {
  // Ctrl+V is not paste everywhere. In mintty and the terminals that copy its
  // conventions, Ctrl+V is a control character (literal-next), so sending it
  // types garbage into the shell instead of pasting — and the send reports
  // success, because the keystroke WAS delivered. Those terminals paste on
  // Ctrl+Shift+V. This selection had no test at all, which is how a silently
  // wrong chord for one shell family would have survived.
  beforeEach(() => {
    nativeState.composite.mockResolvedValue(nativeResult());
  });

  /** Drive a send against a target whose process is `processName`. */
  async function comboFor(processName: string, over: Record<string, unknown> = {}) {
    vi.mocked(win32.getProcessIdentityByPid).mockReturnValue({
      pid: 4242,
      processName,
      processStartTimeMs: 0,
    });
    await terminalSendHandler({ ...terminalArgs, ...over });
    return nativeState.composite.mock.calls.at(-1)![1];
  }

  it.each(["bash", "wsl", "mintty", "alacritty", "wezterm"])(
    "%s pastes on ctrl+shift+v",
    async (proc) => {
      expect(await comboFor(proc)).toBe("ctrl+shift+v");
    },
  );

  it.each(["pwsh", "powershell", "cmd", "WindowsTerminal", ""])(
    "%s stays on ctrl+v",
    async (proc) => {
      expect(await comboFor(proc)).toBe("ctrl+v");
    },
  );

  it("matches the whole process name, not a substring", async () => {
    // `getProcessIdentityByPid` reports the base name without `.exe`, and the
    // match is anchored. A loose match would send Ctrl+Shift+V to anything
    // whose name merely CONTAINS one of these words — `bashful`, or a user's
    // `wsl-helper` — where it is not paste at all.
    expect(await comboFor("bashful")).toBe("ctrl+v");
    expect(await comboFor("git-bash")).toBe("ctrl+v");
    expect(await comboFor("wsl-helper")).toBe("ctrl+v");
  });

  it("is case-insensitive about the process name", async () => {
    // Win32 image names are not case-normalised.
    expect(await comboFor("Bash")).toBe("ctrl+shift+v");
    expect(await comboFor("WezTerm")).toBe("ctrl+shift+v");
  });

  it("an explicit pasteKey wins over the auto-detection", async () => {
    // The caller knows their terminal; `auto` is a default, not an override.
    expect(await comboFor("bash", { pasteKey: "ctrl+v" })).toBe("ctrl+v");
    expect(await comboFor("pwsh", { pasteKey: "ctrl+shift+v" })).toBe("ctrl+shift+v");
  });

  it("does not consult the process at all when pasteKey is explicit", async () => {
    vi.mocked(win32.getProcessIdentityByPid).mockClear();
    await comboFor("pwsh", { pasteKey: "ctrl+v" });
    // `comboFor` sets the mock's return value, which counts as no call by
    // itself; the assertion is that the handler never asked.
    expect(win32.getProcessIdentityByPid).not.toHaveBeenCalled();
  });
});
