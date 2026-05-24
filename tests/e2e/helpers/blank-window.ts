/**
 * tests/e2e/helpers/blank-window.ts
 *
 * Spawn a dedicated, empty, throwaway window for mouse E2E tests to click —
 * instead of clicking the desktop wallpaper or a hardcoded coordinate.
 *
 * WHY: clicking hardcoded coordinates ((960,540) screen centre, (50,50) top-left)
 * landed on whatever real window/icon was there — collateral focus changes,
 * accidental clicks, and the (50,50) top-left click selected the Recycle Bin
 * desktop icon at every full-suite run. Clicking the wallpaper is better but
 * still focuses the desktop (the Recycle Bin gets a focus rectangle). Clicking a
 * dedicated blank window's empty client area is fully contained: it focuses OUR
 * own window, triggers no control, never touches the desktop / Recycle Bin / any
 * real app, and always works (no skip). The "click that hits nothing ->
 * focus_only" verify-delivery pin holds — an empty form has no UIA children to
 * mutate, so a click yields focus_only, never 'delivered'.
 *
 * The window is a control-less, TopMost WinForms form driven by a PowerShell
 * message loop (Application.Run); killing the process closes it. The returned
 * point is the centre of the window rect — it falls below the title bar (in the
 * empty client area) and clear of the title-bar buttons (top-right), so a click
 * lands only on empty surface.
 *
 * TopMost is deliberate: this host can carry a TopMost full-screen overlay (a
 * screen-capture / agent HUD); a non-topmost form would sit UNDER it and the
 * click would land on the overlay instead of our form. TopMost keeps the form
 * above such overlays so the click reliably hits OUR window. (It can momentarily
 * cover another test window — e.g. tool-chain's Notepad — but that file's
 * Notepad screenshot uses PrintWindow, which is overlay-immune, and its
 * Notepad-click test skips on a fresh, element-less Notepad.)
 */
import { spawn } from "child_process";
import { enumWindowsInZOrder } from "../../../src/engine/win32.js";

export interface BlankWindow {
  /** Screen-coordinate centre of the empty client area — safe to click. */
  point: { x: number; y: number };
  /** Close the window (kills the backing PowerShell process). Idempotent. */
  close: () => void;
}

const X = 120;
const Y = 120;
const W = 480;
const H = 360;

/**
 * Spawn the blank window and resolve once it is on screen. Returns null if the
 * window does not appear within 10s (callers should skip rather than fall back to
 * a blind click). Always pair with `close()` in afterAll.
 */
export async function spawnBlankWindow(): Promise<BlankWindow | null> {
  // Unique title so the rect lookup unambiguously picks OUR window (defensive —
  // the e2e project runs files serially, so concurrent spawns shouldn't occur).
  const title = `dt-blank-click-target-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Spawn-config caveats (verified empirically — do not "simplify"):
  //   - NO detached:true — a detached GUI process exits immediately (no desktop).
  //   - NO windowsHide:true / -WindowStyle Hidden — that hides the FORM too.
  //   - Instead, hide only the PowerShell host CONSOLE via P/Invoke ShowWindow
  //     (SW_HIDE) at the top of the script, so just the blank form is visible.
  const script = [
    `$s='[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int n);';`,
    "$w=Add-Type -MemberDefinition $s -Name Native -PassThru;",
    "[void]$w::ShowWindow($w::GetConsoleWindow(),0);",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$f=New-Object System.Windows.Forms.Form;",
    `$f.Text='${title}';`,
    "$f.FormBorderStyle='FixedSingle';",
    "$f.MaximizeBox=$false; $f.MinimizeBox=$false;",
    "$f.StartPosition='Manual';",
    `$f.Location=New-Object System.Drawing.Point(${X},${Y});`,
    `$f.Size=New-Object System.Drawing.Size(${W},${H});`,
    "$f.TopMost=$true;",
    "[System.Windows.Forms.Application]::Run($f);",
  ].join(" ");

  const child = spawn("powershell", ["-NoProfile", "-Command", script], {
    stdio: "ignore",
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const w = enumWindowsInZOrder().find((x) => x.title === title && !x.isMinimized);
    if (w && w.region.width > 0 && w.region.height > 0) {
      const r = w.region;
      // Centre of the window rect (GetWindowRect, incl. title bar) — for a
      // 480x360 form this lands well below the title bar in the empty client
      // area and clear of the title-bar buttons (top-right): only empty surface.
      return { point: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }, close };
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  close();
  return null;
}
