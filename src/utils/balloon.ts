/**
 * src/utils/balloon.ts — raw Windows balloon-tip helper (ADR-030 Phase 1 W2).
 *
 * Extracted from `src/tools/notification.ts` so the failsafe machinery
 * (`src/utils/failsafe.ts` / `src/utils/failsafe-watcher.ts`) can show
 * notifications without importing from the tools layer (tools → utils is the
 * correct dependency direction; utils → tools would invert it).
 *
 * System.Windows.Forms.NotifyIcon balloon tip — no WinRT dependency, no
 * external modules. Works on Windows 10 / 11. The child PowerShell process is
 * `unref()`ed on spawn, so it survives the parent's `process.exit` — the
 * watcher exit path can await the spawn and still have the balloon delivered
 * (ADR-030 R5: best-effort; the diagnostic log is the primary evidence).
 */

import { execFile } from "node:child_process";

/**
 * Show a Windows system-tray balloon tip. Resolves once the PowerShell child
 * has spawned (NOT when the balloon disappears — the child keeps it alive for
 * ~6.5 s on its own); rejects if the spawn itself fails.
 */
export async function showBalloonTip(title: string, body: string): Promise<void> {
  // Escape single quotes in caller-supplied strings for PowerShell embedding.
  const safeTitle = title.replace(/'/g, "''");
  const safeBody = body.replace(/'/g, "''");

  // The sleep ensures the balloon stays alive before the PowerShell process exits.
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$icon = [System.Drawing.SystemIcons]::Information",
    "$notify = New-Object System.Windows.Forms.NotifyIcon",
    "$notify.Icon = $icon",
    "$notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info",
    `$notify.BalloonTipTitle = '${safeTitle}'`,
    `$notify.BalloonTipText = '${safeBody}'`,
    "$notify.Visible = $true",
    "$notify.ShowBalloonTip(6000)",
    "Start-Sleep -Milliseconds 6500",
    "$notify.Dispose()",
  ].join("; ");

  // Fire-and-forget — spawn PowerShell, unref immediately so Node doesn't wait for it.
  // The 6.5 s sleep inside the PS script keeps the balloon alive without blocking MCP.
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15000 }
    );
    child.on("spawn", () => {
      // Detach from the Node process lifecycle — child runs independently
      child.unref();
      resolve();
    });
    child.on("error", (err) => reject(err));
  });
}
