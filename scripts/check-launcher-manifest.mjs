import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const launcher = readFileSync(join(root, "bin", "launcher.js"), "utf8");

const packageVersionMatch = launcher.match(/const PACKAGE_VERSION = "([^"]+)";/);
const manifestTagMatch = launcher.match(/tagName: "(v[^"]+)",/);
// One SHA256 per release zip (Mac port): both must be finalized before a publish.
const ASSETS = ["desktop-touch-mcp-windows.zip", "desktop-touch-mcp-macos-arm64.zip"];
const shaFor = (asset) => launcher.match(new RegExp(`${JSON.stringify(asset).replace(/[.]/g, "\\.")}: "([^"]+)"`))?.[1];

if (!packageVersionMatch || !manifestTagMatch || ASSETS.some((a) => shaFor(a) === undefined)) {
  throw new Error(`[check-launcher-manifest] Could not find PACKAGE_VERSION/tagName/sha256 (${ASSETS.join(", ")}) in bin/launcher.js`);
}

const launcherVersion = packageVersionMatch[1];
const manifestTag = manifestTagMatch[1];
const expectedTag = `v${pkg.version}`;

if (launcherVersion !== pkg.version) {
  throw new Error(
    `[check-launcher-manifest] PACKAGE_VERSION mismatch: package.json=${pkg.version}, launcher=${launcherVersion}`
  );
}
if (manifestTag !== expectedTag) {
  throw new Error(
    `[check-launcher-manifest] tagName mismatch: expected ${expectedTag}, got ${manifestTag}. Update RELEASE_MANIFEST.tagName and sha256.`
  );
}
for (const asset of ASSETS) {
  if (!/^[a-f0-9]{64}$/i.test(shaFor(asset))) {
    throw new Error(`[check-launcher-manifest] RELEASE_MANIFEST.sha256["${asset}"] must be 64 hex characters`);
  }
}

console.log(`[check-launcher-manifest] OK for ${pkg.version} (${manifestTag})`);
