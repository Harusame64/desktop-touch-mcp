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
 * Because the window is invisible to the title-based enumeration, its HWND is
 * located by process id via the native top-level enumeration instead.
 *
 * Spawn discipline matches `blank-window.ts` (not detached, console hidden from
 * inside the script, killed on close()).
 */
import { spawn } from "child_process";
import { nativeWin32 } from "../../../src/engine/native-engine.js";

export interface UntitledWindow {
  hwnd: bigint;
  /** Screen rect as Win32 reports it. */
  rect: { x: number; y: number; width: number; height: number };
  close: () => void;
}

const X = 700;
const Y = 420;
const W = 320;
const H = 240;

/** All top-level HWNDs owned by `pid`, whether or not they have a title. */
function windowsOfPid(pid: number): bigint[] {
  const w32 = nativeWin32;
  if (!w32?.win32EnumTopLevelWindows || !w32.win32GetWindowThreadProcessId) return [];
  const out: bigint[] = [];
  for (const hwnd of w32.win32EnumTopLevelWindows()) {
    try {
      if (w32.win32GetWindowThreadProcessId(hwnd).processId === pid) out.push(hwnd);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Returns null when the window never appears within 10s or the native bindings
 * are unavailable — callers should skip rather than assert.
 */
export async function spawnUntitledWindow(): Promise<UntitledWindow | null> {
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
    `$f.Location=New-Object System.Drawing.Point(${X},${Y});`,
    `$f.Size=New-Object System.Drawing.Size(${W},${H});`,
    "$f.BackColor=[System.Drawing.Color]::DarkSlateGray;",
    "$f.TopMost=$true;",
    "[System.Windows.Forms.Application]::Run($f);",
  ].join(" ");

  const child = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { child.kill(); } catch { /* already gone */ }
  };

  const w32 = nativeWin32;
  if (!w32?.win32GetWindowRect || child.pid === undefined) {
    close();
    return null;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const hwnd of windowsOfPid(child.pid)) {
      try {
        if (w32.win32IsWindowVisible && !w32.win32IsWindowVisible(hwnd)) continue;
        const r = w32.win32GetWindowRect(hwnd);
        if (!r) continue;
        const rect = { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
        // The PowerShell host owns other (hidden) windows; match ours by size.
        if (rect.width === W && rect.height === H) return { hwnd, rect, close };
      } catch {
        /* skip */
      }
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  close();
  return null;
}
