/**
 * launch.ts — Shared utilities for launching desktop applications.
 *
 * Extracted from workspace.ts so that browser.ts (browser_open with launch:{...}) can
 * reuse path resolution and spawn logic without creating a dependency
 * between tool files.
 */

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { isExecutableAllowlisted } from "./launch-config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Launch security validation
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_EXECUTABLES = new Set([
  "cmd", "cmd.exe",
  "powershell", "powershell.exe",
  "pwsh", "pwsh.exe",
  "wscript", "wscript.exe",
  "cscript", "cscript.exe",
  "mshta", "mshta.exe",
  "regsvr32", "regsvr32.exe",
  "rundll32", "rundll32.exe",
  "msiexec", "msiexec.exe",
  "bash", "bash.exe",
  "sh", "sh.exe",
  "wsl", "wsl.exe",
]);

const BLOCKED_EXTENSIONS = new Set([".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh"]);
const SHELL_METACHAR_RE = /[;&|`]|\$\(|\$\{/;

export function validateLaunchCommand(command: string, args: string[]): void {
  // User allowlist takes priority over all blocklist checks
  if (isExecutableAllowlisted(command)) return;

  const ext = path.extname(command).toLowerCase();
  if (ext && ext !== ".exe" && ext !== ".com") {
    throw new Error(`Blocked: "${command}" has disallowed extension "${ext}". Only .exe files are permitted.`);
  }
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`Blocked: script files (${ext}) cannot be launched directly.`);
  }
  const basename = path.basename(command).toLowerCase();
  const basenameNoExt = basename.replace(/\.(exe|com)$/i, "");
  if (BLOCKED_EXECUTABLES.has(basename) || BLOCKED_EXECUTABLES.has(basenameNoExt)) {
    throw new Error(
      `Blocked: "${basename}" is a shell interpreter and cannot be launched for security reasons. ` +
      `To allow it, add it to desktop-touch-allowlist.json (see README for details).`
    );
  }
  for (const arg of args) {
    if (SHELL_METACHAR_RE.test(arg)) {
      throw new Error(`Blocked: argument contains shell metacharacters (;, &, |, \`, $( or \${). Remove them and try again.`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Well-known browser path resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Map of bare executable names to candidate full paths (checked in order). */
export const WELL_KNOWN_PATHS: Record<string, string[]> = {
  "chrome.exe": [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  ],
  "msedge.exe": [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
  ],
  "brave.exe": [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    path.join(process.env["LOCALAPPDATA"] ?? "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
  ],
  "code.exe": [
    path.join(process.env["LOCALAPPDATA"] ?? "", "Programs\\Microsoft VS Code\\Code.exe"),
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft VS Code\\Code.exe"),
  ],
};

/**
 * If `command` is a bare executable name (no path separator) and matches a
 * well-known browser/tool, return the first existing full path.
 * Otherwise return the original command unchanged.
 */
export function resolveWellKnownPath(command: string): { resolved: string; wasResolved: boolean } {
  // Only resolve bare names — if user supplied a full path, trust it
  if (command.includes("\\") || command.includes("/")) {
    return { resolved: command, wasResolved: false };
  }
  const key = command.toLowerCase();
  const candidates = WELL_KNOWN_PATHS[key];
  if (!candidates) return { resolved: command, wasResolved: false };

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { resolved: candidate, wasResolved: true };
      }
    } catch { /* ignore */ }
  }
  return { resolved: command, wasResolved: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// App Paths registry resolution (issue #258)
// ─────────────────────────────────────────────────────────────────────────────
//
// Windows resolves bare executable names like `excel.exe`, `winword.exe`,
// `chrome.exe` through the App Paths registry — the same mechanism that
// makes them runnable from Win+R and the Explorer address bar. Apps that
// install via MSI typically register their canonical install path under
// `Software\Microsoft\Windows\CurrentVersion\App Paths\<exe>` so callers
// do not need to know where they live.
//
// `CreateProcess` (which Node's `spawn` ultimately calls) does NOT consult
// App Paths — it only searches PATH. That gap is why
// `workspace_launch(command='excel.exe')` returned ENOENT for users who had
// Office installed normally. This helper adds the missing lookup as a
// secondary resolution after `resolveWellKnownPath` so common Office /
// browser / IDE names "just work" from the LLM prompt.
//
// Security: the resolved path is run through `validateLaunchCommand` again
// by the caller, so a malicious App Paths entry pointing at a blocked
// shell interpreter (cmd.exe, powershell.exe, etc.) is still rejected.

const APP_PATHS_HIVES: Array<string> = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];

/**
 * Query the App Paths registry for `command`. Returns the resolved absolute
 * path (with %VAR% tokens expanded against `process.env`) on the first hit,
 * or null if no key exists in any hive. Uses synchronous `reg query` — same
 * shape as the rest of the project's registry probes (see
 * `scripts/enable-access-vbom.mjs::readDword`).
 *
 * Only resolves bare executable names: anything with a path separator is
 * passed through unchanged because the caller has already specified an
 * absolute or relative path that we should not second-guess.
 */
export function resolveAppPathsRegistry(command: string): string | null {
  if (command.includes("\\") || command.includes("/")) return null;
  // Normalise to `<name>.exe` so callers can pass either form. App Paths keys
  // are stored with the `.exe` suffix verbatim.
  const exeName = /\.exe$/i.test(command) ? command : `${command}.exe`;

  for (const hive of APP_PATHS_HIVES) {
    const keyPath = `${hive}\\${exeName}`;
    const result = spawnSync("reg", ["query", keyPath, "/ve"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) continue;
    // `reg query <key> /ve` produces (locale-stable on Windows):
    //   <key full path>
    //       (Default)    REG_SZ           C:\Path\To\App.exe
    // or REG_EXPAND_SZ with a `%VAR%`-bearing value.
    for (const line of result.stdout.split(/\r?\n/)) {
      const m = line.match(/\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/);
      if (!m || !m[1]) continue;
      const raw = m[1].trim();
      if (!raw) continue;
      // Expand %VAR% tokens for REG_EXPAND_SZ values; leave plain REG_SZ
      // untouched (the regex captures both — expansion is a no-op when no
      // tokens are present).
      const expanded = raw.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
      // The App Paths value is sometimes a quoted path; strip surrounding
      // quotes so spawn() does not pass a literal `"..."` string to Win32.
      const unquoted = expanded.startsWith('"') && expanded.endsWith('"')
        ? expanded.slice(1, -1)
        : expanded;
      return unquoted;
    }
  }
  return null;
}

/**
 * Resolve a launch command through the full chain:
 *   1. Path separator present → trust the caller's path (no resolution)
 *   2. `WELL_KNOWN_PATHS` table (browsers / VS Code)
 *   3. App Paths registry (issue #258 — common Office / Windows apps)
 *   4. Otherwise return unchanged (will fall through to ENOENT on spawn)
 *
 * Returns `{ resolved, source }` so the caller can log / hint the path
 * came from. `source: 'identity'` means no resolution was performed.
 *
 * The caller is responsible for re-running `validateLaunchCommand` on the
 * resolved path — App Paths values are user-writable and could otherwise
 * smuggle a blocked shell interpreter through.
 */
export function resolveLaunchExecutable(command: string): {
  resolved: string;
  source: "identity" | "well-known" | "app-paths";
} {
  if (command.includes("\\") || command.includes("/")) {
    return { resolved: command, source: "identity" };
  }
  const wk = resolveWellKnownPath(command);
  if (wk.wasResolved) return { resolved: wk.resolved, source: "well-known" };
  const ap = resolveAppPathsRegistry(command);
  if (ap !== null) return { resolved: ap, source: "app-paths" };
  return { resolved: command, source: "identity" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn with reliable error detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a detached process and wait until we know it has started successfully
 * or failed. Uses a Promise that resolves on first `spawn` event (success)
 * or rejects on `error` event (ENOENT, EACCES, etc.).
 *
 * This is strictly better than the setTimeout(50ms) pattern because:
 * - The `spawn` event fires synchronously when the OS succeeds — no race.
 * - The `error` event fires on the next tick for ENOENT — caught deterministically.
 * - No arbitrary delay that could be too short or too long.
 */
export function spawnDetached(
  command: string,
  args: string[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });

    const cleanup = () => {
      child.removeAllListeners("error");
      child.removeAllListeners("spawn");
    };

    child.on("spawn", () => {
      cleanup();
      child.unref();
      resolve();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      // Phase 7 F3: prefix all spawnDetached rejection messages with
      // "SpawnFailed:" so `_errors.ts::classify()` upgrades them to the
      // typed `SpawnFailed` code (instead of fall-through to generic
      // `ToolError`). Inline `new Error(\`SpawnFailed: ...\`)` so the
      // §4.bis classify-branch producer pin (issue-211 test) can match
      // the literal call site as a producer (variable-indirected
      // `new Error(hint)` does not match the keyword regex set).
      if (err.code === "ENOENT") {
        reject(new Error(`SpawnFailed: Command "${command}" not found. Provide the full path (e.g. "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").`));
      } else if (err.code === "EACCES" || err.code === "EPERM") {
        reject(new Error(`SpawnFailed: Permission denied for "${command}". Check that the file is executable and not blocked by policy.`));
      } else {
        reject(new Error(`SpawnFailed: spawn failed for "${command}": ${err.message}`));
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Process termination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Absolute path to the trusted System32 taskkill.exe.
 * Computed once at module load from %SystemRoot% / %WINDIR% (with C:\Windows
 * as last-resort fallback) to avoid PATH-hijack attacks where a malicious
 * `taskkill.exe` planted in the working directory or another earlier search
 * location could be invoked instead of the genuine system utility.
 */
const TASKKILL_EXE = path.join(
  process.env["SystemRoot"] ?? process.env["WINDIR"] ?? "C:\\Windows",
  "System32",
  "taskkill.exe",
);

/**
 * Terminate all instances of the given executable name(s) via taskkill /F /IM.
 * Returns the list of exe names that actually had a process killed (taskkill exit 0).
 * Errors / "no process found" (exit 128) are silently ignored.
 *
 * Windows-only — invokes %SystemRoot%\System32\taskkill.exe by absolute path
 * to prevent PATH-hijack attacks.
 */
export function killProcessesByName(exeNames: string[]): string[] {
  const killed: string[] = [];
  for (const exe of exeNames) {
    try {
      const result = spawnSync(TASKKILL_EXE, ["/F", "/IM", exe], {
        windowsHide: true,
        timeout: 5000,
      });
      if (result.status === 0) killed.push(exe);
      // exit 128 = "process not found" — ignore
      // other non-zero = silently ignore — best-effort
    } catch { /* ignore — best-effort */ }
  }
  return killed;
}
