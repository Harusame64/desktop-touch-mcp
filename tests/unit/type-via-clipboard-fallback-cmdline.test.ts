/**
 * type-via-clipboard-fallback-cmdline.test.ts — ADR-033 PR-2.
 *
 * `FALLBACK_MAX_CHARS` is not a policy number. It exists because the PowerShell
 * fallback hands its whole payload to `CreateProcessW` as a command line, and
 * Windows rejects one past 32 767 characters. Base64 of UTF-16LE costs ~2.67
 * characters per character of text, so the cap and the ceiling are separated by
 * a multiplier, not by a constant — which makes "how much room is left" the kind
 * of thing nobody recomputes before raising a limit by "just a bit".
 *
 * ADR-033 PR-1 measured the boundary against the WRITE script: 12 117
 * characters went through and 12 214 failed with a raw `ENAMETOOLONG` from
 * `spawn`. PR-2 added a second, LONGER script — the restore, which carries the
 * saved clipboard plus a 64-character hash and more surrounding PowerShell — and
 * that one overflows ~16 characters BEFORE 12 117. So the measured boundary no
 * longer describes the binding constraint, and the only reason the fallback
 * works is that the cap sits at 12 000, below both.
 *
 * That is exactly the kind of fact that survives as a comment for one release
 * and then gets edited away. Here it is arithmetic instead: raise
 * `FALLBACK_MAX_CHARS` and this file fails.
 *
 * No clipboard, no spawn — the production builders are pure and are called
 * directly, so what is measured is the string production actually sends.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { FALLBACK_MAX_CHARS } from "../../src/tools/clipboard.js";
import {
  POWERSHELL_ARGS,
  buildFallbackWriteScript,
  buildFallbackRestoreScript,
} from "../../src/tools/keyboard.js";

/**
 * Hard Windows limit for a `CreateProcessW` command line (`lpCommandLine` is
 * documented as 32 767 characters including the terminating null).
 */
const CMDLINE_MAX = 32_767;

/**
 * Length of the command line Windows actually receives.
 *
 * `execFile` does not go through a shell, so this is `powershell.exe` followed
 * by each argument separated by a space, with the script quoted because it
 * contains spaces. The scripts contain no `"` of their own, so Node adds no
 * escape characters — two quote characters and nothing else.
 */
function commandLineLength(script: string): number {
  return ["powershell.exe", ...POWERSHELL_ARGS].join(" ").length + 1 + script.length + 2;
}

/** What the fallback builds for a payload of exactly `chars` characters. */
function writeCommandLine(chars: number): number {
  const payloadB64 = Buffer.from("x".repeat(chars), "utf16le").toString("base64");
  return commandLineLength(buildFallbackWriteScript(payloadB64));
}

/** What the fallback builds to restore a saved clipboard of exactly `chars`. */
function restoreCommandLine(chars: number): number {
  const savedB64 = Buffer.from("y".repeat(chars), "utf16le").toString("base64");
  const hash = createHash("sha256").update(Buffer.from("payload", "utf16le")).digest("hex");
  return commandLineLength(buildFallbackRestoreScript(savedB64, hash));
}

describe("ADR-033 — the PowerShell fallback fits in a Windows command line", () => {
  it("the write script fits at exactly the cap", () => {
    // The payload gate is `text.length > FALLBACK_MAX_CHARS`, so a payload OF
    // the cap is admitted and must go through.
    const len = writeCommandLine(FALLBACK_MAX_CHARS);
    expect(len, `write command line at the cap: ${len}`).toBeLessThan(CMDLINE_MAX);
  });

  it("the restore script fits at exactly the cap", () => {
    // Same gate on the restore side (`savedClipboard.length > FALLBACK_MAX_CHARS`
    // skips it), so the same boundary case has to hold for this script too.
    const len = restoreCommandLine(FALLBACK_MAX_CHARS);
    expect(len, `restore command line at the cap: ${len}`).toBeLessThan(CMDLINE_MAX);
  });

  it("the restore script is the longer of the two — it is what binds the cap", () => {
    // Recorded as an assertion rather than a comment because it inverts the
    // intuition inherited from PR-1: the write script was the one that got
    // measured, so it is the one a future reader will size the cap against.
    // Whichever script is longer is the one the budget has to be computed from,
    // and if that ever stops being the restore, the reasoning below changes.
    expect(restoreCommandLine(FALLBACK_MAX_CHARS)).toBeGreaterThan(
      writeCommandLine(FALLBACK_MAX_CHARS),
    );
  });

  it("stays below the boundary PR-1 measured against the write script", () => {
    // 12 117 characters went through and 12 214 failed with ENAMETOOLONG — for
    // the WRITE script. The restore script is longer, so 12 117 is NOT a safe
    // cap any more:
    expect(restoreCommandLine(12_117)).toBeGreaterThan(CMDLINE_MAX);
    // ...which is the whole point of keeping the cap where it is.
    expect(FALLBACK_MAX_CHARS).toBeLessThan(12_117);
  });

  it("has room for a payload of any shape, not just the ASCII used above", () => {
    // Base64 is computed over UTF-16LE bytes, so every BMP character costs the
    // same 2 bytes and an astral one costs 4 — but `String.length` counts UTF-16
    // code units, which is what the cap gates on, so the byte cost per counted
    // unit is 2 either way. Pinned so a future change to the encoding (UTF-8,
    // say, where a CJK character costs 3 bytes per 1 code unit) cannot silently
    // make the cap under-count.
    const cjk = Buffer.from("あ".repeat(FALLBACK_MAX_CHARS), "utf16le").toString("base64");
    const astral = Buffer.from("😀".repeat(FALLBACK_MAX_CHARS / 2), "utf16le").toString("base64");
    for (const [label, b64] of [["cjk", cjk], ["astral", astral]] as const) {
      const len = commandLineLength(buildFallbackWriteScript(b64));
      expect(len, `${label} write command line: ${len}`).toBeLessThan(CMDLINE_MAX);
    }
  });

  it("counts the real argument prefix", () => {
    // The budget shrinks if a flag is added to every invocation, so the prefix
    // is imported from production rather than spelled out here.
    expect([...POWERSHELL_ARGS]).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  });
});
