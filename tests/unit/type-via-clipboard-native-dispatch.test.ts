/**
 * type-via-clipboard-native-dispatch.test.ts — ADR-033 PR-2 (P2-2).
 *
 * `typeViaClipboard` is the hottest clipboard path in the server: every
 * non-ASCII `keyboard(action='type')` is promoted to it and
 * `terminal(action='send')` defaults to it. It used to spawn three
 * `powershell.exe` processes per call, one of them carrying the base64
 * decoded-inline command line Microsoft Defender scored as
 * `Trojan:Win32/Commando.A!ml`.
 *
 * Three things are pinned here.
 *
 * (a) THE GUARD — with the addon present, nothing is spawned. The assertion is
 *     on `execFile` never being called, not on the result shape, because a
 *     regression that quietly fell back would have no visible symptom until the
 *     next Defender kill. Mutation-checked: see the report for the two
 *     mutations (force `hasNativeTypeViaClipboard()` false; delete the native
 *     branch) that make these fail.
 *
 * (b) THE DISCLOSURE — the outcome the function now returns. It used to be
 *     `Promise<void>`, so "we did not put your clipboard back" had nowhere to
 *     go. Each way that can happen is asserted separately, because they are
 *     different facts for a caller (someone else owns the clipboard now / the
 *     content was too large for the fallback / the save never worked).
 *
 * (c) THE FALLBACK's three fixes — `-Raw` on the save, a restore that no longer
 *     clobbers a concurrent writer, and an up-front length check instead of a
 *     raw `ENAMETOOLONG` from `spawn`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => execFileMock(...args) };
});

// The paste chord. Mocked so the fallback path does not inject real keystrokes.
vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    type: vi.fn(() => Promise.resolve()),
    pressKey: vi.fn(() => Promise.resolve()),
    releaseKey: vi.fn(() => Promise.resolve()),
  },
  withKeyboardLock: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
  rawKeyboard: {},
}));

const nativeState: { available: boolean; composite: ReturnType<typeof vi.fn> } = {
  available: true,
  composite: vi.fn(),
};

// Partial mock: native-engine is the single load point for the whole addon and
// unrelated importers read other members of it at module init.
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

const { typeViaClipboard } = await import("../../src/tools/keyboard.js");
const nutjs = await import("../../src/engine/nutjs.js");

/** A native result whose verification passed and whose chord landed. */
function nativeOk(over: Record<string, unknown> = {}) {
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

/** promisify(execFile) resolves the first non-error callback argument. */
function powerShellResponses(...stdouts: string[]) {
  let i = 0;
  execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
    const stdout = stdouts[i++] ?? "";
    (cb as (e: null, out: { stdout: string; stderr: string }) => void)(null, { stdout, stderr: "" });
    return {};
  });
}

/** The `-Command` argument of the n-th spawn. */
function scriptOf(call: number): string {
  return (execFileMock.mock.calls[call]![1] as string[])[3]!;
}

const b64 = (s: string) => Buffer.from(s, "utf16le").toString("base64");

beforeEach(() => {
  execFileMock.mockReset();
  nativeState.composite.mockReset();
  nativeState.available = true;
  vi.mocked(nutjs.keyboard.pressKey).mockClear();
  vi.mocked(nutjs.keyboard.releaseKey).mockClear();
});

// ── (a) the guard ───────────────────────────────────────────────────────────

describe("ADR-033 — with the addon present, typeViaClipboard spawns nothing", () => {
  it("goes native, spawns no process, and hands the addon UTF-16LE bytes", async () => {
    nativeState.composite.mockResolvedValue(nativeOk());

    const r = await typeViaClipboard("日本語 hello", "ctrl+v");

    expect(r.backend).toBe("native");
    expect(execFileMock).not.toHaveBeenCalled();
    const [payload, combo] = nativeState.composite.mock.calls[0]!;
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect((payload as Buffer).equals(Buffer.from("日本語 hello", "utf16le"))).toBe(true);
    expect(combo).toBe("ctrl+v");
  });

  it("passes ctrl+shift+v straight through", async () => {
    nativeState.composite.mockResolvedValue(nativeOk());
    await typeViaClipboard("x", "ctrl+shift+v");
    expect(nativeState.composite.mock.calls[0]![1]).toBe("ctrl+shift+v");
  });

  it("does not send the chord itself — the addon owns the whole transaction", async () => {
    // Sending it here too would double-paste: the composite already emitted
    // ctrl+v inside the addon, between the verification and the restore.
    nativeState.composite.mockResolvedValue(nativeOk());
    await typeViaClipboard("x");
    expect(nutjs.keyboard.pressKey).not.toHaveBeenCalled();
    expect(nutjs.keyboard.releaseKey).not.toHaveBeenCalled();
  });

  it("reports a verification failure as ClipboardWriteNotDelivered, without falling back", async () => {
    // Retrying through PowerShell after a native failure would put the flagged
    // command line back on the wire exactly when something is already wrong.
    nativeState.composite.mockResolvedValue(
      nativeOk({
        ok: false,
        reason: "clipboard_replaced_after_write",
        pasted: false,
        verify: { ...nativeOk().verify, ok: false, reason: "clipboard_replaced_after_write", postCloseMatch: false },
      }),
    );
    await expect(typeViaClipboard("hello")).rejects.toThrow("ClipboardWriteNotDelivered");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not blame the clipboard when the clipboard was fine and the chord was refused", async () => {
    // `SendInput` refusing the batch is not a delivery-verification failure, and
    // saying so would send the caller after a clipboard problem that does not
    // exist. Lower-case message ⇒ generic classification, no orphaned code.
    nativeState.composite.mockResolvedValue(
      nativeOk({ ok: false, reason: "send_input_failed", pasted: false }),
    );
    await expect(typeViaClipboard("hello")).rejects.toThrow(/paste keystroke was not accepted/);
    await expect(typeViaClipboard("hello")).rejects.not.toThrow("ClipboardWriteNotDelivered");
  });

  it("gives up on a clipboard owner that never answers, and aborts the task", async () => {
    // `GetClipboardData` waits, inside the call, for a delayed-rendering owner
    // to answer. The abort is what stops a task that is still QUEUED on libuv's
    // 4-thread pool — without it a call the caller already abandoned could run
    // minutes later and paste into whatever window has focus by then.
    vi.useFakeTimers();
    try {
      const seen: AbortSignal[] = [];
      nativeState.composite.mockImplementation((_p: unknown, _c: unknown, signal: unknown) => {
        seen.push(signal as AbortSignal);
        return new Promise(() => {});
      });

      const pending = typeViaClipboard("hello");
      const assertion = expect(pending).rejects.toThrow(/gave up after/);
      expect(seen[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(seen[0]!.aborted).toBe(true);
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── (b) the disclosure ──────────────────────────────────────────────────────

describe("ADR-033 — typeViaClipboard discloses what happened to the clipboard", () => {
  it("says nothing extra on the ordinary path", async () => {
    nativeState.composite.mockResolvedValue(nativeOk());
    const r = await typeViaClipboard("hello");
    expect(r).toEqual({ backend: "native", clipboardRestored: true });
  });

  it("surfaces a restore skipped because another process wrote first", async () => {
    // Not a failure — clobbering their value would be worse. But the user's own
    // clipboard is gone, and only the caller can tell them.
    nativeState.composite.mockResolvedValue(
      nativeOk({ clipboardRestored: false, restoreSkippedRace: true }),
    );
    const r = await typeViaClipboard("hello");
    expect(r.clipboardRestored).toBe(false);
    expect(r.restoreSkippedRace).toBe(true);
  });

  it("surfaces formats the snapshot could not carry", async () => {
    // An image on the clipboard is not coming back even though the restore ran.
    nativeState.composite.mockResolvedValue(
      nativeOk({ skippedFormats: [{ formatId: 2, reason: "non_hglobal" }] }),
    );
    const r = await typeViaClipboard("hello");
    expect(r.skippedFormats).toEqual([{ formatId: 2, reason: "non_hglobal" }]);
  });
});

// ── (c) the fallback ────────────────────────────────────────────────────────

describe("ADR-033 — PowerShell fallback (addon absent)", () => {
  beforeEach(() => {
    nativeState.available = false;
  });

  it("saves with -Raw, verifies the write, pastes, and restores — three spawns", async () => {
    powerShellResponses(b64("previous"), b64("payload"), "restored");

    const r = await typeViaClipboard("payload", "ctrl+v");

    expect(r.backend).toBe("powershell");
    expect(r.clipboardRestored).toBe(true);
    expect(nativeState.composite).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(3);
    // (1) the save keeps line breaks: without `-Raw`, `Get-Clipboard` returns an
    // ARRAY of lines and the multi-line clipboard came back mangled.
    expect(scriptOf(0)).toContain("Get-Clipboard -Raw");
    expect(nutjs.keyboard.pressKey).toHaveBeenCalled();
    expect(nutjs.keyboard.releaseKey).toHaveBeenCalled();
  });

  it("(2) restores only when the clipboard still holds what we pasted", async () => {
    // The restore script decides inside the same invocation, so the check and
    // the write cannot straddle another process's copy.
    powerShellResponses(b64("previous"), b64("payload"), "skipped_race");

    const r = await typeViaClipboard("payload");

    expect(r.clipboardRestored).toBe(false);
    expect(r.restoreSkippedRace).toBe(true);
    // The comparison travels as a hash, not as a second copy of the payload:
    // both blobs together would not fit in a command line.
    expect(scriptOf(2)).toMatch(/SHA256/);
    expect(scriptOf(2)).toContain("Get-Clipboard -Raw");
  });

  it("(3) rejects an over-long payload up front instead of letting spawn fail", async () => {
    await expect(typeViaClipboard("x".repeat(20_000))).rejects.toThrow(
      "ClipboardWriteTooLargeForFallback",
    );
    // The point of the pre-check: nothing was spawned, so the user's clipboard
    // is untouched and no keystroke was sent.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(nutjs.keyboard.pressKey).not.toHaveBeenCalled();
  });

  it("still types when the SAVED content is too large to put back, and says so", async () => {
    // The tie between "deliver the text" and "put the clipboard back" is broken
    // in favour of the input: this path is the only channel that reaches a
    // window with an IME open, and `terminal(action='send')` defaults to it, so
    // refusing would strand the caller. The clipboard content is normally
    // re-obtainable from wherever it was copied; a refused keystroke is not.
    powerShellResponses(b64("y".repeat(20_000)), b64("payload"));

    const r = await typeViaClipboard("payload");

    expect(r.clipboardRestored).toBe(false);
    expect(r.restoreSkippedTooLarge).toBe(true);
    // Two spawns: save + write. The restore was never attempted...
    expect(execFileMock).toHaveBeenCalledTimes(2);
    // ...and the text WAS delivered.
    expect(nutjs.keyboard.pressKey).toHaveBeenCalled();
  });

  it("discloses when the save itself failed, rather than reporting a restore", async () => {
    // `savedClipboard === null`: there was never anything to put back, which is
    // a different fact from "we chose not to".
    let call = 0;
    execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
      const fn = cb as (e: Error | null, out?: { stdout: string; stderr: string }) => void;
      if (call++ === 0) fn(new Error("clipboard is locked"));
      else fn(null, { stdout: b64("payload"), stderr: "" });
      return {};
    });

    const r = await typeViaClipboard("payload");

    expect(r.clipboardRestored).toBe(false);
    expect(r.restoreUnavailable).toBe(true);
    expect(r.restoreSkippedRace).toBeUndefined();
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(nutjs.keyboard.pressKey).toHaveBeenCalled();
  });

  it("still fails a mismatched read-back before pressing paste (#211 / I-3)", async () => {
    powerShellResponses(b64("previous"), b64("WRONG TEXT — DLP intercepted"));

    await expect(typeViaClipboard("payload")).rejects.toThrow("ClipboardWriteNotDelivered");

    // The whole point: no chord for a payload we could not prove is there.
    expect(nutjs.keyboard.pressKey).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(2); // save + verify, no restore
  });

  it("a restore failure does not fail an input that already landed", async () => {
    let call = 0;
    execFileMock.mockImplementation((_f: unknown, _a: unknown, _o: unknown, cb: unknown) => {
      const fn = cb as (e: Error | null, out?: { stdout: string; stderr: string }) => void;
      const n = call++;
      if (n === 2) fn(new Error("Command failed"));
      else fn(null, { stdout: n === 0 ? b64("previous") : b64("payload"), stderr: "" });
      return {};
    });

    const r = await typeViaClipboard("payload");
    expect(r.backend).toBe("powershell");
    expect(r.clipboardRestored).toBe(false);
  });
});
