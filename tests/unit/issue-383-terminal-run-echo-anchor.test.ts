/**
 * issue-383-terminal-run-echo-anchor.test.ts
 *
 * Unit tests for scanRegionAfterEcho — the fix for issue #383.
 *
 * Bug: `terminal(action='run')` + `until:{mode:'pattern'}` captured the
 * baseline marker BEFORE sending, so pattern matching scanned the echoed
 * command line and self-matched a sentinel embedded in the command
 * (e.g. `…; echo "DONE"` + pattern "DONE"), returning before the command
 * produced output.
 *
 * Fix: scanRegionAfterEcho locates the (normalised) input inside the
 * (already-normalised) post-baseline slice and returns only what FOLLOWS it,
 * so matching considers the command's real output, not its echo. When the echo
 * is not yet located it returns undefined (defer) rather than scanning the
 * whole slice, which would re-introduce the bug.
 *
 * scanRegionAfterEcho's contract: `postBaseline` is ALREADY normalised (it
 * comes from applySinceMarker in production); only `input` is normalised inside
 * the function. Tests therefore pass LF / no-trailing-whitespace postBaseline
 * strings.
 */

import { describe, it, expect } from "vitest";
import { scanRegionAfterEcho, isSecretInputPrompt, isHiddenInputPrompt } from "../../src/tools/terminal.js";

describe("scanRegionAfterEcho — issue #383 echo anchoring", () => {
  describe("core fix: scan region excludes the echoed command", () => {
    it("returns content AFTER the echoed input (real output)", () => {
      const post = `sleep 3; echo "DONE"\nDONE`;
      const input = `sleep 3; echo "DONE"`;
      expect(scanRegionAfterEcho(post, input)).toBe(`\nDONE`);
    });

    it("excludes a sentinel that appears in the command echo (the #383 bug)", () => {
      // Echo rendered, no output yet → region is "" so /DONE/ does NOT match
      // the echo's DONE (which would be a premature pattern_matched).
      const region = scanRegionAfterEcho(`sleep 3; echo "TASKDONE"`, `sleep 3; echo "TASKDONE"`);
      expect(region).toBe("");
      expect(/TASKDONE/.test(region!)).toBe(false);
    });

    it("matches the real output once it follows the echo", () => {
      const region = scanRegionAfterEcho(
        `sleep 3; echo "TASKDONE"\nTASKDONE`,
        `sleep 3; echo "TASKDONE"`,
      );
      expect(region).toBe(`\nTASKDONE`);
      expect(/TASKDONE/.test(region!)).toBe(true);
    });

    it("when the sentinel appears in BOTH echo and output, only the output remains", () => {
      const post = `echo "FOUND"; sleep 1; echo "FOUND"\nFOUND`;
      const input = `echo "FOUND"; sleep 1; echo "FOUND"`;
      const region = scanRegionAfterEcho(post, input);
      expect(region).toBe(`\nFOUND`);
      // The two FOUNDs in the echo are gone; only the real output FOUND is left.
      expect((region!.match(/FOUND/g) ?? []).length).toBe(1);
    });
  });

  describe("locate uses indexOf, not startsWith (prompt-prefix remnant, P2-1)", () => {
    it("locates the echo even when a prompt prefix precedes it", () => {
      // applySinceMarker can leave a prompt remnant at the head of the slice
      // when the prompt line is shorter than makeMarker's 256-char window.
      const post = `PS C:\\Users\\harus> echo "DONE"\nDONE`;
      expect(scanRegionAfterEcho(post, `echo "DONE"`)).toBe(`\nDONE`);
    });
  });

  describe("fast echo-only: no silent regression to timeout", () => {
    it("returns the output region when echo and output co-render", () => {
      const region = scanRegionAfterEcho(`echo "QUICK"\nQUICK`, `echo "QUICK"`);
      expect(region).toBe(`\nQUICK`);
      // Matches immediately — does NOT defer/timeout.
      expect(/QUICK/.test(region!)).toBe(true);
    });
  });

  describe("defer (return undefined) when the echo is not yet located", () => {
    it("defers on a partially-rendered echo (sentinel substring present)", () => {
      // The echo is mid-render: "TASK" is on screen but the full input isn't.
      // Returning the partial would re-introduce #383; defer instead.
      const region = scanRegionAfterEcho(`sleep 3; echo "TASK`, `sleep 3; echo "TASKDONE"`);
      expect(region).toBeUndefined();
    });

    it("defers when nothing matching the input has rendered yet", () => {
      expect(scanRegionAfterEcho(``, `sleep 3; echo "DONE"`)).toBeUndefined();
    });
  });

  describe("echo located, no output yet → empty region (valid for /^$/)", () => {
    it("returns '' so a sentinel pattern does not match the echo", () => {
      const region = scanRegionAfterEcho(`sleep 3; echo "DONE"`, `sleep 3; echo "DONE"`);
      expect(region).toBe("");
      expect(/DONE/.test(region!)).toBe(false);
    });
  });

  describe("multiline input", () => {
    it("anchors after the LAST echoed line (output follows the full echo)", () => {
      const post = `echo A\nsleep 1; echo DONE\nA\nDONE`;
      const input = `echo A\nsleep 1; echo DONE`;
      const region = scanRegionAfterEcho(post, input);
      expect(region).toBe(`\nA\nDONE`);
      expect(/DONE/.test(region!)).toBe(true);
    });
  });

  describe("continuation prompts on multiline input (Codex P2)", () => {
    it("locates input across a Bash PS2 ('> ') continuation prompt", () => {
      // The shell injected "> " before the continuation line, so the echo is
      // not the raw input verbatim; line-by-line indexOf skips the prefix.
      const post = `echo A\n> sleep 1; echo DONE\nA\nDONE`;
      const input = `echo A\nsleep 1; echo DONE`;
      expect(scanRegionAfterEcho(post, input)).toBe(`\nA\nDONE`);
    });

    it("locates input across a PowerShell ('>>') continuation prompt", () => {
      const post = `Get-Process |\n>> Select-Object Name\nRESULT`;
      const input = `Get-Process |\nSelect-Object Name`;
      expect(scanRegionAfterEcho(post, input)).toBe(`\nRESULT`);
    });

    it("still defers when a later continuation line has not rendered yet", () => {
      const post = `echo A\n> `; // first line echoed, continuation not yet
      const input = `echo A\nsleep 1; echo DONE`;
      expect(scanRegionAfterEcho(post, input)).toBeUndefined();
    });
  });

  describe("non-ASCII (CJK) input", () => {
    it("locates a CJK echo verbatim (clipboard send keeps it intact)", () => {
      const region = scanRegionAfterEcho(`echo "完了"\n完了`, `echo "完了"`);
      expect(region).toBe(`\n完了`);
    });
  });

  describe("needle normalisation (P2-2)", () => {
    it("strips trailing whitespace from the input before matching", () => {
      const post = `sleep 1; echo DONE\nDONE`;
      const input = `sleep 1; echo DONE   `; // trailing spaces
      expect(scanRegionAfterEcho(post, input)).toBe(`\nDONE`);
    });

    it("normalises CRLF in the input to match the LF post-baseline slice", () => {
      const post = `echo A\nsleep 1; echo DONE\nA\nDONE`;
      const input = `echo A\r\nsleep 1; echo DONE`; // CRLF
      expect(scanRegionAfterEcho(post, input)).toBe(`\nA\nDONE`);
    });

    it("preserves inner blank lines in the needle", () => {
      const post = `echo A\n\necho DONE\nA\n\nDONE`;
      const input = `echo A\n\necho DONE`; // inner blank line is significant
      expect(scanRegionAfterEcho(post, input)).toBe(`\nA\n\nDONE`);
    });
  });

  describe("empty / blank input has no echo to skip", () => {
    it("returns the full slice for empty input", () => {
      expect(scanRegionAfterEcho(`whatever output`, ``)).toBe(`whatever output`);
    });

    it("returns the full slice for whitespace-only input", () => {
      expect(scanRegionAfterEcho(`whatever output`, `   `)).toBe(`whatever output`);
    });
  });

  describe("isSecretInputPrompt vs isHiddenInputPrompt — bare '>' is Bash PS2 (Codex P2)", () => {
    it("treats credential prompts as secret (input not echoed)", () => {
      expect(isSecretInputPrompt("$ sudo apt update\n[sudo] password for alice:")).toBe(true);
      expect(isSecretInputPrompt("Enter passphrase:")).toBe(true);
      expect(isSecretInputPrompt("Password:")).toBe(true);
    });

    it("does NOT treat a bare '>' (Bash PS2 continuation) as secret", () => {
      // Codex P2: bypassing the echo anchor for a Bash PS2 baseline would
      // full-scan and re-introduce #383 — so the run echo-anchor must not treat
      // '>' as hidden input.
      expect(isSecretInputPrompt(">")).toBe(false);
      expect(isSecretInputPrompt("> ")).toBe(false);
    });

    it("does NOT treat normal prompts as secret (low false-positive)", () => {
      expect(isSecretInputPrompt("user@host:~/secret$ ")).toBe(false); // dir named 'secret'
      expect(isSecretInputPrompt("PS C:\\Users\\me>")).toBe(false);
    });

    it("isHiddenInputPrompt still matches '>' (unchanged — used by terminal_send)", () => {
      expect(isHiddenInputPrompt(">")).toBe(true);
      expect(isHiddenInputPrompt("Password:")).toBe(true);
    });
  });

  describe("hidden-input prompts (inputEchoes=false): bypass the anchor (Codex P1)", () => {
    it("scans the full slice when the input is not echoed (e.g. a password)", () => {
      // Password/secret sent to a prompt that suppresses echo: the input never
      // appears in the buffer, but the post-auth output does. The matcher must
      // see that output, not defer forever.
      const post = `Login succeeded\nDONE`;
      expect(scanRegionAfterEcho(post, `hunter2`, false)).toBe(post);
    });

    it("does NOT defer when the hidden input is absent (the regression Codex caught)", () => {
      // Same args: inputEchoes=false scans the full slice; the default (true)
      // would defer (undefined) and time out — the #383 fix's regression.
      expect(scanRegionAfterEcho(`some output`, `secretpw`, false)).toBe(`some output`);
      expect(scanRegionAfterEcho(`some output`, `secretpw`, true)).toBeUndefined();
    });
  });
});
