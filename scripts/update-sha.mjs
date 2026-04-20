/**
 * update-sha.mjs — update RELEASE_MANIFEST.sha256 in bin/launcher.js.
 *
 * Usage: node scripts/update-sha.mjs <64-hex-sha256>
 *
 * Guards: exits 1 if the current value is not "PENDING", preventing
 * accidental overwrite when a real hash is already present.
 *
 * Called by the npm-publish CI job after computing the release zip SHA256.
 * Can also be run manually if needed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcherFile = join(root, "bin", "launcher.js");

const sha = process.argv[2];
if (!sha || !/^[a-f0-9]{64}$/i.test(sha)) {
  console.error(
    "[update-sha] Usage: node scripts/update-sha.mjs <64-hex-sha256>"
  );
  process.exit(1);
}

const PENDING_MARKER = 'sha256: "PENDING"';
const TARGET = `sha256: "${sha.toLowerCase()}"`;
const content = readFileSync(launcherFile, "utf8");

if (content.includes(TARGET)) {
  // Already set to the correct hash — idempotent success (handles CI re-runs).
  console.log(`[update-sha] bin/launcher.js sha256 already set to ${sha.toLowerCase()}`);
  process.exit(0);
}

if (!content.includes(PENDING_MARKER)) {
  console.error(
    `[update-sha] bin/launcher.js does not contain ${PENDING_MARKER} — aborting to avoid overwrite.`
  );
  process.exit(1);
}

const updated = content.replace(PENDING_MARKER, TARGET);
writeFileSync(launcherFile, updated, "utf8");
console.log(`[update-sha] bin/launcher.js sha256 → ${sha.toLowerCase()}`);
