/**
 * sync-version.mjs — keep version constants in sync with package.json version.
 *
 * Called automatically by the `npm version` lifecycle hook ("version" script).
 * Can also be run manually: `npm run sync-version`
 *
 * Why: `npm version X.Y.Z --no-git-tag-version` only updates package.json.
 * This script propagates the change to src/version.ts and bin/launcher.js
 * so the MCP server and npm launcher stay aligned.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg  = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const versionFile = join(root, "src", "version.ts");
const launcherFile = join(root, "bin", "launcher.js");

function syncFile(filePath, pattern, replacement) {
  const current = readFileSync(filePath, "utf8");
  if (!pattern.test(current)) {
    throw new Error(`[sync-version] Pattern not found in ${relative(root, filePath)}`);
  }
  const updated = current.replace(pattern, replacement);

  if (current !== updated) {
    writeFileSync(filePath, updated, "utf8");
    console.log(`[sync-version] ${relative(root, filePath)} updated to ${pkg.version}`);
  } else {
    console.log(`[sync-version] ${relative(root, filePath)} already at ${pkg.version}`);
  }
}

syncFile(
  versionFile,
  /SERVER_VERSION = "[^"]+"/,
  `SERVER_VERSION = "${pkg.version}"`
);
syncFile(
  launcherFile,
  /const PACKAGE_VERSION = "[^"]+";/,
  `const PACKAGE_VERSION = "${pkg.version}";`
);
