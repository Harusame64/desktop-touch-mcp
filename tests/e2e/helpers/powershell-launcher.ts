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
 *
 * Issue #175 WT host isolation: the `host:'wt'` path forces a brand-new
 * top-level Windows Terminal window per launch via `-w <unique>` and a
 * dedicated profile name `__dtm_e2e__` via `-p`. This decouples our spawned
 * PowerShell from any pre-existing WT windows the user has open, so an
 * accidental window-level operation cannot bleed into the user's session.
 * The kill path remains single-PID (NEVER `/T`) — see kill() comment for
 * the 2026-05-08 incident that motivated this defence-in-depth.
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enumWindowsInZOrder, clearWindowTopmost } from "../../../src/engine/win32.js";
import { sleep } from "./wait.js";

const execFileAsync = promisify(execFile);

/**
 * Codex P2 (#175): when the env-gate `DTM_E2E_WT` was removed, WT-host
 * scenarios began running unconditionally. On a host without `wt.exe`
 * (Linux CI, Windows images with WT removed/disabled), `launchPowerShell`
 * times out waiting for the tagged window and fails the entire test file.
 * That is an environmental constraint, not a product bug, so callers should
 * skip cleanly. Use this from a test's `beforeAll` (or guard a `describe`
 * conditionally) when WT is required.
 *
 * Detects via `where wt.exe` (Windows shell builtin); short timeout so a
 * non-Windows host returns quickly. Result is cached per process for cheap
 * re-checks.
 */
let cachedWtAvailable: boolean | null = null;
export async function isWindowsTerminalAvailable(): Promise<boolean> {
  if (cachedWtAvailable !== null) return cachedWtAvailable;
  if (process.platform !== "win32") {
    cachedWtAvailable = false;
    return false;
  }
  try {
    await execFileAsync("where", ["wt.exe"], { timeout: 2000, windowsHide: true });
    cachedWtAvailable = true;
  } catch {
    cachedWtAvailable = false;
  }
  return cachedWtAvailable;
}

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
  // Use [Console]::Title (.NET → SetConsoleTitleW) instead of
  // $Host.UI.RawUI.WindowTitle. The PowerShell-host API is unreliable on
  // Windows Terminal (sets an internal value that does not propagate to
  // the WT window's title bar, breaking findByTag with a 10s timeout —
  // observed during PR #192 manual verification 2026-05-08). [Console]::Title
  // calls SetConsoleTitleW directly which both conhost and WT honour
  // (WT picks it up via VT or the console API).
  const psScript = [
    `[Console]::Title = '${tag}'`,
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
  //   - "wt": start "" wt.exe -w <unique> -p __dtm_e2e__ new-tab -- ...
  //     pins CASCADIA_HOSTING_WINDOW_CLASS via Windows Terminal AND
  //     isolates the spawned PS from the user's existing WT windows
  //     (issue #175). Details below in WT-specific block.
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
    // Issue #175: isolate the spawned PS from the user's existing WT.
    //
    // WT is a single-process / multi-window application: by default
    // `wt.exe new-tab ...` attaches the new tab to the user's currently
    // active WT window (or whichever one Windows considers "current"),
    // which is exactly the entanglement that caused the 2026-05-08
    // taskkill-/T accident.
    //
    // We avoid that by pinning **window** and **profile** explicitly:
    //
    //   -w <unique-tag>
    //     Force a brand-new top-level WT window for this launcher
    //     instance. `<tag>` is generated above and is unique per call,
    //     so even if another test or process happened to be using the
    //     name space, our window is its own. WT semantics: when -w is
    //     given a name that does not match any existing window, it
    //     creates a NEW window with that name. Crucially, passing a
    //     name we know does not exist is the documented way to force
    //     a new window without using `-w new` (which has historically
    //     been less reliable across WT versions).
    //
    //   -p __dtm_e2e__
    //     Request an isolated profile name. If the user does not have
    //     a profile by that name (which they almost certainly do not —
    //     leading double underscores are reserved-looking), WT falls
    //     back to the default profile WITHOUT mutating settings.json.
    //     This is intentional: we never want to write user config from
    //     a test. The flag is a best-effort isolation hint; the real
    //     blast-radius guarantee comes from the unique -w window above.
    //
    //   new-tab (NO --suppressApplicationTitle)
    //     The original PR-192 commit added `--suppressApplicationTitle` on
    //     the assumption that it would PRESERVE our PS-set window title.
    //     The actual WT semantics are the opposite: that flag tells WT to
    //     IGNORE application-set titles and use the profile name. With it
    //     enabled, `findByTag` could never see our `$Host.UI.RawUI.WindowTitle`
    //     and timed out at 10s waiting for the tagged window. WT's default
    //     (no flag) honours the application title, which is exactly what
    //     findByTag needs.
    //
    // Cleanup contract (kill() below): single-PID kill of the PS child.
    // NEVER use `/T` — see kill() comment for the full rationale and
    // the 2026-05-08 incident reference.
    const wtWindowName = `__dtm_e2e_${tag}__`;
    const wtProfile = "__dtm_e2e__";
    startCmd =
      `start "" wt.exe -w "${wtWindowName}" -p "${wtProfile}" ` +
      `new-tab -- "${exe}" ${psArgs}`;
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
      //
      // Issue #175 isolation contract: even if /T were re-introduced by
      // mistake, the spawn site above pins a UNIQUE -w window per launch
      // (`__dtm_e2e_${tag}__`), so the WT window we own is distinct from
      // the user's existing windows. /T is still forbidden because the
      // PS child's parent is the shared `WindowsTerminal.exe` process —
      // the descendant tree from there fans out across every WT window
      // including the user's. The unique -w window narrows blast radius
      // for accidental window-level operations; the kill path stays
      // PID-scoped regardless. DO NOT add /T here under any circumstance.
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
