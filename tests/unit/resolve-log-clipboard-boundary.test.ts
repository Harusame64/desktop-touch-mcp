/**
 * resolve-log-clipboard-boundary.test.ts — ADR-035 Phase 1.
 *
 * Why the `clipboard_paste` event lives INSIDE `typeViaClipboard` rather than at
 * the two call sites that reach it.
 *
 * The PowerShell fallback verifies the clipboard write by reading it back, and
 * throws `ClipboardWriteNotDelivered` **before** the Ctrl+V. An event at the
 * call site would therefore record a paste for a call that never pressed a key
 * (Opus Round 2 P1). Moving it to the chord is only meaningful if something
 * proves it: reverting the move makes the first test here fail.
 *
 * The native backend is deliberately the other way round — the addon owns
 * save / verify / paste / restore as one indivisible transaction, so everything
 * that can fail before the keystroke fails INSIDE the call being recorded, and
 * the event legitimately precedes it. Both halves are pinned.
 *
 * `node:child_process` is stubbed through the promisify seam so no PowerShell
 * is spawned and the developer's clipboard is never touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom");

/** Queue of `{stdout}` results (or errors) the stubbed PowerShell returns. */
let execResults: Array<{ stdout: string } | Error> = [];
const mockExec = vi.fn(async () => {
  const next = execResults.shift() ?? { stdout: "" };
  if (next instanceof Error) throw next;
  return next;
});

vi.mock("node:child_process", () => {
  const execFile: any = () => {
    throw new Error("callback form of execFile is not used by production code");
  };
  execFile[PROMISIFY_CUSTOM] = (...a: unknown[]) => mockExec(...(a as []));
  return { execFile, execSync: vi.fn(() => ""), spawn: vi.fn() };
});

const mockPressKey = vi.fn(async () => undefined);
const mockReleaseKey = vi.fn(async () => undefined);
vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    type: vi.fn(async () => undefined),
    pressKey: (...a: unknown[]) => mockPressKey(...(a as [])),
    releaseKey: (...a: unknown[]) => mockReleaseKey(...(a as [])),
  },
  rawKeyboard: { pressKeyDown: vi.fn(), pressKeyUp: vi.fn() },
  withKeyboardLock: (fn: () => Promise<unknown>) => fn(),
}));

/** Flipped per test to choose which backend `typeViaClipboard` dispatches to. */
let nativeAvailable = false;
const mockNativeCall = vi.fn(async () => ({
  ok: true,
  pasted: true,
  clipboardRestored: true,
  verify: { ok: true, postCloseChecked: true },
}));
vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return {
    ...actual,
    hasNativeTypeViaClipboard: () => nativeAvailable,
    nativeWin32: {
      ...(actual.nativeWin32 ?? {}),
      win32TypeViaClipboard: (...a: unknown[]) => mockNativeCall(...(a as [])),
    },
  };
});

const mockLogDiagnostic = vi.fn();
vi.mock("../../src/engine/diagnostic-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/diagnostic-log.js")>();
  return {
    ...actual,
    logDiagnostic: (...a: unknown[]) => mockLogDiagnostic(...(a as [])),
    isDiagnosticLogEnabled: () => true,
  };
});

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    getForegroundHwnd: () => 0x1n,
    getWindowTitleW: () => "Some Window",
  };
});

const { typeViaClipboard } = await import("../../src/tools/keyboard.js");

function pasteEvents(): Array<Record<string, any>> {
  return mockLogDiagnostic.mock.calls
    .map((c) => c[0] as Record<string, any>)
    .filter((e) => e.kind === "dispatch_sink" && e.sink === "clipboard_paste");
}

/** Base64 of the UTF-16LE bytes, which is what the read-back is compared against. */
function b64(text: string): string {
  return Buffer.from(text, "utf16le").toString("base64");
}

beforeEach(() => {
  vi.clearAllMocks();
  execResults = [];
  nativeAvailable = false;
});

describe("ADR-035 Phase 1 — the clipboard paste boundary", () => {
  it("fallback: a write that does not verify records NO paste (and presses no key)", () => {
    // save → "", write → a read-back that does NOT match the payload.
    execResults = [{ stdout: "" }, { stdout: b64("something else entirely") }];
    return expect(typeViaClipboard("hello", "ctrl+v", "keyboard:type"))
      .rejects.toThrow(/ClipboardWriteNotDelivered/)
      .then(() => {
        expect(mockPressKey).not.toHaveBeenCalled();
        expect(pasteEvents()).toHaveLength(0);
      });
  });

  it("fallback: a write that verifies records exactly one paste, at the chord", async () => {
    execResults = [{ stdout: "" }, { stdout: b64("hello") }, { stdout: "" }];
    await typeViaClipboard("hello", "ctrl+v", "keyboard:type");
    expect(mockPressKey).toHaveBeenCalledTimes(1);
    expect(pasteEvents()).toHaveLength(1);
    expect(pasteEvents()[0]).toMatchObject({ tool: "keyboard:type", targetHwnd: null });
  });

  it("carries the caller's tool name, because terminal:send reaches the same paste", async () => {
    execResults = [{ stdout: "" }, { stdout: b64("ls") }, { stdout: "" }];
    await typeViaClipboard("ls", "ctrl+v", "terminal:send");
    expect(pasteEvents()[0]).toMatchObject({ tool: "terminal:send" });
  });

  it("native: records a paste when the addon reports the chord went out", async () => {
    nativeAvailable = true;
    await typeViaClipboard("hello", "ctrl+v", "keyboard:type");
    expect(mockNativeCall).toHaveBeenCalledTimes(1);
    expect(pasteEvents()).toHaveLength(1);
    // No PowerShell was spawned on this path.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("native: records NOTHING when the addon reports nothing was typed", async () => {
    // `paste_deadline_exceeded` — the composite ran, replaced the clipboard,
    // and refused to send the chord. The handler tells the caller nothing was
    // typed, so the log must not say otherwise (Codex Round 2).
    nativeAvailable = true;
    mockNativeCall.mockResolvedValueOnce({
      ok: false,
      pasted: false,
      reason: "paste_deadline_exceeded",
      clipboardRestored: false,
      verify: { ok: false, postCloseChecked: false },
    } as never);
    await expect(typeViaClipboard("hello", "ctrl+v", "keyboard:type")).rejects.toThrow();
    expect(pasteEvents()).toHaveLength(0);
  });

  it("native: records a paste for a partially-accepted chord that may have landed", async () => {
    // `send_input_partial`: a prefix reached the V key-down, so the target may
    // already have pasted. Recording it is the honest half of the same rule.
    nativeAvailable = true;
    mockNativeCall.mockResolvedValueOnce({
      ok: false,
      pasted: true,
      reason: "send_input_partial",
      clipboardRestored: true,
      verify: { ok: false, postCloseChecked: false },
    } as never);
    await expect(typeViaClipboard("hello", "ctrl+v", "keyboard:type")).rejects.toThrow();
    expect(pasteEvents()).toHaveLength(1);
  });
});
