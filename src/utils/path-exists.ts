// Existence checks that do not follow the path (internal: PR #887).

import { lstatSync } from "node:fs";

/**
 * Whether a path exists, WITHOUT following it. `wt.exe` under `%LOCALAPPDATA%\Microsoft\WindowsApps` is an
 * MSIX app-execution alias (an AppExecLink reparse point): on Node v24.20.0 (win2, 2026-10-31) `existsSync`
 * answers false and `statSync` EACCES for it, while `lstatSync` reads it and spawning it works — so
 * `existsSync` made launch_console's default (a Windows Terminal tab) fail with KeyLockerWtUnavailable on a
 * machine that has Windows Terminal. Any lstat error counts as missing.
 */
export function aliasExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
