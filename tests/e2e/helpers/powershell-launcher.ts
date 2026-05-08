/**
 * powershell-launcher.ts — spawn a PowerShell window with a deterministic title tag.
 *
 * Uses `$Host.UI.RawUI.WindowTitle = '<tag>'` so the window is findable via
 * enumWindowsInZOrder without depending on exe basename or locale.
 *
 * `banner` is echoed after setting the title so terminal_read tests have
 * something to assert on.
 *
 * Kill strategy: the PowerShell script writes its own $PID to a temp file.
 * kill() reads that PID and kills by process ID — avoids matching
 * WindowsTerminal.exe via WINDOWTITLE on Windows 11 (which would close all tabs).
 *
 * Issue #173 host selection: `cmd /c start` honours the user's "default
 * terminal app" setting. On Windows 11 that flips between conhost.exe and
 * WindowsTerminal.exe, which silently changes the window class under test
 * (ConsoleWindowClass vs CASCADIA_HOSTING_WINDOW_CLASS). Pass `host` to pin
 * the test to one explicit host so coverage is deterministic across machines.
 */

import { spawn, type ChildProcess } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enumWindowsInZOrder, clearWindowTopmost } from "../../../src/engine/win32.js";
import { sleep } from "./wait.js";

export type TerminalHost = "default" | "conhost" | "wt";

export interface PsInstance {
  proc: ChildProcess;
  tag: string;
  title: string;
  hwnd: bigint;
  host: TerminalHost;
  kill(): void;
}

function findByTag(tag: string): { hwnd: bigint; title: string } | null {
  for (const w of enumWindowsInZOrder()) {
    if (w.title.includes(tag)) return { hwnd: w.hwnd, title: w.title };
  }
  return null;
}

export async function launchPowerShell(opts?: {
  banner?: string;
  exe?: string;
  /**
   * Which console host to launch the PowerShell process under.
   *  - "default": follow the user's "default terminal app" setting (legacy
   *    behaviour, non-deterministic on Windows 11).
   *  - "conhost": force conhost.exe — `ConsoleWindowClass`, WM_CHAR friendly.
   *  - "wt": force Windows Terminal — `CASCADIA_HOSTING_WINDOW_CLASS`,
   *    WM_CHAR is silently swallowed by the WinUI/XAML pipeline (issue #173).
   */
  host?: TerminalHost;
}): Promise<PsInstance> {
  const tag = `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const banner = opts?.banner ?? "";
  const exe = opts?.exe ?? "powershell.exe";
  const host: TerminalHost = opts?.host ?? "default";

  // Temp file the PS script writes its own PID into — lets kill() target the
  // exact PowerShell process rather than using WINDOWTITLE (which on Windows
  // Terminal matches WindowsTerminal.exe and would close all tabs with /T).
  const pidFile = join(tmpdir(), `${tag}-pid.txt`);
  // Escape path for PowerShell single-quoted string
  const psafePidFile = pidFile.replace(/'/g, "''");

  // Set title first, write PID, then echo banner. -NoExit keeps the window alive.
  // The script is encoded as UTF-16LE Base64 and passed via PowerShell's
  // -EncodedCommand. This sidesteps cmd-level / shell-level quoting entirely
  // (no `"`, `\`, or `;` in the command line that cmd has to interpret) and
  // also clears CodeQL #117 "Incomplete string escaping or encoding" on the
  // legacy `replace(/"/g, '\\"')` path — a Base64 alphabet has no characters
  // that need escaping in a Windows command line. -File was tried first but
  // conhost.exe -hosted powershell did not pick the script up reliably.
  const psScript = [
    `$Host.UI.RawUI.WindowTitle = '${tag}'`,
    `[string]$PID | Set-Content -Path '${psafePidFile}'`,
    banner ? `Write-Host '${banner.replace(/'/g, "''")}'` : "",
  ].filter(Boolean).join("; ");
  const encodedScript = Buffer.from(psScript, "utf16le").toString("base64");

  // Build the launch command depending on the requested host. We always
  // prepend `start ""` so the child runs detached in its own process group
  // with a fresh console window — without it, conhost.exe / wt.exe would
  // either inherit the parent's (ignored) stdio or attempt to attach to a
  // non-existent console and exit immediately.
  //
  //   - "default": start "" powershell.exe ... — Windows decides which
  //     terminal app hosts it (DefTerm setting on Win11).
  //   - "conhost": start "" conhost.exe powershell.exe ... — explicitly
  //     spawning conhost.exe pins ConsoleWindowClass and bypasses DefTerm.
  //   - "wt": start "" wt.exe new-tab -- powershell.exe ... — pins
  //     CASCADIA_HOSTING_WINDOW_CLASS via Windows Terminal. The `--`
  //     separator isolates wt's argument parser from the powershell args.
  //
  // IMPORTANT: `start` treats the first quoted arg as the window title. An
  // unquoted tag would be parsed as the program name, and on JP locale the
  // shell renders "<tag> が見つかりません" in the opened window. Always quote.
  // shell:true so cmd parses the quoted title correctly.
  const psArgs = `-NoExit -NoProfile -EncodedCommand ${encodedScript}`;
  let startCmd: string;
  if (host === "conhost") {
    startCmd = `start "" conhost.exe "${exe}" ${psArgs}`;
  } else if (host === "wt") {
    startCmd = `start "" wt.exe new-tab -- "${exe}" ${psArgs}`;
  } else {
    startCmd = `start "" "${exe}" ${psArgs}`;
  }
  const proc = spawn(startCmd, {
    detached: true, stdio: "ignore", windowsHide: false, shell: true,
  });
  proc.unref(); // don't block vitest exit

  const deadline = Date.now() + 10_000;
  let found: { hwnd: bigint; title: string } | null = null;
  while (Date.now() < deadline) {
    found = findByTag(tag);
    if (found) break;
    await sleep(200);
  }
  if (!found) {
    try { proc.kill(); } catch { /* ignore */ }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    throw new Error(`PowerShell window with tag "${tag}" did not appear within 10s`);
  }

  // Give PowerShell a moment to actually print the banner into the buffer
  // AND finish writing the PID file.
  await sleep(500);

  const captured = found; // capture for kill closure
  return {
    proc,
    tag,
    title: captured.title,
    hwnd: captured.hwnd,
    host,
    kill() {
      try { clearWindowTopmost(captured.hwnd); } catch { /* ignore */ }

      // Kill by PowerShell PID only — NEVER use /T (descendant-tree) flag.
      // When the host is Windows Terminal, the PS process is a child of the
      // shared WindowsTerminal.exe instance; /T can escalate the kill to the
      // entire WT process tree and take down all of the user's other tabs and
      // windows. This was observed on 2026-05-08 — see memory file
      // feedback_e2e_wt_host_taskkill_risk.md. Single-PID kill is enough to
      // close our spawned PS, and WT then closes the now-empty tab cleanly.
      let killedByPid = false;
      try {
        const { execSync } = require("child_process");
        const pidStr = readFileSync(pidFile, "utf-8").trim();
        const pid = parseInt(pidStr, 10);
        if (pid > 0 && !isNaN(pid)) {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          killedByPid = true;
        }
      } catch { /* best-effort */ }
      try { unlinkSync(pidFile); } catch { /* ignore */ }

      // Fallback: kill the cmd.exe proc we directly spawned
      if (!killedByPid && !proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
    },
  };
}
