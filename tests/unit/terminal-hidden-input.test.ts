/**
 * terminal-hidden-input.test.ts — Unit tests for issue #183 hidden-input
 * prompt detection in `terminal({action:'send'})` BG path.
 *
 * Exercises `isHiddenInputPrompt(baselineRaw)` directly without spawning a
 * real terminal. The companion E2E (`tests/e2e/terminal-hidden-input.test.ts`)
 * pins the end-to-end behaviour against an actual PowerShell `Read-Host`
 * prompt.
 *
 * Strict-regex policy (matrix doc §3.1 row terminal action:send BG, issue body):
 *  - regex set is intentionally narrow at v1; expand only when a real
 *    false-negative is observed.
 *  - every pattern requires either an end-of-line anchor or a distinctive
 *    literal phrase, so passing references in command output should NOT
 *    trip detection.
 */

import { describe, it, expect } from "vitest";
import { isHiddenInputPrompt } from "../../src/tools/terminal.js";

describe("isHiddenInputPrompt — positive cases (expected detection)", () => {
  it("PowerShell `Read-Host -AsSecureString` prompt with `Password:` ending", () => {
    const baseline =
      "PS C:\\Users\\test> $pw = Read-Host -Prompt 'Password' -AsSecureString\n" +
      "Password: ";
    expect(isHiddenInputPrompt(baseline)).toBe(true);
  });

  it("plain `password:` (lowercase) at end of last line", () => {
    expect(isHiddenInputPrompt("Enter password:")).toBe(true);
  });

  it("`passphrase:` ssh-style prompt", () => {
    expect(isHiddenInputPrompt("Enter passphrase: ")).toBe(true);
  });

  it("`secret:` prompt", () => {
    expect(isHiddenInputPrompt("Type your secret:")).toBe(true);
  });

  it("`sudo` keyword on its own line (e.g. `[sudo]`)", () => {
    // The regex matches `(password|passphrase|secret|sudo)[\s:]*$` — `[sudo]`
    // does NOT end with the keyword (the literal `]` is past `sudo`), so
    // exact-keyword-only ending is what we test here.
    expect(isHiddenInputPrompt("Enter sudo:")).toBe(true);
  });

  it("`Password for jdoe:` sudo Linux phrasing (regex #2)", () => {
    expect(isHiddenInputPrompt("Password for jdoe:")).toBe(true);
  });

  it("PowerShell `Read-Host` `>` continuation prompt (regex #3)", () => {
    expect(isHiddenInputPrompt("PS C:\\Users\\test> Read-Host\n>")).toBe(true);
  });

  it("works through trailing blank lines (Windows Terminal padding)", () => {
    // Real UIA TextPattern often returns trailing rows of empty whitespace.
    // The detector must walk back to the last non-empty line.
    const baseline = "Enter password:\n   \n   \n";
    expect(isHiddenInputPrompt(baseline)).toBe(true);
  });

  it("strips ANSI before checking", () => {
    // CSI red, "Password:", CSI reset
    const baseline = "[31mPassword:[0m";
    expect(isHiddenInputPrompt(baseline)).toBe(true);
  });

  it("CRLF line separators normalise correctly", () => {
    expect(isHiddenInputPrompt("PS> echo hi\r\nhi\r\nPassword:")).toBe(true);
  });
});

describe("isHiddenInputPrompt — negative cases (regression guards)", () => {
  it("returns false for null", () => {
    expect(isHiddenInputPrompt(null)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isHiddenInputPrompt("")).toBe(false);
  });

  it("returns false for plain PowerShell prompt `PS C:\\>`", () => {
    expect(isHiddenInputPrompt("PS C:\\Users\\test> ")).toBe(false);
  });

  it("does NOT match `password` mentioned mid-line in scrollback", () => {
    // The keyword is NOT at end of line — anchor `$` should reject.
    const baseline =
      "PS C:\\> Get-Help about_password\n" +
      "  password is a credential...\n" +
      "PS C:\\> ";
    expect(isHiddenInputPrompt(baseline)).toBe(false);
  });

  it("does NOT match a `>` that is part of a normal PS prompt", () => {
    // `PS C:\Users\test>` ends with `>` but the line has more than just `>`.
    // Regex #3 requires `^>\s*$` (line is exactly `>` plus optional whitespace).
    expect(isHiddenInputPrompt("PS C:\\Users\\test>")).toBe(false);
    expect(isHiddenInputPrompt("PS C:\\Users\\test> ")).toBe(false);
  });

  it("does NOT match output that happens to contain `password` followed by other text", () => {
    expect(isHiddenInputPrompt("password is required for login")).toBe(false);
  });

  it("returns false for whitespace-only baseline", () => {
    expect(isHiddenInputPrompt("   \n   \n")).toBe(false);
  });

  it("does NOT match command-line snippet `--password=secret123`", () => {
    // Contains `password` but anchor and prefix mismatch — last line ends
    // with `secret123`, not the keyword.
    expect(isHiddenInputPrompt("$ run --password=secret123")).toBe(false);
  });

  it("ignores lines with `>` if other content follows on the same row", () => {
    expect(isHiddenInputPrompt("> echo hi")).toBe(false);
  });
});
