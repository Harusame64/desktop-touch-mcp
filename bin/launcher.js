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
import { Readable, Transform } from "node:stream";
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

const DEFAULT_FETCH_TIMEOUT_MS = 15000;

/**
 * Pure parser for DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS. Only a finite, positive
 * number of milliseconds is honoured: `Number("")` is 0 and a typo is NaN, and
 * setTimeout turns either into a ~1ms timer — so an empty or misspelled value
 * would otherwise abort every request before it could start.
 *
 * @returns {{ timeoutMs: number, invalidValue: string | null }} `invalidValue`
 *   is the offending raw value when the default had to be substituted.
 */
export function parseFetchTimeoutMs(raw) {
  if (raw === undefined || raw === null) {
    return { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, invalidValue: null };
  }
  const trimmed = String(raw).trim();
  if (trimmed === "") {
    return { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, invalidValue: "" };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, invalidValue: trimmed };
  }
  return { timeoutMs: parsed, invalidValue: null };
}

function fetchTimeoutMs() {
  const { timeoutMs, invalidValue } = parseFetchTimeoutMs(process.env.DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS);
  if (invalidValue !== null) {
    warn(`DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS=${JSON.stringify(invalidValue)} is not a positive number of milliseconds — using the ${DEFAULT_FETCH_TIMEOUT_MS}ms default.`);
  }
  return timeoutMs;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True only for "GitHub was unreachable" failures: an abort/stall timeout, a
 * transport-level fetch failure, or a socket error code. An HTTP 404, a 403
 * rate limit, a SHA256 mismatch and an unexpected tag are all answers from a
 * reachable server, so they return false and keep failing loudly.
 */
export function isNetworkClassError(error) {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (current.name === "AbortError" || current.name === "TimeoutError") return true;
    if (typeof current.code === "string" && NETWORK_ERROR_CODES.has(current.code)) return true;
    // undici reports transport failures as TypeError("fetch failed" / "terminated").
    if (current instanceof TypeError && /fetch failed|terminated|network|socket/i.test(String(current.message))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Arms an abort timer that fires when nothing has progressed for `timeoutMs`.
 * `reset()` restarts the countdown — a download calls it per chunk, so the
 * ceiling is "no bytes for timeoutMs" rather than a deadline for the whole
 * transfer, and a slow but progressing install is never cut off.
 */
function createStallTimeout(label, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const reason = new Error(`${label} timed out after ${timeoutMs}ms without progress (raise DESKTOP_TOUCH_MCP_FETCH_TIMEOUT_MS to wait longer)`);
      reason.name = "TimeoutError";
      controller.abort(reason);
    }, timeoutMs);
  };
  reset();
  return {
    signal: controller.signal,
    reset,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
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

export function expectedReleaseSpec() {
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
  const timeout = createStallTimeout("GitHub Releases API request", fetchTimeoutMs());
  try {
    const response = await fetch(REPO_API_URL, {
      headers: getGitHubHeaders({
        "Accept": "application/vnd.github+json",
      }),
      signal: timeout.signal,
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
  } catch (error) {
    // fetch rejects with its own AbortError; surface the reason we aborted for
    // instead, so the message names the timeout that actually fired.
    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) throw timeout.signal.reason;
    throw error;
  } finally {
    timeout.dispose();
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
  const timeout = createStallTimeout(`Download of ${ASSET_NAME}`, fetchTimeoutMs());
  try {
    const response = await fetch(url, {
      headers: getGitHubHeaders(),
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw new Error(`Download failed with ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("Download response did not include a body");
    }

    // Every chunk restarts the countdown: the zip may legitimately take minutes
    // on a thin connection, but a connection that stops delivering bytes must
    // not hold up startup forever.
    const heartbeat = new Transform({
      transform(chunk, _encoding, callback) {
        timeout.reset();
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      heartbeat,
      createWriteStream(destination),
      { signal: timeout.signal }
    );
  } catch (error) {
    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) throw timeout.signal.reason;
    throw error;
  } finally {
    timeout.dispose();
  }
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

export async function ensureRelease() {
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

  // GitHub is always tried first - bounded by the stall timeout, so a reachable
  // network still re-installs over a broken tree and the self-heal is intact.
  // Only when that attempt fails because the network was unusable may the
  // opt-in offline fallback answer instead.
  let release;
  try {
    release = await fetchReleaseByTag(expected);
  } catch (error) {
    const fallback = await resolveOfflineFallback(expected, targetDir, error);
    if (fallback) return fallback;
    throw error;
  }

  try {
    return await installRelease(release, expected);
  } catch (error) {
    // A stalled download aborts here rather than in fetchReleaseByTag; a SHA256
    // mismatch also lands here and is deliberately not network-class, so a
    // tampered zip still fails loudly instead of booting a cached release.
    const fallback = await resolveOfflineFallback(expected, targetDir, error);
    if (fallback) return fallback;
    throw error;
  }
}

/**
 * Opt-in last resort for hosts that abort startup on a slow launcher
 * (DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1). Returns a release directory to run,
 * or null when the fallback is off, the failure was not network-class, or
 * nothing usable is installed - in which case the caller rethrows.
 *
 * The expected tag's own directory is accepted without re-verification (it is
 * the version this launcher was built for, typically an interrupted install).
 * Any *other* tag would be a silent downgrade, so it must carry the metadata
 * marker that only a completed verified install writes.
 */
async function resolveOfflineFallback(expected, targetDir, error) {
  if (!offlineFallbackEnabled()) return null;
  if (!isNetworkClassError(error)) return null;

  const detail = error?.message ?? String(error);
  if (existsSync(path.join(targetDir, "dist", "index.js"))) {
    warn(`Could not reach GitHub (${detail}) - starting the already installed ${expected.tagName} without re-verification (DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1).`);
    return targetDir;
  }

  const cached = await findCachedRelease(expected);
  if (cached) {
    warn(`Could not reach GitHub (${detail}) and ${expected.tagName} is not installed - starting the cached ${cached.tagName} instead (DESKTOP_TOUCH_MCP_OFFLINE_FALLBACK=1).`);
    return cached.releaseDir;
  }
  return null;
}

/** Parses "v1.2.3" into a comparable tuple, or null when it is not a release tag. */
function parseTagVersion(tagName) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tagName ?? ""));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Orders release tags numerically: v1.10.0 > v1.9.10 > v1.9.9. */
export function compareTagVersions(a, b) {
  const left = parseTagVersion(a);
  const right = parseTagVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * True when a release directory carries the marker that installRelease writes
 * only after a successful verify then rename, and that marker names this very
 * directory. A directory with no metadata is an interrupted or hand-made
 * install and is never eligible as a fallback for a different version.
 */
async function isVerifiedInstall(releaseDir, tagName) {
  if (!existsSync(path.join(releaseDir, "dist", "index.js"))) return false;
  const metadata = await readReleaseMetadata(releaseDir);
  if (!metadata) return false;
  if (metadata.tagName !== tagName) return false;
  if (metadata.assetName !== ASSET_NAME) return false;
  if (/^[a-f0-9]{64}$/i.test(String(metadata.sha256 ?? ""))) return true;
  // A PENDING-manifest install was never hash-checked, so it only counts while
  // the same development opt-in that created it is still set.
  return metadata.sha256Pending === true && allowUnverifiedRelease();
}

/** Newest verified install at or below the expected tag, or null. */
async function findCachedRelease(expected) {
  let entries;
  try {
    entries = await readdir(RELEASES_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => parseTagVersion(name) !== null)
    .filter((name) => compareTagVersions(name, expected.tagName) <= 0)
    .sort((a, b) => compareTagVersions(b, a));
  for (const tagName of candidates) {
    const releaseDir = path.join(RELEASES_DIR, tagName);
    if (await isVerifiedInstall(releaseDir, tagName)) {
      return { tagName, releaseDir };
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
