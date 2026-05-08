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
 * top-level Windows Terminal window per launch via `-w <unique>`. The unique
 * window name decouples our spawned PowerShell from any pre-existing WT
 * windows the user has open, so an accidental window-level operation cannot
 * bleed into the user's session. The kill path remains single-PID (NEVER
 * `/T`) — see kill() comment for the 2026-05-08 incident that motivated this
 * defence-in-depth. (`-p __dtm_e2e__` was tried in earlier revisions but the
 * combination of `-p <missing-profile>` placed before `new-tab --` plus a
 * long `-EncodedCommand <base64>` arg with `=` padding broke WT 1.24's CLI11
 * parser — observed in PR #192 manual verification 2026-05-08; see the
 * `host:'wt'` block below for the full story.)
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
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
  let proc: ChildProcess;
  let startCmd: string | null = null;
  // Tempscript path captured here so kill() can clean it up. Only the
  // wt-host branch writes a tempfile (see below); other hosts leave this
  // null and the kill() unlink becomes a no-op.
  let scriptToCleanup: string | null = null;
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
    // We avoid that by pinning **window** explicitly with `-w <unique>`:
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
    //     Window name uses `dtm_e2e_${tag}` (single underscore prefix,
    //     no trailing `__`). The earlier `__dtm_e2e_${tag}__` form was
    //     reserved-looking enough to risk WT parser ambiguity — `_quake`
    //     is the only documented reserved name but `__`-prefixed names
    //     have caused regressions historically. Single underscore is
    //     unambiguous and equally unique.
    //
    //   No `-p <profile>` flag.
    //     Earlier revisions tried `-p __dtm_e2e__` to "request an
    //     isolated profile name" with the assumption that WT would
    //     silently fall back to the default profile when the name was
    //     missing. That assumption is wrong on WT 1.24: when `-p` is
    //     placed BEFORE `new-tab --` and the subprocess args contain
    //     a long `-EncodedCommand <base64>` value with `=` padding,
    //     WT 1.24's CLI11-based parser (microsoft/terminal,
    //     `AppCommandlineArgs.cpp`) misreads the whole `new-tab --
    //     powershell.exe ... -EncodedCommand <b64>=` chunk as a single
    //     program-name token and CreateProcess fails with
    //     ERROR_FILE_NOT_FOUND (0x80070002). Observed during PR #192
    //     manual verification 2026-05-08 — `'new-tab -- powershell.exe
    //     -NoExit -NoProfile -EncodedCommand <b64>' の起動時にエラー
    //     2147942402` was the user-visible symptom. Removing `-p`
    //     entirely sidesteps the parser break; the unique `-w` window
    //     remains responsible for blast-radius containment, and the
    //     kill path is PID-only (see kill() below) so isolation is
    //     unaffected. We also switch from `-EncodedCommand` to `-File
    //     <tempscript>` below to belt-and-brace this — even with `-p`
    //     gone, base64 `=` padding in WT argv is fragile.
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
    const wtWindowName = `dtm_e2e_${tag}`;
    // Write the PS init script as a tempfile and pass it via `-File <path>`
    // instead of `-EncodedCommand <base64>`. Reason: WT 1.24's CLI11 parser
    // treats `=` as an `--option=value` separator. Base64 padding (`=` /
    // `==` at end of `encodedScript`) collides with that and corrupts the
    // surrounding argv tokenisation when the value is long. `-File` carries
    // a plain filesystem path with no `=` characters, which the parser
    // handles cleanly. UTF-8 with BOM is used because PowerShell 5.1
    // (default on Windows 11) requires the BOM to recognise non-ASCII
    // content; PS 7+ tolerates either form. Cleanup of the tempfile is
    // hooked into kill() below alongside the existing pidFile unlink.
    const wtScript = join(tmpdir(), `${tag}-launch.ps1`);
    // UTF-8 BOM (EF BB BF) prefix: PowerShell 5.1 — the default on Windows
    // 11 — refuses to parse non-ASCII script content without the BOM.
    // Written as an explicit byte-array Buffer rather than the U+FEFF
    // literal so the prefix is visible to readers and reviewers.
    const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(wtScript, Buffer.concat([utf8Bom, Buffer.from(psScript, "utf8")]));
    scriptToCleanup = wtScript;
    // Spawn wt.exe directly with an argv array (shell:false) instead of
    // building a shell command string. Background: `spawn(string, {shell:true})`
    // wraps the string as `cmd.exe /d /s /c "<startCmd>"` on Windows. When
    // <startCmd> itself contains nested double-quotes from `-w "${name}"` /
    // `"${exe}"`, cmd's `/s /c` quote-pairing collapses and `start ""` ends
    // up handing wt.exe a single mis-tokenised arg. Bypassing the shell
    // hands each argv[i] verbatim to CreateProcess and removes the
    // quote-escape surface. `detached:true` on Windows sets
    // DETACHED_PROCESS, taking over the role `start ""` previously played
    // in cutting the child off from our (ignored) stdio.
    // -ExecutionPolicy Bypass is required for the `-File` path. Windows
    // 11's default per-user ExecutionPolicy is `Restricted`, which blocks
    // `-File` script execution with `UnauthorizedAccess` even for tempfiles
    // we just wrote ourselves. `-EncodedCommand` was not subject to this
    // because it runs through the pipeline interpreter, but -File goes
    // through the script-loader. `Bypass` applies ONLY to this child
    // PowerShell invocation — the user's machine-wide policy is not
    // modified, and no policy state persists after the process exits.
    const wtArgs = [
      "-w", wtWindowName,
      "new-tab",
      "--",
      exe,
      "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wtScript,
    ];
    proc = spawn("wt.exe", wtArgs, {
      detached: true, stdio: "ignore", windowsHide: false, shell: false,
    });
  } else {
    startCmd = `start "" "${exe}" ${psArgs}`;
  }
  if (startCmd !== null) {
    proc = spawn(startCmd, {
      detached: true, stdio: "ignore", windowsHide: false, shell: true,
    });
  }
  proc!.unref(); // don't block vitest exit

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
      // (`dtm_e2e_${tag}`), so the WT window we own is distinct from
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
      // wt-host branch writes a `-File` tempscript (see spawn site above).
      // Best-effort cleanup so /tmp does not accumulate per-test ps1 files.
      if (scriptToCleanup) {
        try { unlinkSync(scriptToCleanup); } catch { /* ignore */ }
      }

      // Fallback: kill the cmd.exe proc we directly spawned
      if (!killedByPid && !proc.killed) {
        try { proc.kill(); } catch { /* ignore */ }
      }
    },
  };
}
