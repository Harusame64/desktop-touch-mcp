/**
 * User-configurable launch allowlist for workspace_launch.
 *
 * Location (first found wins):
 *   1. Path in env var DESKTOP_TOUCH_ALLOWLIST
 *   2. ~/.claude/desktop-touch-allowlist.json
 *   3. <server dir>/desktop-touch-allowlist.json
 *
 * Format:
 * {
 *   "allowedExecutables": [
 *     "myapp.exe",
 *     "C:\\Program Files\\MyTool\\tool.exe"
 *   ]
 * }
 *
 * Entries are matched against the command basename (case-insensitive)
 * OR the full normalized path. Allowlisted commands bypass the blocklist.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface AllowlistConfig {
  allowedExecutables: string[];
}

let _cache: Set<string> | null = null;
let _lastMtime = 0;

function resolveConfigPath(): string | null {
  const fromEnv = process.env["DESKTOP_TOUCH_ALLOWLIST"];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const fromHome = path.join(os.homedir(), ".claude", "desktop-touch-allowlist.json");
  if (fs.existsSync(fromHome)) return fromHome;

  const fromDir = path.join(path.dirname(process.execPath), "desktop-touch-allowlist.json");
  if (fs.existsSync(fromDir)) return fromDir;

  return null;
}

/** Load and cache the allowlist. Re-reads if the file has changed. */
export function getAllowedExecutables(): Set<string> {
  const configPath = resolveConfigPath();
  if (!configPath) return new Set();

  try {
    const mtime = fs.statSync(configPath).mtimeMs;
    if (_cache && mtime === _lastMtime) return _cache;

    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as AllowlistConfig;
    const entries = Array.isArray(parsed.allowedExecutables) ? parsed.allowedExecutables : [];

    _cache = new Set(
      entries.map((e) => path.basename(e).toLowerCase())
        .concat(entries.map((e) => path.normalize(e).toLowerCase()))
    );
    _lastMtime = mtime;
    return _cache;
  } catch {
    return _cache ?? new Set();
  }
}

/** Return true if this command is explicitly allowlisted by the user config. */
export function isExecutableAllowlisted(command: string): boolean {
  const allowed = getAllowedExecutables();
  if (allowed.size === 0) return false;
  const basename = path.basename(command).toLowerCase();
  const normalized = path.normalize(command).toLowerCase();
  return allowed.has(basename) || allowed.has(normalized);
}
