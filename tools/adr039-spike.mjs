// ADR-039 spike measurement.
//
// Question: rectangle containment says the point is covered by a transparent
// overlay and the guard refuses. Does consulting the OS hit test at the refuse
// branch turn that into a delivery?
//
// Run from the sandbox root, with a window whose title contains the hint open:
//   npx tsc && node tools/adr039-spike.mjs "メモ帳"
//
// The overlay is raised by this script in its own process and taken down again.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { enumWindowsInZOrder, hitTestTopLevelWindowAt } = await import("../dist/engine/win32.js");
const { findContainingWindowFresh } = await import("../dist/engine/window-cache.js");
const { resolveActionTarget } = await import("../dist/engine/perception/action-target.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s) => console.log(s);

const TARGET_HINT = process.argv[2] ?? "無題 - メモ帳";
const target = enumWindowsInZOrder().find((w) => w.title.includes(TARGET_HINT));
if (!target) {
  console.error(`!! no window whose title contains "${TARGET_HINT}" — open one first`);
  process.exit(2);
}
{
  const all = enumWindowsInZOrder().filter((w) => w.title.includes(TARGET_HINT));
  if (all.length !== 1) {
    console.error(`!! ${all.length} windows match "${TARGET_HINT}" — the hint is not unique, ` +
      `so which window is measured would change under us:`);
    for (const w of all) console.error(`     "${w.title}" hwnd=${w.hwnd}`);
    process.exit(4);
  }
}

// The target must be the top REAL window at the point, otherwise the OS is
// right to name something else and the measurement says nothing. Raise it and
// verify with the OS hit test before measuring anything.
await new Promise((resolve) => {
  const fg = spawn("powershell", ["-NoProfile", "-Command", `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
}
'@
# Windows refuses SetForegroundWindow from a background process unless the
# caller shares an input queue with the current foreground thread.
$h = [IntPtr]${target.hwnd}
$mine = [Fg]::GetCurrentThreadId()
$fgw = [Fg]::GetForegroundWindow()
$fgt = [Fg]::GetWindowThreadProcessId($fgw, [IntPtr]::Zero)
$tid = [Fg]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
[void][Fg]::AttachThreadInput($mine, $fgt, $true)
[void][Fg]::AttachThreadInput($mine, $tid, $true)
[void][Fg]::ShowWindow($h, 9); [void][Fg]::BringWindowToTop($h); [void][Fg]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500
[void][Fg]::AttachThreadInput($mine, $tid, $false)
[void][Fg]::AttachThreadInput($mine, $fgt, $false)
`], { stdio: "ignore" });
  fg.on("exit", resolve);
});
await sleep(900);

const r = target.region;
const px = Math.round(r.x + r.width / 2);
const py = Math.round(r.y + 30);
line(`target : "${target.title}" hwnd=${target.hwnd}`);
line(`point  : (${px},${py})`);

const sanity = hitTestTopLevelWindowAt(px, py);
if (!sanity || String(sanity.hwnd) !== String(target.hwnd)) {
  console.error(`!! the OS says (${px},${py}) belongs to ` +
    `${sanity ? `"${sanity.title}" hwnd=${sanity.hwnd}` : "no window"}, not the target — ` +
    `the point is not on the target, so nothing measured here would mean anything`);
  process.exit(3);
}
line(`sanity : the OS agrees the point is on the target`);

async function probe(tag) {
  const cached = findContainingWindowFresh(px, py);
  const os = hitTestTopLevelWindowAt(px, py);
  const res = await resolveActionTarget(
    { kind: "coordinate", x: px, y: py, windowTitle: TARGET_HINT },
    { actionKind: "mouseClick" },
  );
  line(`\n[${tag}]`);
  line(`  rectangle containment : ${cached ? `"${cached.title}" hwnd=${cached.hwnd}` : "(none)"}`);
  line(`  OS hit test (root)    : ${os ? `"${os.title}" hwnd=${os.hwnd}` : "(no answer)"}`);
  line(`  resolver              : ${res.lens ? "PASS (lens built)" : "REFUSED"}` +
       (res.titleMismatch ? `  titleMismatch=${JSON.stringify(res.titleMismatch)}` : ""));
  for (const w of res.warnings) line(`  warning               : ${w}`);
  return { cached, os, res };
}

// NOTE — do not count menus with `enumWindowsInZOrder`. It cannot see them:
// with Notepad's File menu open (Alt+F) the count stays 0, while a raw
// `EnumWindows` pass returns 1. The click measurement therefore lives in
// `tools/adr039-click-under-overlay.py`, which counts with `EnumWindows`.

/** A real OS click at a screen point, independent of anything under test. */
async function osClick(x, y) {
  await new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-Command", `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class Clk {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
}
'@
[void][Clk]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 120
[Clk]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 60
[Clk]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
`], { stdio: "ignore" });
    p.on("exit", resolve);
  });
  await sleep(900);
}

line("\n================ 1. no overlay ================");
const before = await probe("no overlay");

const dir = mkdtempSync(join(tmpdir(), "adr039-"));
const stopFile = join(dir, "stop");
const ps = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                "tools/adr039-overlay.ps1", "-StopFile", stopFile],
                 { stdio: ["ignore", "pipe", "pipe"] });
let info = "";
ps.stdout.on("data", (d) => { info += String(d); });
await sleep(4000);
line("\n================ 2. overlay up ================");
line(info.trim().split("\n").map((s) => "  " + s.trim()).join("\n"));
const during = await probe("overlay up");

writeFileSync(stopFile, "stop");
await sleep(1800);
line("\n================ 3. overlay down ================");
const after = await probe("overlay down");
rmSync(dir, { recursive: true, force: true });

line("\n================ summary ================");
line(`  no overlay   : ${before.res.lens ? "PASS" : "REFUSED"}`);
line(`  overlay up   : ${during.res.lens ? "PASS" : "REFUSED"}` +
     `   (rect said "${during.cached?.title ?? "?"}", OS said "${during.os?.title ?? "?"}")`);
line(`  overlay down : ${after.res.lens ? "PASS" : "REFUSED"}`);
