#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const REPO_API_URL = "https://api.github.com/repos/Harusame64/desktop-touch-mcp/releases/latest";
const ASSET_NAME = "desktop-touch-mcp-windows.zip";
const CACHE_ROOT = process.env.DESKTOP_TOUCH_MCP_HOME
  ? path.resolve(process.env.DESKTOP_TOUCH_MCP_HOME)
  : path.join(os.homedir(), ".desktop-touch-mcp");
const RELEASES_DIR = path.join(CACHE_ROOT, "releases");
const CURRENT_FILE = path.join(CACHE_ROOT, "current.json");

function log(message) {
  console.error(`[desktop-touch-mcp] ${message}`);
}

function fail(message) {
  console.error(`[desktop-touch-mcp] ${message}`);
  process.exit(1);
}

function tagToDirName(tagName) {
  const safe = String(tagName || "latest").replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "latest";
}

function releaseDirForTag(tagName) {
  return path.join(RELEASES_DIR, tagToDirName(tagName));
}

async function isInstalled(releaseDir) {
  return existsSync(path.join(releaseDir, "dist", "index.js"));
}

async function readCurrentRelease() {
  try {
    const raw = await readFile(CURRENT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.tagName !== "string") return null;
    const releaseDir = releaseDirForTag(parsed.tagName);
    if (!(await isInstalled(releaseDir))) return null;
    return { tagName: parsed.tagName, releaseDir };
  } catch {
    return null;
  }
}

async function writeCurrentRelease(tagName) {
  await mkdir(CACHE_ROOT, { recursive: true });
  await writeFile(
    CURRENT_FILE,
    `${JSON.stringify({ tagName, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

async function fetchLatestRelease() {
  const response = await fetch(REPO_API_URL, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "desktop-touch-mcp-launcher",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub Releases API returned ${response.status} ${response.statusText}`);
  }

  const release = await response.json();
  const asset = Array.isArray(release.assets)
    ? release.assets.find((entry) => entry?.name === ASSET_NAME)
    : undefined;

  if (!release.tag_name || !asset?.browser_download_url) {
    throw new Error(`Latest release does not contain ${ASSET_NAME}`);
  }

  const tagName = String(release.tag_name);
  if (!/^v\d+\.\d+\.\d+$/.test(tagName)) {
    throw new Error(`Unexpected tag format: ${tagName}`);
  }

  return {
    tagName,
    assetUrl: asset.browser_download_url,
  };
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "desktop-touch-mcp-launcher",
    },
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
  if (await isInstalled(extractDir)) return extractDir;

  const entries = await readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractDir, entry.name);
    if (await isInstalled(candidate)) return candidate;
  }

  throw new Error("Release zip did not contain dist/index.js");
}

async function installRelease(release) {
  await mkdir(RELEASES_DIR, { recursive: true });

  const targetDir = releaseDirForTag(release.tagName);
  const tempDir = await mkdtemp(path.join(CACHE_ROOT, "download-"));
  const zipPath = path.join(tempDir, ASSET_NAME);
  const extractDir = path.join(tempDir, "extract");

  try {
    log(`Downloading ${ASSET_NAME} from ${release.tagName}`);
    await downloadFile(release.assetUrl, zipPath);
    await mkdir(extractDir, { recursive: true });
    await expandZip(zipPath, extractDir);

    const extractedRoot = await findExtractedRoot(extractDir);
    await rm(targetDir, { recursive: true, force: true });
    await rename(extractedRoot, targetDir);
    await writeCurrentRelease(release.tagName);
    log(`Installed ${release.tagName} to ${targetDir}`);
    return targetDir;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function ensureRelease() {
  const current = await readCurrentRelease();

  let latest;
  try {
    latest = await fetchLatestRelease();
  } catch (error) {
    if (current) {
      log(`Could not check GitHub Releases; using cached ${current.tagName}`);
      return current.releaseDir;
    }
    throw error;
  }

  const targetDir = releaseDirForTag(latest.tagName);
  if (await isInstalled(targetDir)) {
    await writeCurrentRelease(latest.tagName);
    return targetDir;
  }

  return installRelease(latest);
}

function launchServer(releaseDir) {
  const entry = path.join(releaseDir, "dist", "index.js");
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: releaseDir,
    stdio: "inherit",
    windowsHide: false,
  });

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

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
