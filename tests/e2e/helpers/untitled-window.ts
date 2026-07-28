/**
 * tests/e2e/helpers/untitled-window.ts
 *
 * Spawn a visible, borderless, **untitled** window — the shape
 * `enumWindowsInZOrder` deliberately drops (`if (!title) continue;`).
 *
 * WHY: ADR-029's viewport gate must not read "absent from the enumeration" as
 * "window closed". Untitled borderless windows are the normal shape for the
 * accessibility-blind targets the gate exists for (game canvases, remote-session
 * surfaces, custom-chrome apps), so the fallback that probes the HWND directly
 * needs a real Win32 window to be verified against — an injected fake cannot
 * tell us whether GetWindowRect / IsWindowVisible behave as assumed here.
 *
 * Because the window is invisible to the title-based enumeration, the form
 * reports its own HWND: the script writes `$f.Handle` to a temp file from the
 * Shown handler (same idiom as the PowerShell launcher's PID file) and the
 * lookup reads it back. The earlier "match the window of our PID whose rect is
 * exactly 320x240" approach could not survive DPI scaling — a DPI-unaware
 * WinForms host on a scaled monitor reports a scaled PHYSICAL rect, the size
 * comparison never matched, and the fixture silently returned null after a 10s
 * wait, skipping this coverage. An HWND is exact and scale-independent, and the
 * rect is then used as Win32 reports it (consumers compare against the real
 * rect, so a scaled one is equally valid).
 *
 * Spawn discipline matches `blank-window.ts` (not detached, console hidden from
 * inside the script, killed on close()).
 */
import { spawn } from "child_process";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nativeWin32 } from "../../../src/engine/native-engine.js";
import { pickE2eScreen } from "./e2e-screen.js";

export interface UntitledWindow {
  hwnd: bigint;
  /** Screen rect as Win32 reports it. */
  rect: { x: number; y: number; width: number; height: number };
  close: () => void;
}

const W = 320;
const H = 240;
// Fallback placement (single-monitor machines): the historical 700,420.
const DEFAULT_X = 700;
const DEFAULT_Y = 420;

/**
 * Returns null when the window never appears within 10s or the native bindings
 * are unavailable — callers should skip rather than assert.
 */
export async function spawnUntitledWindow(): Promise<UntitledWindow | null> {
  // Placement: like blank-window.ts, this TopMost form is spawned on a
  // non-primary monitor when one exists so the suite stays off the user's
  // working screen; single-monitor machines keep the historical 700,420.
  // Safe for the only consumer (adr-029-viewport-gate.test.ts): its assertions
  // are relative to this window's OWN rect, and the viewport gate compares an
  // entity against its origin window's rect with no monitor-level logic.
  // Same DPI caveat as blank-window.ts — the rect is always read back below.
  // The historical offset is passed through so this window keeps its former
  // relative position to the blank window (120,120) instead of stacking on it.
  const screen = pickE2eScreen({ width: W, height: H }, { x: DEFAULT_X, y: DEFAULT_Y });
  const x = screen?.origin.x ?? DEFAULT_X;
  const y = screen?.origin.y ?? DEFAULT_Y;
  // The form reports its own HWND here (same idiom as the launcher's PID file).
  // Written from the Shown handler: `$f.Handle` would force handle creation even
  // earlier, but only after Shown is the window guaranteed to be on screen, so
  // the reader never races a not-yet-visible window.
  const hwndFile = join(tmpdir(), `dt-untitled-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const psafeHwndFile = hwndFile.replace(/'/g, "''");
  const script = [
    `$s='[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h,int n);';`,
    "$w=Add-Type -MemberDefinition $s -Name NativeUntitled -PassThru;",
    "[void]$w::ShowWindow($w::GetConsoleWindow(),0);",
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$f=New-Object System.Windows.Forms.Form;",
    "$f.Text='';", // ← the point of this fixture
    "$f.FormBorderStyle='None';",
    "$f.StartPosition='Manual';",
    `$f.Location=New-Object System.Drawing.Point(${x},${y});`,
    `$f.Size=New-Object System.Drawing.Size(${W},${H});`,
    "$f.BackColor=[System.Drawing.Color]::DarkSlateGray;",
    "$f.TopMost=$true;",
    `$f.Add_Shown({ [string]$f.Handle | Set-Content -Path '${psafeHwndFile}' });`,
    "[System.Windows.Forms.Application]::Run($f);",
  ].join(" ");

  const child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { child.kill(); } catch { /* already gone */ }
    try { unlinkSync(hwndFile); } catch { /* never written / already gone */ }
  };

  const w32 = nativeWin32;
  if (!w32?.win32GetWindowRect || child.pid === undefined) {
    close();
    return null;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      // The file appears only once the form is shown; until then this throws.
      const raw = readFileSync(hwndFile, "utf-8").trim();
      if (raw) {
        const hwnd = BigInt(raw);
        // The rect is taken as Win32 reports it — physical pixels, whatever the
        // monitor's scale. Deliberately NOT compared against W/H: on a scaled
        // monitor the DPI-unaware host's logical 320x240 is reported scaled, and
        // the consumers work off the real rect anyway.
        if (hwnd !== 0n && (!w32.win32IsWindowVisible || w32.win32IsWindowVisible(hwnd))) {
          const r = w32.win32GetWindowRect(hwnd);
          if (r) {
            const rect = { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
            if (rect.width > 0 && rect.height > 0) return { hwnd, rect, close };
          }
        }
      }
    } catch {
      /* not written yet / unreadable — retry until the deadline */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  close();
  return null;
}
