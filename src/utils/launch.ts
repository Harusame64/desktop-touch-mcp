/**
 * launch.ts — Shared utilities for launching desktop applications.
 *
 * Extracted from workspace.ts so that browser.ts (browser_open with launch:{...}) can
 * reuse path resolution and spawn logic without creating a dependency
 * between tool files.
 */

import { spawn } from "node:child_process";
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
      // Build a helpful error message based on the error code
      let hint: string;
      if (err.code === "ENOENT") {
        hint = `Command "${command}" not found. Provide the full path (e.g. "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").`;
      } else if (err.code === "EACCES" || err.code === "EPERM") {
        hint = `Permission denied for "${command}". Check that the file is executable and not blocked by policy.`;
      } else {
        hint = `spawn failed for "${command}": ${err.message}`;
      }
      reject(new Error(hint));
    });
  });
}
