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
  resolveExitShell,
  stripExitArtifacts,
  terminalSchema,
  terminalRegistrationSchema,
  terminalRunHandler,
} from "../../src/tools/terminal.js";
import { failWith, getSuggestsForCode } from "../../src/tools/_errors.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// P2 handler wiring — pure decision helpers + schema + typed-code routing
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveExitShell — shell decision matrix (P2 wiring)", () => {
  it("explicit bash/powershell are used as-is (no detection needed)", () => {
    expect(resolveExitShell("bash", "WindowsTerminal")).toEqual({ ok: true, shell: "bash" });
    expect(resolveExitShell("powershell", null)).toEqual({ ok: true, shell: "powershell" });
  });

  it("explicit cmd → ExitModeShellUnsupported (cmd is deferred)", () => {
    expect(resolveExitShell("cmd", "cmd")).toEqual({
      ok: false,
      code: "ExitModeShellUnsupported",
      processName: "cmd",
    });
  });

  it("auto + high-confidence shell process → that shell", () => {
    expect(resolveExitShell("auto", "pwsh")).toEqual({ ok: true, shell: "powershell" });
    expect(resolveExitShell("auto", "powershell.exe")).toEqual({ ok: true, shell: "powershell" });
    expect(resolveExitShell("auto", "bash.exe")).toEqual({ ok: true, shell: "bash" });
    expect(resolveExitShell("auto", "wsl")).toEqual({ ok: true, shell: "bash" });
  });

  it("auto + cmd host → ExitModeShellUnsupported (detection vs support are separate)", () => {
    expect(resolveExitShell("auto", "cmd.exe")).toEqual({
      ok: false,
      code: "ExitModeShellUnsupported",
      processName: "cmd.exe",
    });
  });

  it("auto + low-confidence host → ExitModeShellAmbiguous (the SSH/WSL wall)", () => {
    for (const host of ["WindowsTerminal", "conhost", "OpenSSH", "ssh", "alacritty"]) {
      expect(resolveExitShell("auto", host)).toEqual({
        ok: false,
        code: "ExitModeShellAmbiguous",
        processName: host,
      });
    }
    // null/undefined process name (lookup failed) → ambiguous, processName:null.
    expect(resolveExitShell("auto", null)).toEqual({
      ok: false,
      code: "ExitModeShellAmbiguous",
      processName: null,
    });
    expect(resolveExitShell("auto", undefined)).toEqual({
      ok: false,
      code: "ExitModeShellAmbiguous",
      processName: null,
    });
  });
});

describe("stripExitArtifacts — cosmetic removal of injected epilogue + sentinel", () => {
  it("bash: drops the injected epilogue echo + sentinel lines, keeps echo + real output", () => {
    // REALISTIC order: input executes and prints BEFORE the epilogue echoes.
    // split("\n")[1] is the epilogue line (carries the split token "_EXIT_<nonce>").
    const epilogueEcho = buildExitCommand("ls -la", "bash", NONCE).split("\n")[1]!;
    const buffer = [
      "user@host:~$ ls -la", // command echo (kept — same as pattern/quiet modes)
      "file1.txt", // real output
      "file2.txt",
      `user@host:~$ ${epilogueEcho}`, // echoed epilogue (dropped — has _EXIT_<nonce>)
      `${TOKEN}|0|`, // sentinel output line (dropped — has _EXIT_<nonce>)
      "user@host:~$",
    ].join("\n");
    const out = stripExitArtifacts(buffer, NONCE);
    expect(out).toContain("file1.txt");
    expect(out).toContain("file2.txt");
    expect(out).toContain("user@host:~$ ls -la"); // command echo kept
    expect(out).not.toContain("_EXIT_"); // both injected lines gone
    expect(out).not.toContain("__DTMCP");
  });

  it("powershell: drops the prologue echo + epilogue echo + sentinel lines", () => {
    const [prologue, inputEcho, epilogueEcho] = buildExitCommand(
      "Get-ChildItem",
      "powershell",
      NONCE,
    ).split("\n");
    const buffer = [
      `PS C:\\> ${prologue}`, // prologue echo (dropped — $global:LASTEXITCODE = $null)
      `PS C:\\> ${inputEcho}`, // command echo (kept)
      "Mode  LastWriteTime  Name", // real output
      "----  -------------  ----",
      `PS C:\\> ${epilogueEcho}`, // epilogue echo (dropped — _EXIT_<nonce>)
      `${TOKEN}|0|True`, // sentinel (dropped)
      "PS C:\\>",
    ].join("\n");
    const out = stripExitArtifacts(buffer, NONCE);
    expect(out).toContain("Mode  LastWriteTime  Name");
    expect(out).toContain("----  -------------  ----");
    expect(out).not.toContain("LASTEXITCODE"); // prologue + epilogue gone
    expect(out).not.toContain("__DTMCP");
    expect(out).not.toContain("_EXIT_");
  });

  it("powershell: keeps real output that legitimately prints the prologue literal (Codex #389 P2)", () => {
    // Only the FIRST `$global:LASTEXITCODE = $null` (the injected prologue echo)
    // is dropped; a later user-output line repeating the literal is kept.
    const [prologue, inputEcho, epilogueEcho] = buildExitCommand(
      "Get-Content script.ps1",
      "powershell",
      NONCE,
    ).split("\n");
    const buffer = [
      `PS C:\\> ${prologue}`, // injected prologue echo (dropped — first match)
      `PS C:\\> ${inputEcho}`, // command echo (kept)
      "Write-Host 'resetting'", // real output line 1
      "$global:LASTEXITCODE = $null", // real output that PRINTS the literal (kept)
      `PS C:\\> ${epilogueEcho}`, // epilogue echo (dropped — _EXIT_<nonce>)
      `${TOKEN}|0|True`, // sentinel (dropped)
    ].join("\n");
    const out = stripExitArtifacts(buffer, NONCE);
    expect(out).toContain("Write-Host 'resetting'");
    // The user's printed literal survives (real output not corrupted).
    expect(out).toContain("$global:LASTEXITCODE = $null");
    expect(out).not.toContain("__DTMCP");
    expect(out).not.toContain("_EXIT_");
    // …but exactly one prologue line (the injected echo) was removed.
    expect(out.split("$global:LASTEXITCODE = $null").length - 1).toBe(1);
  });

  it("order-independent: works even if the sentinel renders right after the echo", () => {
    // A fast command with no output between echo and sentinel still strips clean.
    const epilogueEcho = buildExitCommand("true", "bash", NONCE).split("\n")[1]!;
    const buffer = ["$ true", `$ ${epilogueEcho}`, `${TOKEN}|0|`, "$"].join("\n");
    const out = stripExitArtifacts(buffer, NONCE);
    expect(out).not.toContain("__DTMCP");
    expect(out).not.toContain("_EXIT_");
    expect(out).toContain("$ true"); // command echo kept
  });

  it("a different-nonce sentinel from a prior run is left intact (per-invocation isolation)", () => {
    const buffer = `output line\n__DTMCP_EXIT_otherrun|0|`;
    // Our nonce's marker is absent → nothing dropped → returned as-is (trimmed).
    expect(stripExitArtifacts(buffer, NONCE)).toBe(buffer);
  });
});

describe("exit-mode typed codes route through classify() + SUGGESTS", () => {
  for (const code of [
    "ExitModeUnsafeInput",
    "ExitModeShellUnsupported",
    "ExitModeShellAmbiguous",
  ] as const) {
    it(`${code} classifies to its code and carries a non-empty suggest`, () => {
      const result = failWith(new Error(code), "terminal:run");
      const body = JSON.parse(result.content[0]!.text);
      expect(body.ok).toBe(false);
      expect(body.code).toBe(code);
      expect(Array.isArray(body.suggest)).toBe(true);
      expect(body.suggest.length).toBeGreaterThan(0);
      expect(getSuggestsForCode(code).length).toBeGreaterThan(0);
    });
  }

  it("a prose-suffixed message still routes (defensive substring match)", () => {
    const result = failWith(
      new Error("ExitModeUnsafeInput: unterminated_command_substitution"),
      "terminal:run",
    );
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe("ExitModeUnsafeInput");
  });
});

describe("exit mode rejects delivery-shaping sendOptions (Codex #389 P1)", () => {
  // These rejects happen in the exit pre-flight BEFORE findTerminalWindow, so the
  // handler returns without any terminal I/O — safe to assert in a unit test.
  for (const key of ["pressEnter", "preferClipboard", "method", "chunkSize", "pasteKey"] as const) {
    it(`rejects sendOptions.${key} with InvalidArgs (uniform, pre-routing)`, async () => {
      const result = await terminalRunHandler({
        windowTitle: "irrelevant",
        input: "echo hi",
        until: { mode: "exit", shell: "powershell" },
        timeoutMs: 10_000,
        sendOptions: { [key]: key === "method" ? "background" : key === "chunkSize" ? 50 : key === "pasteKey" ? "ctrl+v" : false },
      });
      const body = JSON.parse(result.content[0]!.text);
      expect(body.ok).toBe(false);
      expect(body.code).toBe("InvalidArgs");
      expect(body.error).toMatch(/controls command delivery/i);
      expect(body.context.offending).toContain(key);
    });
  }

  it("does NOT reject focus-management sendOptions (focusFirst) at the conflict gate", async () => {
    // focusFirst is allowed; the conflict gate passes, so we do NOT get the
    // delivery-conflict InvalidArgs. (It proceeds to window lookup afterwards.)
    const result = await terminalRunHandler({
      windowTitle: "__no_such_window_for_386_unit__",
      input: "echo hi",
      until: { mode: "exit", shell: "powershell" },
      timeoutMs: 10_000,
      sendOptions: { focusFirst: false },
    });
    const body = JSON.parse(result.content[0]!.text);
    // Not the delivery-conflict reject. (Window lookup then fails → window_not_found.)
    const isConflictReject =
      body.code === "InvalidArgs" && /controls command delivery/i.test(body.error ?? "");
    expect(isConflictReject).toBe(false);
  });
});

describe("until:{mode:'exit'} schema variant (P2 public surface)", () => {
  it("accepts exit mode with an explicit shell", () => {
    const r = terminalSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "ls",
      until: { mode: "exit", shell: "bash" },
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    if (r.success && r.data.action === "run") {
      expect(r.data.until).toEqual({ mode: "exit", shell: "bash" });
    }
  });

  it("defaults shell to 'auto' when omitted", () => {
    const r = terminalSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "ls",
      until: { mode: "exit" },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "run") {
      expect(r.data.until).toEqual({ mode: "exit", shell: "auto" });
    }
  });

  it("rejects an unknown shell value", () => {
    const r = terminalSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "ls",
      until: { mode: "exit", shell: "fish" },
    });
    expect(r.success).toBe(false);
  });

  it("registration schema (post include-injection wrap) also accepts exit mode", () => {
    const r = terminalRegistrationSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "ls",
      until: { mode: "exit", shell: "powershell" },
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("existing quiet / pattern variants still parse (no regression)", () => {
    expect(
      terminalSchema.safeParse({
        action: "run",
        windowTitle: "pwsh",
        input: "ls",
        until: { mode: "quiet", quietMs: 1500 },
      }).success,
    ).toBe(true);
    expect(
      terminalSchema.safeParse({
        action: "run",
        windowTitle: "pwsh",
        input: "npm test",
        until: { mode: "pattern", pattern: "Test Files" },
      }).success,
    ).toBe(true);
  });
});
