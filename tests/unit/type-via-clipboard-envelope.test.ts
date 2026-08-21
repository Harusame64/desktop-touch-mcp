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

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const execFileMock = vi.fn();

// Needed only by the addon-less case at the bottom of the keyboard block — the
// fallback reaches the clipboard through `powershell.exe`, and nothing here may
// actually spawn one.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

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
  // Real signature is `withKeyboardLock(fn)` — one argument. Getting the arity
  // wrong here silently turns every locked call into a throw.
  withKeyboardLock: vi.fn((fn: () => Promise<unknown>) => fn()),
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
const nutjs = await import("../../src/engine/nutjs.js");
const focus = await import("../../src/tools/_focus.js");

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
    clipboardModified: true,
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
  execFileMock.mockReset();
});

/** Queue `{stdout}` resolutions for the fallback's successive spawns. */
function powerShellResponses(...stdouts: string[]) {
  let i = 0;
  execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
    const stdout = stdouts[i++] ?? "";
    (cb as (e: null, out: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: "" });
    return {};
  });
}

describe("ADR-033 — the clipboard side effect reaches the keyboard envelope", () => {
  // ADR-038: `keyboardArgs` deliberately carries no `windowTitle` / `hwnd` —
  // this block is about what the clipboard reports, not about targeting, and a
  // window mock would only add noise. Since ADR-038 that shape is refused by
  // default, so the block opts into the ADR's own documented downgrade. Every
  // assertion below is unchanged; the only difference in the envelope is one
  // extra entry in `hints.warnings`, which nothing here reads.
  let prevRequireDestination: string | undefined;
  beforeAll(() => {
    prevRequireDestination = process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION;
    process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION = "0";
  });
  afterAll(() => {
    if (prevRequireDestination === undefined) delete process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION;
    else process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION = prevRequireDestination;
  });

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

  it("reports a restore that was attempted and failed", async () => {
    // The one outcome that can leave the clipboard EMPTY rather than holding
    // someone's value — so it must not arrive as an anonymous `restored:false`.
    nativeState.composite.mockResolvedValue(
      nativeResult({ clipboardRestored: false, restoreFailedReason: "clipboard_alloc_failed" }),
    );
    const c = clipboardHints(body(await keyboardTypeHandler(keyboardArgs)))!;
    expect(c.restored).toBe(false);
    expect(c.restoreFailedReason).toBe("clipboard_alloc_failed");
    expect(c.restoreSkippedRace).toBeUndefined();
  });

  it("reports a paste the post-close read never verified", async () => {
    // The chord went out on the in-session read-back alone. That is the
    // deliberate choice — requiring the second read would make typing a silent
    // no-op whenever another application merely reads the clipboard — but the
    // caller cannot see it any other way, and the composite pressed the keys.
    nativeState.composite.mockResolvedValue(
      nativeResult({
        verify: {
          ...nativeResult().verify,
          postCloseChecked: false,
          postCloseMatch: false,
          postCloseSkipReason: "clipboard_lock_contention",
        },
      }),
    );
    const c = clipboardHints(body(await keyboardTypeHandler(keyboardArgs)))!;
    expect(c.postCloseUnverified).toBe(true);
  });

  it("says nothing about verification when both read-backs answered", async () => {
    nativeState.composite.mockResolvedValue(nativeResult());
    expect(clipboardHints(body(await keyboardTypeHandler(keyboardArgs)))!.postCloseUnverified)
      .toBeUndefined();
  });

  it("never claims an unverified paste on the addon-less path", async () => {
    // The same contrapositive as the outcome-level pin in
    // `type-via-clipboard-native-dispatch.test.ts`, carried all the way to the
    // response: the fallback's single `Get-Clipboard -Raw` runs after
    // `Set-Clipboard` released the lock, so it IS the post-close read and is
    // always checked. The key is native-only, and this is what would notice if
    // it started leaking through the fallback's outcome (Opus R2 P3-3).
    nativeState.available = false;
    powerShellResponses(
      Buffer.from("previous", "utf16le").toString("base64"),
      Buffer.from("hello", "utf16le").toString("base64"),
      "restored",
    );

    const c = clipboardHints(body(await keyboardTypeHandler(keyboardArgs)))!;

    expect(c.backend).toBe("powershell");
    expect(c.restored).toBe(true);
    expect(c).not.toHaveProperty("postCloseUnverified");
  });

  it("carries the clipboard facts into a FAILURE envelope too", async () => {
    // The paste failed after the clipboard had already been replaced. Whether
    // it was put back is a fact only this call knows, and it used to die at the
    // catch: the caller was told the paste failed while their clipboard
    // silently held our text. `context.clipboard` is the failure-side mirror of
    // `hints.clipboard`.
    nativeState.composite.mockResolvedValue(
      nativeResult({
        ok: false,
        reason: "paste_deadline_exceeded",
        pasted: false,
        clipboardRestored: false,
        restoreFailedReason: "clipboard_alloc_failed",
      }),
    );

    const r = body(await keyboardTypeHandler(keyboardArgs));

    expect(r.ok).toBe(false);
    const clipboard = (r.context as Record<string, unknown>).clipboard as Record<string, unknown>;
    expect(clipboard.backend).toBe("native");
    expect(clipboard.restored).toBe(false);
    expect(clipboard.restoreFailedReason).toBe("clipboard_alloc_failed");
  });

  it("distinguishes a clipboard it never touched from one it did not restore", async () => {
    // A pre-write failure: the user's clipboard is exactly where they left it.
    // Reaching the envelope matters because `restored:false` is the alarming
    // reading, and acting on it (re-copying, hunting for lost content) is wasted
    // work here.
    nativeState.composite.mockResolvedValue(
      nativeResult({
        ok: false,
        reason: "hidden_owner_create_failed",
        pasted: false,
        clipboardModified: false,
        clipboardRestored: false,
        verify: { ...nativeResult().verify, ok: false, reason: "hidden_owner_create_failed" },
      }),
    );

    const r = body(await keyboardTypeHandler(keyboardArgs));

    expect(r.ok).toBe(false);
    const clipboard = (r.context as Record<string, unknown>).clipboard as Record<string, unknown>;
    expect(clipboard.untouched).toBe(true);
    expect(clipboard.restored).toBe(false);
    // No fabricated cause: nothing was attempted, so nothing was skipped or
    // failed.
    expect(clipboard).not.toHaveProperty("restoreSkippedRace");
    expect(clipboard).not.toHaveProperty("restoreSkippedTooLarge");
    expect(clipboard).not.toHaveProperty("restoreUnavailable");
    expect(clipboard).not.toHaveProperty("restoreFailedReason");
  });

  it("does not change how a failed paste is classified", async () => {
    // `_errors.ts::classify` routes on the message text, so attaching the
    // clipboard payload had to leave every message byte-identical. A
    // verification failure stays the compact code; the deadline and
    // chord-refusal messages stay lower-case and therefore generic. Getting
    // this wrong would silently re-route recovery advice.
    // The fourth column pins what the message CLAIMS, not just where it
    // routes. `send_input_failed` and `send_input_partial` share a code but
    // state opposite facts — "nothing pasted" versus "may already have
    // pasted" — and collapsing the second into the first is what invites the
    // blind retry that double-pastes (Opus R6 P2-1).
    const cases: Array<
      [reason: string, verifyOk: boolean, code: string, says: string | null]
    > = [
      ["clipboard_replaced_after_write", false, "ClipboardWriteNotDelivered", null],
      ["paste_deadline_exceeded", true, "ToolError", "nothing was typed"],
      ["send_input_failed", true, "ToolError", "not accepted"],
      // A chord whose prefix reached the V key-down: the target may have
      // pasted, so this is NOT a delivery failure to retry blindly.
      ["send_input_partial", true, "ToolError", "may already have pasted"],
    ];
    for (const [reason, verifyOk, code, says] of cases) {
      nativeState.composite.mockResolvedValue(
        nativeResult({
          ok: false,
          reason,
          pasted: false,
          verify: { ...nativeResult().verify, ok: verifyOk, reason },
        }),
      );
      const r = body(await keyboardTypeHandler(keyboardArgs));
      expect(r.ok, reason).toBe(false);
      expect(r.code, reason).toBe(code);
      if (says !== null) {
        expect(r.error, reason).toContain(says);
      }
      // The maybe-pasted case must never read as a clean refusal.
      if (reason === "send_input_partial") {
        expect(r.error, reason).not.toContain("not accepted");
      }
      // ...and the payload rode along regardless of which branch threw.
      expect((r.context as Record<string, unknown>).clipboard, reason).toBeDefined();
    }
  });

  it("still reports the clipboard when a step AFTER the paste throws", async () => {
    // keyboard's twin of the terminal pin below (Opus R6 P3-1): here the
    // post-paste step that can throw is the focus-loss detection, which runs
    // when `trackFocus` is on — the default the shipped tool uses, unlike this
    // file's other cases. The paste succeeded, so without the clipboard block a
    // caller told only "keyboard:type failed" retries and types twice.
    nativeState.composite.mockResolvedValue(nativeResult());
    vi.mocked(focus.detectFocusLoss).mockRejectedValueOnce(new Error("UIA exploded"));

    const r = body(await keyboardTypeHandler({ ...keyboardArgs, trackFocus: true }));

    expect(r.ok).toBe(false);
    const clipboard = (r.context as Record<string, unknown>).clipboard as Record<string, unknown>;
    expect(clipboard.backend).toBe("native");
    expect(clipboard.restored).toBe(true);
  });

  it("reports the fallback's un-restored clipboard on a failed write", async () => {
    // The PowerShell path throws BEFORE its restore, so the user is left
    // holding whatever the failed write put there. Saying `restored:false` is
    // the honest answer, and it is the backend divergence made visible.
    nativeState.available = false;
    powerShellResponses(
      Buffer.from("previous", "utf16le").toString("base64"),
      Buffer.from("something else entirely", "utf16le").toString("base64"),
    );

    const r = body(await keyboardTypeHandler(keyboardArgs));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ClipboardWriteNotDelivered");
    const clipboard = (r.context as Record<string, unknown>).clipboard as Record<string, unknown>;
    expect(clipboard.backend).toBe("powershell");
    expect(clipboard.restored).toBe(false);
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

  it("reports a restore that was attempted and failed", async () => {
    nativeState.composite.mockResolvedValue(
      nativeResult({ clipboardRestored: false, restoreFailedReason: "clipboard_alloc_failed" }),
    );
    const c = clipboardHints(body(await terminalSendHandler(terminalArgs)))!;
    expect(c.restored).toBe(false);
    expect(c.restoreFailedReason).toBe("clipboard_alloc_failed");
  });

  it("reports a paste the post-close read never verified", async () => {
    nativeState.composite.mockResolvedValue(
      nativeResult({
        verify: { ...nativeResult().verify, postCloseChecked: false, postCloseMatch: false },
      }),
    );
    const c = clipboardHints(body(await terminalSendHandler(terminalArgs)))!;
    expect(c.postCloseUnverified).toBe(true);
  });

  it("carries the clipboard facts into a FAILURE envelope too", async () => {
    nativeState.composite.mockResolvedValue(
      nativeResult({
        ok: false,
        reason: "paste_deadline_exceeded",
        pasted: false,
        clipboardRestored: false,
        restoreSkippedRace: true,
      }),
    );

    const r = body(await terminalSendHandler(terminalArgs));

    expect(r.ok).toBe(false);
    const clipboard = (r.context as Record<string, unknown>).clipboard as Record<string, unknown>;
    expect(clipboard.backend).toBe("native");
    expect(clipboard.restored).toBe(false);
    expect(clipboard.restoreSkippedRace).toBe(true);
    // The context this handler already published is not displaced by it.
    expect((r.context as Record<string, unknown>).windowTitle).toBe("Notepad");
  });

  it("still reports the clipboard when a step AFTER the paste throws", async () => {
    // The dangerous shape: the paste succeeded, so the text is already in the
    // terminal, and then the Enter throws. Told only "terminal:send failed", a
    // caller retries and the input lands twice. The clipboard block is what says
    // the send got that far.
    nativeState.composite.mockResolvedValue(nativeResult());
    vi.mocked(nutjs.keyboard.pressKey).mockRejectedValueOnce(new Error("Enter exploded"));

    const r = body(await terminalSendHandler({ ...terminalArgs, pressEnter: true }));

    expect(r.ok).toBe(false);
    const clipboard = (r.context as Record<string, unknown>).clipboard as Record<string, unknown>;
    expect(clipboard.backend).toBe("native");
    expect(clipboard.restored).toBe(true);
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
