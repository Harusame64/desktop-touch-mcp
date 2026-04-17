/**
 * sync-version.mjs — keep src/version.ts in sync with package.json version.
 *
 * Called automatically by the `npm version` lifecycle hook ("version" script).
 * Can also be run manually: `npm run sync-version`
 *
 * Why: `npm version X.Y.Z --no-git-tag-version` only updates package.json.
 * This script propagates the change to src/version.ts so the MCP server
 * reports the correct version at runtime (tray icon, serverInfo, etc.).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg  = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const versionFile = join(root, "src", "version.ts");

const current = readFileSync(versionFile, "utf8");
const updated  = current.replace(
  /SERVER_VERSION = "[^"]+"/,
  `SERVER_VERSION = "${pkg.version}"`
);

if (current !== updated) {
  writeFileSync(versionFile, updated, "utf8");
  console.log(`[sync-version] src/version.ts updated to ${pkg.version}`);
} else {
  console.log(`[sync-version] src/version.ts already at ${pkg.version}`);
}
