/**
 * desktop-config.ts — Runtime configuration for desktop-touch-mcp.
 *
 * Config file (first found wins):
 *   1. Path in env var DESKTOP_TOUCH_CONFIG
 *   2. ~/.claude/desktop-touch-config.json
 *   3. <server script dir>/desktop-touch-config.json
 *
 * Format:
 * {
 *   "cdpPort": 9333
 * }
 *
 * Note: config is read once at module load time. Restart the server to pick up changes.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

interface DesktopTouchConfig {
  cdpPort?: number;
}

const _serverDir = path.dirname(fileURLToPath(import.meta.url));

function resolveConfigPath(): string | null {
  const fromEnv = process.env["DESKTOP_TOUCH_CONFIG"];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const fromHome = path.join(os.homedir(), ".claude", "desktop-touch-config.json");
  if (fs.existsSync(fromHome)) return fromHome;

  const fromDir = path.join(_serverDir, "desktop-touch-config.json");
  if (fs.existsSync(fromDir)) return fromDir;

  return null;
}

function loadConfig(): DesktopTouchConfig {
  const configPath = resolveConfigPath();
  if (!configPath) return {};

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as DesktopTouchConfig;
  } catch (err) {
    console.error(`[desktop-touch] Failed to read config from ${configPath}: ${String(err)}`);
    return {};
  }
}

/** Return the configured CDP port, or 9222 if not set. */
export function getCdpPort(): number {
  const config = loadConfig();
  if (typeof config.cdpPort === "number" && Number.isInteger(config.cdpPort) && config.cdpPort > 0 && config.cdpPort <= 65535) {
    return config.cdpPort;
  }
  if (config.cdpPort !== undefined) {
    console.error(`[desktop-touch] Invalid cdpPort value in config: ${JSON.stringify(config.cdpPort)} — using default 9222`);
  }
  return 9222;
}
