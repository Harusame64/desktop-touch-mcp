/**
 * issue-211-typeviaclipboard-readback-pin.test.ts
 *
 * `typeViaClipboard` Get-Clipboard read-back verification contract pin —
 * Phase 5 E1 (epic #211) follow-up to PR #213 Phase 2b execution audit.
 *
 * Audit history (Phase 2b §3 E1, audit doc correction land in this PR):
 *   The original Phase 2b finding said "clipboard:write nested code shape
 *   pin 不在" — but reading the production code while implementing E1
 *   revealed `typeViaClipboard` (keyboard.ts) did Set-Clipboard via
 *   PowerShell directly without the Get-Clipboard read-back verification
 *   that `clipboard:write` (clipboard.ts) added in PR #180. So the audit's
 *   "nested code shape" presumed a contract that did not exist.
 *
 * Phase 5 E1 fix (this PR): align typeViaClipboard with the clipboard:write
 *   contract — combine Set-Clipboard + Get-Clipboard -Raw inside a single
 *   PowerShell invocation, byte-equal compare UTF-16LE, throw
 *   `ClipboardWriteNotDelivered` on mismatch (auto-classified via
 *   `_errors.ts:397-398`). Production fix lands in keyboard.ts:38-100.
 *
 * Pattern reference: `tests/unit/issue-207-foreground-refusal-mouse-drag.test.ts`
 *   (E3 silent-fail bug discovered during Phase 5 audit closure — same
 *   family inheritance miss pattern: PR #180 added read-back to clipboard:write
 *   but typeViaClipboard was overlooked, mirroring how PR #202/#206 added the
 *   ForegroundRestricted early-return to mouse_click but missed mouse_drag).
 *
 * Three cases pinned:
 *   1. Get-Clipboard read-back returns mismatched bytes → typeViaClipboard
 *      throws ClipboardWriteNotDelivered
 *   2. Get-Clipboard read-back returns empty (clipboard cleared between
 *      Set and Get) → ClipboardWriteNotDelivered (the production code
 *      treats empty as a mismatch when expectedBytes.length > 0)
 *   3. Get-Clipboard read-back returns matching bytes → typeViaClipboard
 *      completes normally, paste combo dispatched
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() so the mock impl is initialized before the vi.mock factory
// runs (vi.mock is hoisted to the top of the file). Without hoisted(), the
// factory captures a TDZ ref to the outer-scope const and throws
// ReferenceError at the import site.
//
// `promisify(execFile)` reads `execFile[util.promisify.custom]` first
// (Node's built-in execFile sets this to return Promise<{stdout, stderr}>);
// we attach the same custom symbol on our mock so `const { stdout } = await
// execFileAsync(...)` destructures correctly. Without the custom symbol,
// generic callback-promisify resolves to just the first non-error arg
// (a string), breaking the `.trim()` call in typeViaClipboard.
const { mockExecFile, mockExecFileWithCustom } = vi.hoisted(() => {
  // Resolve util.promisify.custom inside the hoisted block so the import
  // happens after vitest's hoisting reorder.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const util = require("node:util") as typeof import("node:util");
  const impl = vi.fn();
  const wrapper = Object.assign(
    (...args: unknown[]) => impl(...args),
    {
      [util.promisify.custom]: (...args: unknown[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const result = impl(...args);
          if (result && typeof result.then === "function") {
            result.then(resolve, reject);
          } else if (result instanceof Error) {
            reject(result);
          } else {
            resolve(result ?? { stdout: "", stderr: "" });
          }
        }),
    },
  );
  return { mockExecFile: impl, mockExecFileWithCustom: wrapper };
});

vi.mock("node:child_process", () => ({
  execFile: mockExecFileWithCustom,
}));

// nutjs paste combo press/release — make the success-path test work without
// actually hitting Windows input pipeline.
vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: {
    pressKey: vi.fn(() => Promise.resolve()),
    releaseKey: vi.fn(() => Promise.resolve()),
  },
}));

import { typeViaClipboard } from "../../src/tools/keyboard.js";
import * as nutjs from "../../src/engine/nutjs.js";

const mockPressKey = vi.mocked(nutjs.keyboard.pressKey);
const mockReleaseKey = vi.mocked(nutjs.keyboard.releaseKey);

/** Queue a {stdout, stderr} resolution for the next execFile call. */
function mockExecFileResolvesWith(stdout: string): void {
  mockExecFile.mockImplementationOnce(() =>
    Promise.resolve({ stdout, stderr: "" }),
  );
}

/** Encode a UTF-16LE buffer-like blob as base64 — matches PowerShell side. */
function utf16LeBase64(text: string): string {
  return Buffer.from(text, "utf16le").toString("base64");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Phase 5 E1 (epic #211): typeViaClipboard Get-Clipboard read-back verification pin", () => {
  it("throws ClipboardWriteNotDelivered when Get-Clipboard read-back returns mismatched bytes", async () => {
    // Production execFile call sequence (keyboard.ts:38-100):
    //   1. Get-Clipboard (save) — return previous content
    //   2. Set-Clipboard + Get-Clipboard -Raw (verify) — return MISMATCHED base64
    //   3. (Throw fires before reaching the restore call — only 2 execFile calls)
    mockExecFileResolvesWith("previous content"); // save
    mockExecFileResolvesWith(utf16LeBase64("WRONG TEXT — DLP intercepted")); // verify (mismatch)

    await expect(typeViaClipboard("hello world", "ctrl+v")).rejects.toThrow(
      "ClipboardWriteNotDelivered",
    );

    // Critical: paste combo MUST NOT have been dispatched — pre-fix path
    // pressed paste with whatever was on the clipboard (silent paste of
    // wrong text into the target window).
    expect(mockPressKey).not.toHaveBeenCalled();
    expect(mockReleaseKey).not.toHaveBeenCalled();
    // Two execFile calls: save + verify. No restore (verify failed → throw).
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("throws ClipboardWriteNotDelivered when Get-Clipboard read-back returns empty (clipboard cleared mid-write)", async () => {
    mockExecFileResolvesWith(""); // save (clipboard was empty)
    mockExecFileResolvesWith(""); // verify — empty stdout means clipboard was null

    await expect(typeViaClipboard("non-empty payload", "ctrl+v")).rejects.toThrow(
      "ClipboardWriteNotDelivered",
    );

    expect(mockPressKey).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("completes normally when Get-Clipboard read-back returns matching bytes (paste dispatched)", async () => {
    const payload = "matching text";
    mockExecFileResolvesWith("previous"); // save
    mockExecFileResolvesWith(utf16LeBase64(payload)); // verify (match)
    mockExecFileResolvesWith(""); // restore (best-effort)

    await expect(typeViaClipboard(payload, "ctrl+v")).resolves.toBeUndefined();

    // Paste combo dispatched on the success path.
    expect(mockPressKey).toHaveBeenCalled();
    expect(mockReleaseKey).toHaveBeenCalled();
    // Three execFile calls: save + verify + restore.
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });
});
