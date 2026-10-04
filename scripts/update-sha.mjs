/**
 * update-sha.mjs — set one release zip's SHA256 in bin/launcher.js RELEASE_MANIFEST.sha256.
 *
 * Usage: node scripts/update-sha.mjs <asset-name> <64-hex-sha256>
 *   e.g. node scripts/update-sha.mjs desktop-touch-mcp-windows.zip 3f…
 *
 * The manifest holds one entry per release zip (Windows, and macOS Apple Silicon since the Mac
 * port). Guards: exits 1 unless that asset's entry is "PENDING" — or already this hash, which is
 * an idempotent success for CI re-runs — so a real hash is never overwritten.
 *
 * Called by the npm-publish CI job after computing each release zip's SHA256.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcherFile = join(root, "bin", "launcher.js");

const [asset, sha] = process.argv.slice(2);
if (!asset || !/^[\w.-]+\.zip$/.test(asset) || !sha || !/^[a-f0-9]{64}$/i.test(sha)) {
  console.error("[update-sha] Usage: node scripts/update-sha.mjs <asset-name.zip> <64-hex-sha256>");
  process.exit(1);
}

const key = JSON.stringify(asset);
const PENDING_MARKER = `${key}: "PENDING"`;
const TARGET = `${key}: "${sha.toLowerCase()}"`;
const content = readFileSync(launcherFile, "utf8");

if (content.includes(TARGET)) {
  console.log(`[update-sha] ${asset} already set to ${sha.toLowerCase()}`);
  process.exit(0);
}

if (!content.includes(PENDING_MARKER)) {
  console.error(`[update-sha] bin/launcher.js does not contain ${PENDING_MARKER} — aborting to avoid overwrite.`);
  process.exit(1);
}

writeFileSync(launcherFile, content.replace(PENDING_MARKER, TARGET), "utf8");
console.log(`[update-sha] ${asset} → ${sha.toLowerCase()}`);
