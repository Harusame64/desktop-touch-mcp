#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PACKAGE_VERSION = "1.15.0";
const RELEASE_TAG = `v${PACKAGE_VERSION}`;
const REPO_API_URL = `https://api.github.com/repos/Harusame64/desktop-touch-mcp/releases/tags/${RELEASE_TAG}`;
const ASSET_NAME = "desktop-touch-mcp-windows.zip";
const RELEASE_METADATA_FILE = ".desktop-touch-release.json";
const RELEASE_MANIFEST = {
  tagName: "v1.15.0",
  assetName: ASSET_NAME,
  sha256: "PENDING",
};
const CACHE_ROOT = process.env.DESKTOP_TOUCH_MCP_HOME
  ? path.resolve(process.env.DESKTOP_TOUCH_MCP_HOME)
  : path.join(os.homedir(), ".desktop-touch-mcp");
const RELEASES_DIR = path.join(CACHE_ROOT, "releases");
const CURRENT_FILE = path.join(CACHE_ROOT, "current.json");

function log(message) {
  console.error(`[desktop-touch-mcp] ${message}`);
}

function warn(message) {
  console.error(`[desktop-touch-mcp] WARNING: ${message}`);
}

function fail(message) {
  console.error(`[desktop-touch-mcp] ${message}`);
  process.exit(1);
}

/**
 * Opt-in escape hatch for running the launcher from a source tree whose
 * RELEASE_MANIFEST.sha256 is still the "PENDING" placeholder (i.e. the
 * release workflow has not finalized the manifest). Published npm packages
 * always ship a real SHA256, so end users never need this.
 */
function allowUnverifiedRelease() {
  return process.env.DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED === "1";
}

/**
 * Opt-in escape hatch for offline-first startup. When enabled, the launcher
 * may run an already-installed release without re-verification, and may fall
 * back to any cached release when the release fetch fails. The default
 * (flag unset) keeps the fail-closed contract: a release directory is only
 * executed after its SHA256/metadata check passes.
 */
function offlineFallbackEnabled() {
  return process.env.DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK === "1";
}

/**
 * Reads the GitHub token from the environment.
 * Supports both GITHUB_TOKEN (GitHub Actions standard) and GH_TOKEN (gh CLI).
 */
function getGitHubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

/**
 * Returns headers for GitHub API and release download requests.
 * Includes Authorization when a token is available to avoid rate limits.
 */
function getGitHubHeaders(extra = {}) {
  const headers = {
    "User-Agent": "desktop-touch-mcp-launcher",
    ...extra,
  };
  const token = getGitHubToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export function isDisconnectError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}

export function wireLauncherStdio(child, options = {}) {
  const parentStdin = options.parentStdin ?? process.stdin;
  const parentStdout = options.parentStdout ?? process.stdout;
  const parentStderr = options.parentStderr ?? process.stderr;
  const shutdownGraceMs = options.shutdownGraceMs ?? 1000;
  const startupGraceMs = options.startupGraceMs ?? 10000;
  const spawnedAtMs = Date.now();

  let shutdownRequested = false;
  let forcedShutdownTimer = null;

  function clearForcedShutdownTimer() {
    if (forcedShutdownTimer !== null) {
      clearTimeout(forcedShutdownTimer);
      forcedShutdownTimer = null;
    }
  }

  function requestChildShutdown() {
    if (shutdownRequested) return;
    shutdownRequested = true;
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    // Forced-shutdown deadline: max(spawn + startupGraceMs, now + shutdownGraceMs).
    // The runtime needs ~1.3s (measured on v1.14.3) just to load its native
    // addons before it can parse its CLI, and it emits stderr diagnostics
    // DURING that load — so neither stdin-EOF timing nor "has it produced
    // output yet" is a readiness signal. Every child therefore gets the
    // full startup ceiling measured from spawn; once that has passed, EOF
    // gives the normal grace, exactly as before this fix.
    const delayMs = Math.max(
      startupGraceMs - (Date.now() - spawnedAtMs),
      shutdownGraceMs
    );
    forcedShutdownTimer = setTimeout(() => {
      forcedShutdownTimer = null;
      if (child.exitCode === null && !child.killed) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }, delayMs);
    if (forcedShutdownTimer.unref) forcedShutdownTimer.unref();
  }

  function terminateChild() {
    clearForcedShutdownTimer();
    if (child.exitCode === null && !child.killed) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }

  parentStdin.pipe(child.stdin);
  child.stdout?.pipe(parentStdout);
  child.stderr?.pipe(parentStderr);

  parentStdin.on("end", requestChildShutdown);
  parentStdin.on("close", requestChildShutdown);
  parentStdin.on("error", requestChildShutdown);

  const onParentOutputError = (error) => {
    if (isDisconnectError(error)) {
      terminateChild();
    }
  };
  parentStdout.on("error", onParentOutputError);
  parentStderr.on("error", onParentOutputError);

  child.stdin?.on("error", (error) => {
    if (!isDisconnectError(error)) throw error;
  });
  child.on("exit", clearForcedShutdownTimer);
}

function tagToDirName(tagName) {
  const safe = String(tagName || "latest").replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "latest";
}

function releaseDirForTag(tagName) {
  return path.join(RELEASES_DIR, tagToDirName(tagName));
}

function releaseMetadataPath(releaseDir) {
  return path.join(releaseDir, RELEASE_METADATA_FILE);
}

function expectedReleaseSpec() {
  if (RELEASE_MANIFEST.tagName !== RELEASE_TAG) {
    throw new Error(
      `Release manifest mismatch: PACKAGE_VERSION=${PACKAGE_VERSION}, manifest=${RELEASE_MANIFEST.tagName}`
    );
  }
  if (!RELEASE_MANIFEST.sha256 || RELEASE_MANIFEST.assetName !== ASSET_NAME) {
    throw new Error(`Missing release manifest for ${RELEASE_TAG}`);
  }
  // "PENDING" is the pre-release placeholder set in source. The release
  // workflow (scripts/update-sha.mjs) replaces it with the real zip SHA256
  // before npm publish, so a PENDING manifest at runtime means this launcher
  // was not finalized — fail closed by default so an accidentally published
  // launcher can never silently run an unverified runtime zip. Developers
  // running straight from source can opt in to skipping verification with
  // DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED=1.
  const isPending = RELEASE_MANIFEST.sha256 === "PENDING";
  if (isPending && !allowUnverifiedRelease()) {
    throw new Error(
      `Release SHA256 manifest for ${RELEASE_TAG} is PENDING — this launcher was not finalized by the release workflow. ` +
      `Published npm packages always ship a real SHA256. If you are intentionally running the launcher from source, ` +
      `set DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED=1 to skip integrity verification (development only).`
    );
  }
  if (!isPending && !/^[a-f0-9]{64}$/i.test(RELEASE_MANIFEST.sha256)) {
    throw new Error(`Invalid release SHA256 manifest for ${RELEASE_TAG}`);
  }
  return {
    tagName: RELEASE_MANIFEST.tagName,
    assetName: RELEASE_MANIFEST.assetName,
    sha256: isPending ? null : String(RELEASE_MANIFEST.sha256).toLowerCase(),
    sha256Pending: isPending,
  };
}

async function readReleaseMetadata(releaseDir) {
  try {
    const raw = await readFile(releaseMetadataPath(releaseDir), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function isInstalled(releaseDir, expected) {
  if (!existsSync(path.join(releaseDir, "dist", "index.js"))) return false;
  const metadata = await readReleaseMetadata(releaseDir);
  if (!metadata) return false;
  if (metadata.tagName !== expected.tagName || metadata.assetName !== expected.assetName) return false;
  // Skip SHA256 check when the manifest is still PENDING.
  if (expected.sha256 !== null) {
    if (String(metadata.sha256 || "").toLowerCase() !== expected.sha256) return false;
  }
  return true;
}

async function readCurrentRelease(expected) {
  try {
    const raw = await readFile(CURRENT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.tagName !== "string") return null;
    if (parsed.tagName !== expected.tagName) return null;
    if (parsed.assetName !== expected.assetName) return null;
    if (expected.sha256 !== null && String(parsed.sha256 || "").toLowerCase() !== expected.sha256) return null;
    const releaseDir = releaseDirForTag(parsed.tagName);
    if (!(await isInstalled(releaseDir, expected))) return null;
    return { tagName: parsed.tagName, releaseDir };
  } catch {
    return null;
  }
}

async function writeReleaseMetadata(releaseDir, expected) {
  await writeFile(
    releaseMetadataPath(releaseDir),
    `${JSON.stringify({ ...expected, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

async function writeCurrentRelease(expected) {
  await mkdir(CACHE_ROOT, { recursive: true });
  await writeFile(
    CURRENT_FILE,
    `${JSON.stringify({ ...expected, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

async function fetchReleaseByTag(expected) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS ?? 15000));
  try {
    const response = await fetch(REPO_API_URL, {
      headers: getGitHubHeaders({
        "Accept": "application/vnd.github+json",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`GitHub Releases API returned ${response.status} ${response.statusText} for ${expected.tagName}`);
    }

    const release = await response.json();
    const asset = Array.isArray(release.assets)
      ? release.assets.find((entry) => entry?.name === ASSET_NAME)
      : undefined;

    if (!release.tag_name || !asset?.browser_download_url) {
      throw new Error(`Release ${expected.tagName} does not contain ${ASSET_NAME}`);
    }

    const tagName = String(release.tag_name);
    if (!/^v\d+\.\d+\.\d+$/.test(tagName)) {
      throw new Error(`Unexpected tag format: ${tagName}`);
    }
    if (tagName !== expected.tagName) {
      throw new Error(`Unexpected tag: expected ${expected.tagName}, got ${tagName}`);
    }

    return {
      tagName,
      assetUrl: asset.browser_download_url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
  });
  return hash.digest("hex").toLowerCase();
}

async function verifySha256(filePath, expectedSha256) {
  const actual = await sha256File(filePath);
  const expected = String(expectedSha256).toLowerCase();
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${ASSET_NAME}: expected ${expected}, got ${actual}`);
  }
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: getGitHubHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Download failed with ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error("Download response did not include a body");
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const suffix = stderr ? `\n${stderr}` : "";
        error.message = `${error.message}${suffix}`;
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function expandZip(zipPath, destination) {
  const script = "& { param($zip, $dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force }";
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, zipPath, destination];

  try {
    await run("powershell.exe", args);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await run("pwsh.exe", ["-NoLogo", ...args]);
  }
}

async function findExtractedRoot(extractDir) {
  if (existsSync(path.join(extractDir, "dist", "index.js"))) return extractDir;

  const entries = await readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractDir, entry.name);
    if (existsSync(path.join(candidate, "dist", "index.js"))) return candidate;
  }

  throw new Error("Release zip did not contain dist/index.js");
}

async function installRelease(release, expected) {
  await mkdir(RELEASES_DIR, { recursive: true });

  const targetDir = releaseDirForTag(release.tagName);
  const tempDir = await mkdtemp(path.join(CACHE_ROOT, "download-"));
  const zipPath = path.join(tempDir, ASSET_NAME);
  const extractDir = path.join(tempDir, "extract");

  try {
    log(`Downloading ${ASSET_NAME} from ${release.tagName}`);
    await downloadFile(release.assetUrl, zipPath);
    if (expected.sha256 !== null) {
      await verifySha256(zipPath, expected.sha256);
    } else {
      warn("SHA256 manifest is PENDING and DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED=1 is set — " +
           "skipping integrity verification of the downloaded zip. Development use only.");
    }
    await mkdir(extractDir, { recursive: true });
    await expandZip(zipPath, extractDir);

    const extractedRoot = await findExtractedRoot(extractDir);
    await rm(targetDir, { recursive: true, force: true });
    await rename(extractedRoot, targetDir);
    await writeReleaseMetadata(targetDir, expected);
    await writeCurrentRelease(expected);
    log(`Installed ${release.tagName} to ${targetDir}`);
    return targetDir;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function ensureRelease() {
  const expected = expectedReleaseSpec();
  const targetDir = releaseDirForTag(expected.tagName);
  if (await isInstalled(targetDir, expected)) {
    await writeCurrentRelease(expected);
    return targetDir;
  }

  const current = await readCurrentRelease(expected);
  if (current) {
    return current.releaseDir;
  }

  // Offline-first (opt-in): the release may already exist on disk even if the
  // metadata/SHA256 check above failed (e.g. an interrupted earlier install).
  // Prefer it over a network round-trip that can hang on flaky GitHub access
  // and stall MCP startup far past host timeouts (DSH's mcp-client blocks
  // plugin activation on connection.ready - a launcher that waits minutes on
  // fetchReleaseByTag bricks the whole host startup). Gated behind
  // DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1 to preserve the fail-closed default.
  if (offlineFallbackEnabled() && existsSync(path.join(targetDir, "dist", "index.js"))) {
    warn(`${expected.tagName} exists but release metadata check failed - using local copy without re-verification (DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1)`);
    await writeCurrentRelease(expected);
    return targetDir;
  }

  let release;
  try {
    release = await fetchReleaseByTag(expected);
  } catch (error) {
    // Network unreachable/unresponsive: do NOT hard-fail here. If any prior
    // version is cached, keep serving it so the host does not time out.
    // Gated: default behavior still raises (fail-closed).
    if (offlineFallbackEnabled()) {
      warn(`Release fetch failed (${error?.message ?? String(error)}); falling back to any locally cached release (DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1)`);
      const cached = await scanInstalledReleases();
      if (cached) {
        return cached;
      }
    }
    throw error;
  }

  return installRelease(release, expected);
}

/** Finds any release dir whose dist/index.js exists, newest tag first. */
async function scanInstalledReleases() {
  let entries;
  try {
    entries = await readdir(RELEASES_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const dirName of dirs) {
    const dir = path.join(RELEASES_DIR, dirName);
    if (existsSync(path.join(dir, "dist", "index.js"))) {
      return dir;
    }
  }
  return null;
}

function launchServer(releaseDir) {
  const entry = path.join(releaseDir, "dist", "index.js");
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: releaseDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });

  wireLauncherStdio(child);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.on("error", (error) => {
    fail(`Failed to start release runtime: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function main() {
  if (process.platform !== "win32") {
    fail("The npm launcher currently installs the Windows release build only.");
  }

  const releaseDir = await ensureRelease();
  launchServer(releaseDir);
}

const launchedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
})();

if (launchedAsScript) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
