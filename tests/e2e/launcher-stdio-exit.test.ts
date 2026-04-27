import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { eventually, sleep } from "./helpers/wait.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const launcherPath = path.resolve(repoRoot, "bin/launcher.js");

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

function track(proc: ChildProcess): ChildProcess {
  spawned.push(proc);
  return proc;
}

async function loadLauncherManifest(): Promise<{ version: string; tagName: string; assetName: string; sha256: string }> {
  const source = await readFile(launcherPath, "utf8");
  const version = source.match(/const PACKAGE_VERSION = "([^"]+)";/)?.[1];
  const tagName = source.match(/tagName: "(v[^"]+)"/)?.[1];
  const assetName = source.match(/const ASSET_NAME = "([^"]+)";/)?.[1];
  const sha256 = source.match(/sha256: "([a-f0-9]{64})"/i)?.[1];
  if (!version || !tagName || !assetName || !sha256) {
    throw new Error("Failed to parse launcher release manifest");
  }
  return { version, tagName, assetName, sha256: sha256.toLowerCase() };
}

async function setupFakeRelease(): Promise<{
  cacheRoot: string;
  runtimePidFile: string;
  runtimeLogFile: string;
}> {
  const manifest = await loadLauncherManifest();
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "desktop-touch-launcher-e2e-"));
  tempDirs.push(cacheRoot);

  const releaseDir = path.join(cacheRoot, "releases", manifest.tagName);
  const distDir = path.join(releaseDir, "dist");
  await mkdir(distDir, { recursive: true });

  const runtimePidFile = path.join(cacheRoot, "runtime.pid");
  const runtimeLogFile = path.join(cacheRoot, "runtime.log");
  const runtimeScript = `
import { appendFileSync, writeFileSync } from "node:fs";

const pidFile = process.env.TEST_RUNTIME_PID_FILE;
const logFile = process.env.TEST_RUNTIME_LOG_FILE;
if (!pidFile || !logFile) throw new Error("missing test runtime env");

writeFileSync(pidFile, String(process.pid), "utf8");
appendFileSync(logFile, "START\\n", "utf8");

process.stdin.resume();
process.stdin.on("end", () => {
  appendFileSync(logFile, "STDIN_END\\n", "utf8");
});

const hold = setInterval(() => {}, 1000);

process.on("SIGTERM", () => {
  appendFileSync(logFile, "SIGTERM\\n", "utf8");
  clearInterval(hold);
  process.exit(0);
});
`;
  await writeFile(path.join(distDir, "index.js"), runtimeScript, "utf8");

  const metadata = {
    tagName: manifest.tagName,
    assetName: manifest.assetName,
    sha256: manifest.sha256,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(releaseDir, ".desktop-touch-release.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeFile(path.join(cacheRoot, "current.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  return { cacheRoot, runtimePidFile, runtimeLogFile };
}

async function readRuntimePid(pidFile: string): Promise<number> {
  const raw = await eventually(
    async () => {
      if (!existsSync(pidFile)) return null;
      const text = (await readFile(pidFile, "utf8")).trim();
      return text.length > 0 ? text : null;
    },
    { timeoutMs: 5_000, intervalMs: 100, label: "runtime pid file" }
  );
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Invalid runtime pid: ${raw}`);
  }
  return pid;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (proc.exitCode !== null) {
    return { code: proc.exitCode, signal: proc.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process ${proc.pid ?? "unknown"} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

afterEach(async () => {
  for (const proc of spawned.splice(0)) {
    if (proc.exitCode === null && !proc.killed) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      await sleep(100);
      if (proc.exitCode === null && !proc.killed) {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// Skip when the launcher manifest still has the pre-release "PENDING" placeholder.
// Real sha256 is filled in by the release pipeline (`npm run update-sha`); the test
// can only run against a finalized launcher.
const LAUNCHER_HAS_RELEASE_SHA = (() => {
  try {
    return /sha256: "[a-f0-9]{64}"/i.test(readFileSync(launcherPath, "utf8"));
  } catch {
    return false;
  }
})();

describe.skipIf(!LAUNCHER_HAS_RELEASE_SHA)("launcher stdio shutdown", () => {
  it("reaps the spawned runtime when the caller closes stdin", async () => {
    const { cacheRoot, runtimePidFile, runtimeLogFile } = await setupFakeRelease();
    const stderrChunks: string[] = [];
    const launcher = track(spawn(process.execPath, [launcherPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DESKTOP_TOUCH_MCP_HOME: cacheRoot,
        TEST_RUNTIME_PID_FILE: runtimePidFile,
        TEST_RUNTIME_LOG_FILE: runtimeLogFile,
      },
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    }));
    launcher.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    const runtimePid = await readRuntimePid(runtimePidFile);
    expect(isProcessAlive(runtimePid)).toBe(true);

    launcher.stdin?.end();

    const exit = await waitForExit(launcher, 5_000);
    expect(exit.signal === null || exit.signal === "SIGTERM").toBe(true);
    expect(exit.code === 0 || exit.code === 1).toBe(true);

    await eventually(
      async () => (isProcessAlive(runtimePid) ? null : true),
      { timeoutMs: 5_000, intervalMs: 100, label: "runtime exit" }
    );

    const runtimeLog = await readFile(runtimeLogFile, "utf8");
    expect(runtimeLog).toContain("START");
    expect(runtimeLog).toContain("STDIN_END");

    const launcherStderr = stderrChunks.join("");
    expect(launcherStderr).not.toContain("Failed to start release runtime");
  });
});
