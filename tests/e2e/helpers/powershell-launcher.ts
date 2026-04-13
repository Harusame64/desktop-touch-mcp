/**
 * powershell-launcher.ts — spawn a PowerShell window with a deterministic title tag.
 *
 * Uses `$Host.UI.RawUI.WindowTitle = '<tag>'` so the window is findable via
 * enumWindowsInZOrder without depending on exe basename or locale.
 *
 * `banner` is echoed after setting the title so terminal_read tests have
 * something to assert on.
 */

import { spawn, type ChildProcess } from "child_process";
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

  // Set title first, then echo banner. -NoExit keeps the window alive.
  // PowerShell treats single-quotes as literal delimiters — escape embedded ' by doubling.
  const psScript = [
    `$Host.UI.RawUI.WindowTitle = '${tag}'`,
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
    throw new Error(`PowerShell window with tag "${tag}" did not appear within 10s`);
  }

  // Give PowerShell a moment to actually print the banner into the buffer.
  await sleep(500);

  const captured = found; // capture for kill closure
  return {
    proc,
    tag,
    title: captured.title,
    hwnd: captured.hwnd,
    kill() {
      try { clearWindowTopmost(captured.hwnd); } catch { /* ignore */ }
      // cmd /c start spawns a detached grandchild — kill by PID via taskkill.
      // Find the PowerShell process that owns the window and kill by window.
      try {
        const { execSync } = require("child_process");
        execSync(`taskkill /F /FI "WINDOWTITLE eq ${tag}*" /T`, { stdio: "ignore" });
      } catch { /* best-effort */ }
      if (!proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
    },
  };
}
