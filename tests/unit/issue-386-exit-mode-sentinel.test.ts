/**
 * issue-386-exit-mode-sentinel.test.ts
 *
 * Unit tests for the echo-immune completion sentinel helpers (issue #386,
 * Phase 1 — pure helpers, not yet wired into the run handler).
 *
 * #383 anchored single-line `until:{mode:'pattern'}` past the echoed command,
 * but multiline echo boundaries are undeterminable from the buffer alone (#386).
 * The structural fix (until:{mode:'exit'}) stops locating the echo and instead
 * matches a DRIVER-controlled token whose ECHO form differs from its OUTPUT form
 * — echo-immune by construction for single-line AND multiline.
 *
 * The key invariant pinned here: the string we SEND (= what gets echoed) never
 * contains the contiguous `<token>|<exitcode>` that parseExitSentinel matches;
 * only the command's runtime OUTPUT assembles it.
 */

import { describe, it, expect } from "vitest";
import {
  buildExitCommand,
  parseExitSentinel,
  detectShell,
  isUnsafeForExitMode,
  generateExitNonce,
} from "../../src/tools/terminal.js";

const NONCE = "deadbeefcafe0123"; // fixed for deterministic assertions
const TOKEN = `__DTMCP_EXIT_${NONCE}`;

describe("buildExitCommand — echo-immunity (the #386 core invariant)", () => {
  it("bash: the SENT/echoed command never contains the contiguous token", () => {
    const cmd = buildExitCommand("ls -la", "bash", NONCE);
    // Split parts ARE present (so the runtime output can assemble the token)…
    expect(cmd).toContain("'__DTMCP'");
    expect(cmd).toContain(`"_EXIT_${NONCE}"`);
    // …but the contiguous token is NOT, so parseExitSentinel can't self-match it.
    expect(cmd).not.toContain(TOKEN);
    expect(parseExitSentinel(cmd, NONCE, "bash").matched).toBe(false);
  });

  it("powershell: the SENT/echoed command never contains the contiguous token", () => {
    const cmd = buildExitCommand("Get-ChildItem", "powershell", NONCE);
    expect(cmd).toContain("'__DTMCP'");
    expect(cmd).toContain(`"_EXIT_${NONCE}"`);
    expect(cmd).not.toContain(TOKEN);
    expect(parseExitSentinel(cmd, NONCE, "powershell").matched).toBe(false);
  });

  it("bash: embeds the user input and captures $? before printing", () => {
    const cmd = buildExitCommand("make build", "bash", NONCE);
    expect(cmd).toContain("make build");
    expect(cmd).toContain("__dtmcp_rc=$?");
    // printf gets three args matching '%s%s|%d|': '__DTMCP', "_EXIT_…", "$rc".
    // The trailing `|` terminates the code field (Codex P2).
    expect(cmd).toContain("printf '%s%s|%d|\\n' '__DTMCP'");
  });

  it("powershell: prologue clears stale $LASTEXITCODE, emits code AND $?", () => {
    const cmd = buildExitCommand("Get-Item x", "powershell", NONCE);
    expect(cmd).toContain("$global:LASTEXITCODE = $null");
    expect(cmd).toContain("Get-Item x");
    expect(cmd).toContain("$dtmcp_ok=$?");
    expect(cmd).toContain("$dtmcp_c=$LASTEXITCODE");
  });

  it("multiline input: still echo-immune (the whole point of #386)", () => {
    const multiline = `echo A\nsleep 1\necho ${TOKEN}`; // sentinel even appears literally!
    const cmd = buildExitCommand(multiline, "bash", NONCE);
    // The user literally typed the token, so the echo DOES contain it once —
    // but parseExitSentinel matches `<token>|<digits>`, which the echo lacks.
    expect(parseExitSentinel(cmd, NONCE, "bash").matched).toBe(false);
  });
});

describe("parseExitSentinel — defer until the full sentinel line renders", () => {
  it("bash: defers on the bare token (exit-code field not yet rendered)", () => {
    expect(parseExitSentinel(`output\n${TOKEN}`, NONCE, "bash").matched).toBe(false);
    expect(parseExitSentinel(`output\n${TOKEN}|`, NONCE, "bash").matched).toBe(false);
  });

  it("bash: matches and parses the exit code once the line completes", () => {
    expect(parseExitSentinel(`file1\nfile2\n${TOKEN}|0|`, NONCE, "bash")).toEqual({
      matched: true,
      exitCode: 0,
    });
    expect(parseExitSentinel(`oops\n${TOKEN}|3|`, NONCE, "bash")).toEqual({
      matched: true,
      exitCode: 3,
    });
  });

  it("bash: requires the trailing `|` so a multi-digit code can't match early (Codex P2)", () => {
    // `127` mid-render as `1` (no closing `|` yet) must NOT match.
    expect(parseExitSentinel(`${TOKEN}|1`, NONCE, "bash").matched).toBe(false);
    expect(parseExitSentinel(`${TOKEN}|12`, NONCE, "bash").matched).toBe(false);
    // Fully rendered → the full code, not a prefix.
    expect(parseExitSentinel(`${TOKEN}|127|`, NONCE, "bash")).toEqual({
      matched: true,
      exitCode: 127,
    });
  });

  it("powershell: native exe code wins when present", () => {
    expect(parseExitSentinel(`${TOKEN}|0|True`, NONCE, "powershell")).toEqual({
      matched: true,
      exitCode: 0,
    });
    expect(parseExitSentinel(`${TOKEN}|7|False`, NONCE, "powershell")).toEqual({
      matched: true,
      exitCode: 7,
    });
  });

  it("powershell: cmdlet-only (empty code) maps $? True→0 / False→1 (OQ-7)", () => {
    expect(parseExitSentinel(`${TOKEN}||True`, NONCE, "powershell")).toEqual({
      matched: true,
      exitCode: 0,
    });
    expect(parseExitSentinel(`${TOKEN}||False`, NONCE, "powershell")).toEqual({
      matched: true,
      exitCode: 1,
    });
  });

  it("powershell: parses a negative Int32 exit code (Codex round 3)", () => {
    // Windows status codes use the high bit, e.g. -1073741819 (0xC0000005).
    expect(parseExitSentinel(`${TOKEN}|-1073741819|False`, NONCE, "powershell")).toEqual({
      matched: true,
      exitCode: -1073741819,
    });
    expect(parseExitSentinel(`${TOKEN}|-1|False`, NONCE, "powershell")).toEqual({
      matched: true,
      exitCode: -1,
    });
  });

  it("powershell: defers until BOTH fields render", () => {
    expect(parseExitSentinel(`${TOKEN}|0`, NONCE, "powershell").matched).toBe(false);
    expect(parseExitSentinel(`${TOKEN}`, NONCE, "powershell").matched).toBe(false);
  });

  it("does not match a different nonce (per-invocation isolation)", () => {
    const buffer = `__DTMCP_EXIT_other|0`;
    expect(parseExitSentinel(buffer, NONCE, "bash").matched).toBe(false);
  });
});

describe("buildExitCommand → parseExitSentinel round-trip (simulated buffer)", () => {
  it("bash: echo alone defers; appending the output line matches", () => {
    const cmd = buildExitCommand("make", "bash", NONCE);
    expect(parseExitSentinel(cmd, NONCE, "bash").matched).toBe(false);
    const buffer = `${cmd}\nbuilding...\n${TOKEN}|0|`; // runtime output appended
    expect(parseExitSentinel(buffer, NONCE, "bash")).toEqual({ matched: true, exitCode: 0 });
  });

  it("powershell: echo alone defers; appending the output line matches", () => {
    const cmd = buildExitCommand("Build-It", "powershell", NONCE);
    expect(parseExitSentinel(cmd, NONCE, "powershell").matched).toBe(false);
    const buffer = `${cmd}\n${TOKEN}||True`;
    expect(parseExitSentinel(buffer, NONCE, "powershell")).toEqual({ matched: true, exitCode: 0 });
  });
});

describe("detectShell — process name → shell + confidence", () => {
  it("high confidence for direct shell processes (case/.exe insensitive)", () => {
    expect(detectShell("pwsh")).toEqual({ shell: "powershell", confidence: "high" });
    expect(detectShell("powershell.exe")).toEqual({ shell: "powershell", confidence: "high" });
    expect(detectShell("PowerShell")).toEqual({ shell: "powershell", confidence: "high" });
    expect(detectShell("bash")).toEqual({ shell: "bash", confidence: "high" });
    expect(detectShell("wsl.exe")).toEqual({ shell: "bash", confidence: "high" });
    expect(detectShell("cmd")).toEqual({ shell: "cmd", confidence: "high" });
  });

  it("low confidence for hosts that hide the real shell (the SSH/WSL wall)", () => {
    for (const host of ["WindowsTerminal", "conhost", "conhost.exe", "OpenSSH", "ssh", "alacritty", "", null, undefined]) {
      expect(detectShell(host as string)).toEqual({ shell: "unknown", confidence: "low" });
    }
  });
});

describe("isUnsafeForExitMode — reject input an epilogue can't safely follow", () => {
  it("accepts safe single-line and multiline input", () => {
    expect(isUnsafeForExitMode("echo hi")).toBeNull();
    expect(isUnsafeForExitMode("echo a\necho b\nls")).toBeNull();
    expect(isUnsafeForExitMode(`echo "it's fine"`)).toBeNull(); // apostrophe in "…"
    expect(isUnsafeForExitMode("grep foo <<< word")).toBeNull(); // here-STRING is safe
    expect(isUnsafeForExitMode("echo 'a' 'b'")).toBeNull(); // balanced singles
  });

  it("rejects trailing line continuation (bash `\\` AND PowerShell backtick, Codex P1)", () => {
    expect(isUnsafeForExitMode("echo a \\")).toBe("trailing_line_continuation");
    expect(isUnsafeForExitMode("Get-Item x `")).toBe("trailing_line_continuation");
    expect(isUnsafeForExitMode("Get-ChildItem `\n  -Path .")).toBeNull(); // backtick mid-input is fine
  });

  it("rejects bash here-docs (but not here-strings)", () => {
    expect(isUnsafeForExitMode("cat <<EOF\nx\nEOF")).toBe("heredoc");
    expect(isUnsafeForExitMode("cat <<-EOF")).toBe("heredoc");
    expect(isUnsafeForExitMode("cat <<'END'")).toBe("heredoc");
    expect(isUnsafeForExitMode("grep foo <<< word")).toBeNull(); // here-STRING safe
    expect(isUnsafeForExitMode("a <<< b <<< c")).toBeNull(); // multiple here-strings
  });

  it("rejects here-docs with non-letter delimiters (Codex round 2 P1)", () => {
    expect(isUnsafeForExitMode("cat <<1\nx\n1")).toBe("heredoc");
    expect(isUnsafeForExitMode("cat <<-9")).toBe("heredoc");
    expect(isUnsafeForExitMode("cat <<\\EOF")).toBe("heredoc");
    expect(isUnsafeForExitMode("cat << EOF")).toBe("heredoc"); // space before delimiter
  });

  it("rejects unterminated command substitution $(...) (Codex round 2 P1)", () => {
    expect(isUnsafeForExitMode("echo $(uname")).toBe("unterminated_command_substitution");
    expect(isUnsafeForExitMode("echo $(date) $(uname")).toBe("unterminated_command_substitution");
    expect(isUnsafeForExitMode('echo "$(date"')).toBe("unterminated_command_substitution");
    // Balanced / literal forms stay safe.
    expect(isUnsafeForExitMode("echo $(uname)")).toBeNull();
    expect(isUnsafeForExitMode('echo "$(date)"')).toBeNull();
    expect(isUnsafeForExitMode("echo '$(literal'")).toBeNull(); // $( inside '…' is literal
  });

  it("honours quote nesting: `)` inside a string doesn't close $(...) (Codex round 3)", () => {
    // The `)` lives only inside "…", so the $( is still open → unterminated.
    expect(isUnsafeForExitMode('echo $(")"')).toBe("unterminated_command_substitution");
    // …but with the real closing `)` after the string, it's balanced.
    expect(isUnsafeForExitMode('echo $(echo ")")')).toBeNull();
    // A substitution nested inside a string is fine.
    expect(isUnsafeForExitMode('echo "outer $(inner) tail"')).toBeNull();
  });

  it("rejects PowerShell here-strings", () => {
    expect(isUnsafeForExitMode('$x = @"\ntext\n"@')).toBe("powershell_herestring");
    expect(isUnsafeForExitMode("$x = @'\ntext\n'@")).toBe("powershell_herestring");
  });

  it("rejects unbalanced quotes", () => {
    expect(isUnsafeForExitMode('echo "open')).toBe("unbalanced_quotes");
    expect(isUnsafeForExitMode("echo 'open")).toBe("unbalanced_quotes");
  });
});

describe("generateExitNonce", () => {
  it("returns 24 lowercase hex chars and is unique per call", () => {
    const a = generateExitNonce();
    const b = generateExitNonce();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(b).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
  });
});
