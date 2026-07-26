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
 * How much of a balloon actually survives the trip to the shell.
 *
 * `NotifyIcon.ShowBalloonTip` marshals into `NOTIFYICONDATA`, whose `szInfo` / `szInfoTitle` fields
 * are `ByValTStr` with `SizeConst` 256 / 64 — one unit of each is the NUL terminator, so 255 and 63
 * UTF-16 code units respectively are all that arrive.
 *
 * MEASURED 2026-07-26 (Windows 11 26100, PowerShell 5.1 / CLR 4.0.30319), against the earlier
 * assumption that over-long strings are REJECTED: they are not. Nothing throws — not the property
 * assignment, not `ShowBalloonTip` — and a `Marshal.StructureToPtr` round-trip of the same layout
 * returns the input silently cut to 63 / 255. So the real damage is a sentence that stops mid-word
 * with no indication anything was lost.
 *
 * Hence the two-part rule: callers keep their text inside the limits (pinned by
 * `tests/unit/balloon-length.test.ts`), and this sink adds an ellipsis when something slips through,
 * so a clipped notification at least LOOKS clipped.
 */
export const NOTIFYICON_BALLOON_TEXT_MAX = 255;
/** Title counterpart of `NOTIFYICON_BALLOON_TEXT_MAX` — `szInfoTitle` is `ByValTStr` SizeConst 64. */
export const NOTIFYICON_BALLOON_TITLE_MAX = 63;

/**
 * Cut `s` to `max` UTF-16 code units, ending in an ellipsis so the truncation is visible.
 *
 * The budget is `max - 3` rather than `max - 1`: the ellipsis is one code unit, and the slack keeps
 * the result comfortably inside the limit. Surrogate-safe — a cut landing between the halves of an
 * astral character (emoji, rare CJK) would otherwise emit a lone high surrogate, which renders as a
 * replacement box, so that unit is dropped as well.
 */
function truncateWithEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 3;
  const lastKept = s.charCodeAt(cut - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1; // high surrogate — its pair would be cut off
  return s.slice(0, cut) + "…";
}

/**
 * Clip `body` / `title` to what the shell will actually display. Pure + exported so the behaviour is
 * testable without spawning PowerShell; `buildBalloonScript` runs every balloon through both, so the
 * tests cover the real path.
 */
export function fitBalloonText(body: string): string {
  return truncateWithEllipsis(body, NOTIFYICON_BALLOON_TEXT_MAX);
}

export function fitBalloonTitle(title: string): string {
  return truncateWithEllipsis(title, NOTIFYICON_BALLOON_TITLE_MAX);
}

/**
 * Build the PowerShell one-liner that shows the balloon. Split out from the spawn so the fitting +
 * quote-escaping is testable without launching a process (a test that only calls `fitBalloonText`
 * directly would still pass if the sink stopped calling it).
 */
export function buildBalloonScript(title: string, body: string): string {
  // Escape single quotes in caller-supplied strings for PowerShell embedding.
  const safeTitle = fitBalloonTitle(title).replace(/'/g, "''");
  const safeBody = fitBalloonText(body).replace(/'/g, "''");

  // The sleep ensures the balloon stays alive before the PowerShell process exits.
  return [
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
}

/**
 * Show a Windows system-tray balloon tip. Resolves once the PowerShell child
 * has spawned (NOT when the balloon disappears — the child keeps it alive for
 * ~6.5 s on its own); rejects if the spawn itself fails.
 *
 * Over-long `title` / `body` are ellipsised rather than passed through: the shell would otherwise cut
 * them mid-word with nothing to show for it. Callers are expected to stay inside the limits on their
 * own (guard test); this is the last-resort net.
 */
export async function showBalloonTip(title: string, body: string): Promise<void> {
  const script = buildBalloonScript(title, body);

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
