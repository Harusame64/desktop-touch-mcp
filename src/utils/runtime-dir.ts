import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolve the desktop-touch-mcp runtime root directory (pure: no filesystem access).
 *
 * Default: `%USERPROFILE%\.desktop-touch-mcp` (Windows) / `~/.desktop-touch-mcp`,
 * matching the npm launcher install dir and the existing per-feature caches
 * (ui-pattern-store, macro-outcome-store, model-registry, diagnostic-log).
 *
 * Override: `DESKTOP_TOUCH_MCP_HOME`. An override *redefines* the trust boundary,
 * so it is resolved to an absolute path here; callers that use the result as a
 * containment anchor for untrusted reads/deletes must additionally canonicalize
 * it with `fs.realpathSync` before binding paths to it (ADR-026 §4).
 *
 * Kept as a pure env→path resolver so it can be unit-tested without touching the
 * filesystem or racing on process.env; use {@link ensureDir} for the side effect.
 */
export function getRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["DESKTOP_TOUCH_MCP_HOME"];
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".desktop-touch-mcp");
}

/** Create `dir` (recursive) if missing; returns the same path. Side-effecting. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
