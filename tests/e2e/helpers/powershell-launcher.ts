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
 */

import { spawn, type ChildProcess } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enumWindowsInZOrder, clearWindowTopmost } from "../../../src/engine/win32.js";
import { sleep } from "./wait.js";

export interface PsInstance {
  proc: ChildProcess;
  tag: string;
  title: string;
  hwnd: bigint;
  kill(): void;
}

function findByTag(tag: string): { hwnd: bigint; title: string } | null {
  for (const w of enumWindowsInZOrder()) {
    if (w.title.includes(tag)) return { hwnd: w.hwnd, title: w.title };
  }
  return null;
}

export async function launchPowerShell(opts?: { banner?: string; exe?: string }): Promise<PsInstance> {
  const tag = `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const banner = opts?.banner ?? "";
  const exe = opts?.exe ?? "powershell.exe";

  // Temp file the PS script writes its own PID into — lets kill() target the
  // exact PowerShell process rather than using WINDOWTITLE (which on Windows
  // Terminal matches WindowsTerminal.exe and would close all tabs with /T).
  const pidFile = join(tmpdir(), `${tag}-pid.txt`);
  // Escape path for PowerShell single-quoted string
  const psafePidFile = pidFile.replace(/'/g, "''");

  // Set title first, write PID, then echo banner. -NoExit keeps the window alive.
  const psScript = [
    `$Host.UI.RawUI.WindowTitle = '${tag}'`,
    `[string]$PID | Set-Content -Path '${psafePidFile}'`,
    banner ? `Write-Host '${banner.replace(/'/g, "''")}'` : "",
  ].filter(Boolean).join("; ");

  // Use cmd /c start to force a brand-new console window (stdio:"ignore" on
  // spawn() alone does NOT allocate a console — the powershell process would
  // exit immediately with no window).
  //
  // IMPORTANT: `start` treats the first quoted arg as the window title. An
  // unquoted tag would be parsed as the program name, and on JP locale the
  // shell renders "<tag> が見つかりません" in the opened window. Always quote.
  // shell:true so cmd parses the quoted title correctly.
  const startCmd = `start "" "${exe}" -NoExit -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`;
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
    kill() {
      try { clearWindowTopmost(captured.hwnd); } catch { /* ignore */ }

      // Kill by PowerShell PID — avoids matching WindowsTerminal.exe on Win11.
      let killedByPid = false;
      try {
        const { execSync } = require("child_process");
        const pidStr = readFileSync(pidFile, "utf-8").trim();
        const pid = parseInt(pidStr, 10);
        if (pid > 0 && !isNaN(pid)) {
          execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" });
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
