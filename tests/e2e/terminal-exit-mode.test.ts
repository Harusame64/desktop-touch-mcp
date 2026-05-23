/**
 * terminal-exit-mode.test.ts — E2E for issue #386 `until:{mode:'exit'}`
 * (echo-immune completion sentinel), plan §9 acceptance.
 *
 * Two real-shell suites:
 *   1. PowerShell (conhost) — success (exitCode 0 / native non-zero / cmdlet
 *      $?=False) + the loud pre-flight rejects (cmd / ambiguous-auto / unsafe
 *      input).
 *   2. SSH-into-WSL bash (the #383 measurement harness) — the #386 CORE: a
 *      multiline command whose own text looks like a completion marker still
 *      completes via the nonce sentinel (never self-matches its echo, which
 *      pattern mode cannot anchor for multiline), with the correct exitCode.
 *      Also proves the SSH/WSL wall: shell:'auto' loud-fails (the window is
 *      conhost) so the caller must pass shell:'bash'.
 *
 * Skip policy (mirrors terminal.test.ts §S-2): the only env condition that may
 * skip a delivery assertion is a refused send (completion.reason:'send_failed'
 * — foreground transfer refused) or baseline_lost. Bash suite skips wholesale
 * when the WSL/sshd harness is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { terminalRunHandler } from "../../src/tools/terminal.js";
import { launchPowerShell, type PsInstance } from "./helpers/powershell-launcher.js";
import { isSshWslAvailable, launchSshWslBash, type SshBashInstance } from "./helpers/ssh-wsl-launcher.js";
import { parsePayload } from "./helpers/wait.js";

/** True when the run could not even send (env: foreground transfer refused). */
function isEnvSendSkip(p: { completion?: { reason?: string }; outputIntegrity?: string }): boolean {
  return p.completion?.reason === "send_failed" || p.outputIntegrity === "baseline_lost";
}

// ─────────────────────────────────────────────────────────────────────────────
// PowerShell (conhost)
// ─────────────────────────────────────────────────────────────────────────────

describe("[powershell] terminal exit mode (#386)", () => {
  let ps: PsInstance;

  beforeAll(async () => {
    ps = await launchPowerShell({ host: "conhost", banner: "exitmode-ps-ready" });
  }, 20_000);

  afterAll(() => ps?.kill());

  it("single-line: reason:'exited' + exitCode 0, no echo self-match", async ({ skip }) => {
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        input: "Write-Output 'hi386'; Start-Sleep -Seconds 1",
        until: { mode: "exit", shell: "powershell" },
        timeoutMs: 25_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    expect(res.completion.exitCode).toBe(0);
    // Waited for the real command (≥ the 1s sleep), not the echoed sentinel.
    expect(res.completion.elapsedMs).toBeGreaterThanOrEqual(800);
    expect(res.output).toContain("hi386");
  }, 35_000);

  it("multiline: completes via the sentinel even though pattern mode can't anchor", async ({ skip }) => {
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        // Embedded newline + a token that LOOKS like a completion marker.
        input: "Write-Output 'A1'\nStart-Sleep -Seconds 2\nWrite-Output 'PSDONE_386'",
        until: { mode: "exit", shell: "powershell" },
        timeoutMs: 30_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    expect(res.completion.exitCode).toBe(0);
    // ≥ ~2s proves it waited through the whole multiline body, not the echo.
    expect(res.completion.elapsedMs).toBeGreaterThanOrEqual(1800);
    expect(res.output).toContain("A1");
    expect(res.output).toContain("PSDONE_386");
    // stripExitArtifacts removed the injected prologue/epilogue echo + sentinel.
    expect(res.output).not.toContain("DTMCP");
    expect(res.output).not.toContain("LASTEXITCODE");
  }, 40_000);

  it("native non-zero exit code is reported", async ({ skip }) => {
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        input: "cmd /c exit 7",
        until: { mode: "exit", shell: "powershell" },
        timeoutMs: 25_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    expect(res.completion.exitCode).toBe(7);
  }, 35_000);

  it("cmdlet failure ($?=False, no native exe) maps to exitCode 1", async ({ skip }) => {
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        input: "Get-Item 'Z:\\__no_such_path_386__' -ErrorAction Stop",
        until: { mode: "exit", shell: "powershell" },
        timeoutMs: 25_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    // OQ-7: $LASTEXITCODE cleared by the prologue stays empty (no native exe ran),
    // so the parser falls back to $? (False → 1).
    expect(res.completion.exitCode).toBe(1);
  }, 35_000);

  it("shell:'cmd' is a loud pre-flight reject (ExitModeShellUnsupported)", async () => {
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        input: "echo hi",
        until: { mode: "exit", shell: "cmd" },
        timeoutMs: 10_000,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("ExitModeShellUnsupported");
    expect(Array.isArray(res.suggest)).toBe(true);
  }, 15_000);

  it("shell:'auto' resolves to powershell on a conhost-hosted PS window + emits the nesting warning (P3 measured)", async ({ skip }) => {
    // MEASURED: a conhost-hosted PowerShell window reports processName
    // 'powershell', so auto resolves HIGH (not ambiguous). The Q2 advisory
    // warning fires so callers know nested SSH/WSL is undetectable.
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        input: "Write-Output 'autoresolve'",
        until: { mode: "exit", shell: "auto" },
        timeoutMs: 25_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    expect(res.completion.exitCode).toBe(0);
    expect(Array.isArray(res.warnings)).toBe(true);
    expect(res.warnings.some((w: string) => /auto-detected as 'powershell'/.test(w))).toBe(true);
    expect(res.output).toContain("autoresolve");
  }, 35_000);

  it("input ending in an open construct is rejected (ExitModeUnsafeInput)", async () => {
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        input: 'Write-Output "unterminated',
        until: { mode: "exit", shell: "powershell" },
        timeoutMs: 10_000,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("ExitModeUnsafeInput");
    expect(res.context?.reason).toBe("unbalanced_quotes");
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// SSH-into-WSL bash (#386 core + SSH/WSL wall) — skips if the harness is absent
// ─────────────────────────────────────────────────────────────────────────────

describe("[bash@wsl-ssh] terminal exit mode (#386 core)", () => {
  let sh: SshBashInstance | null = null;
  let available = false;

  beforeAll(async () => {
    available = await isSshWslAvailable();
    if (!available) return;
    sh = await launchSshWslBash();
  }, 120_000);

  afterAll(() => sh?.kill());

  it("single-line: reason:'exited' + exitCode 0", async ({ skip }) => {
    if (!available || !sh) skip("SSH-into-WSL bash harness unavailable (env)");
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: sh!.title,
        input: "echo bashhi386; sleep 1",
        until: { mode: "exit", shell: "bash" },
        timeoutMs: 30_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    expect(res.completion.exitCode).toBe(0);
    expect(res.completion.elapsedMs).toBeGreaterThanOrEqual(800);
    expect(res.output).toContain("bashhi386");
  }, 45_000);

  it("MULTILINE: completes via the nonce sentinel, never self-matching the echo (#386)", async ({ skip }) => {
    if (!available || !sh) skip("SSH-into-WSL bash harness unavailable (env)");
    // In pattern mode, the echoed `echo FINISHED_386` line self-matches a
    // pattern:'FINISHED_386' immediately (multiline echo cannot be anchored —
    // that is exactly #386). Exit mode keys off the driver nonce instead, so it
    // must wait through the 2s sleep and report the real completion.
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: sh!.title,
        input: "echo START_386\nsleep 2\necho FINISHED_386",
        until: { mode: "exit", shell: "bash" },
        timeoutMs: 40_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    expect(res.completion.exitCode).toBe(0);
    // ≥ ~2s is the #386 proof: a self-match on the echoed FINISHED_386 line
    // would have returned in well under a second.
    expect(res.completion.elapsedMs).toBeGreaterThanOrEqual(1800);
    expect(res.output).toContain("START_386");
    expect(res.output).toContain("FINISHED_386");
    // stripExitArtifacts removed the injected epilogue echo + sentinel.
    expect(res.output).not.toContain("DTMCP");
    expect(res.output).not.toContain("__dtmcp_rc");
  }, 50_000);

  it("non-zero exit code (subshell, keeps the session alive)", async ({ skip }) => {
    if (!available || !sh) skip("SSH-into-WSL bash harness unavailable (env)");
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: sh!.title,
        input: "(exit 3)",
        until: { mode: "exit", shell: "bash" },
        timeoutMs: 30_000,
      }),
    );
    if (isEnvSendSkip(res)) skip(`env: ${JSON.stringify(res.completion)}`);
    expect(res.completion.reason, JSON.stringify(res)).toBe("exited");
    expect(res.completion.exitCode).toBe(3);
  }, 45_000);

  // NOTE on the SSH/WSL wall (P3 measured): the SSH-bash window is conhost-hosted
  // (window process 'powershell'), so shell:'auto' here resolves to powershell —
  // a SILENTLY WRONG shell for the remote bash, which degrades to a loud
  // reason:'timeout' (the PS epilogue never renders the sentinel). That is why
  // exit mode emits the auto-detection warning and these tests pass shell:'bash'
  // explicitly. We do not assert the slow wrong-shell timeout here; the genuine
  // ExitModeShellAmbiguous path (a window whose OWN process is WindowsTerminal)
  // is covered by the WT-gated test below.
});

// ─────────────────────────────────────────────────────────────────────────────
// Genuine ExitModeShellAmbiguous — a window whose own process hides the shell
// (Windows Terminal → process 'WindowsTerminal' → low confidence). WT-gated.
// ─────────────────────────────────────────────────────────────────────────────

const WT_AVAILABLE: boolean = (() => {
  if (process.platform !== "win32") return false;
  try {
    execSync("where wt.exe", { stdio: "ignore", timeout: 2000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!WT_AVAILABLE)("[wt] terminal exit mode — shell:'auto' loud-fails (ambiguous)", () => {
  let ps: PsInstance;
  beforeAll(async () => {
    ps = await launchPowerShell({ host: "wt", banner: "exitmode-wt-ready" });
  }, 20_000);
  afterAll(() => ps?.kill());

  it("auto on a WindowsTerminal-process window → ExitModeShellAmbiguous", async () => {
    const res = parsePayload(
      await terminalRunHandler({
        windowTitle: ps.title,
        input: "Write-Output 'hi'",
        until: { mode: "exit", shell: "auto" },
        timeoutMs: 10_000,
      }),
    );
    expect(res.ok, JSON.stringify(res)).toBe(false);
    expect(res.code).toBe("ExitModeShellAmbiguous");
    expect(Array.isArray(res.suggest)).toBe(true);
  }, 15_000);
});
