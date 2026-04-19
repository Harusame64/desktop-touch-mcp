import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const launcher = readFileSync(join(root, "bin", "launcher.js"), "utf8");

const packageVersionMatch = launcher.match(/const PACKAGE_VERSION = "([^"]+)";/);
const manifestTagMatch = launcher.match(/tagName: "(v[^"]+)",/);
const manifestShaMatch = launcher.match(/sha256: "([a-fA-F0-9]+)",/);

if (!packageVersionMatch || !manifestTagMatch || !manifestShaMatch) {
  throw new Error("[check-launcher-manifest] Could not find PACKAGE_VERSION/tagName/sha256 in bin/launcher.js");
}

const launcherVersion = packageVersionMatch[1];
const manifestTag = manifestTagMatch[1];
const manifestSha = manifestShaMatch[1];
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
if (!/^[a-f0-9]{64}$/i.test(manifestSha)) {
  throw new Error("[check-launcher-manifest] RELEASE_MANIFEST.sha256 must be 64 hex characters");
}

console.log(`[check-launcher-manifest] OK for ${pkg.version} (${manifestTag})`);
