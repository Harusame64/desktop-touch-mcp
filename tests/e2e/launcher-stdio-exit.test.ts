import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  const sha256 = source.match(/sha256: "([a-f0-9]{64}|PENDING)"/)?.[1];
  if (!version || !tagName || !assetName || !sha256) {
    throw new Error("Failed to parse launcher release manifest");
  }
  return { version, tagName, assetName, sha256: sha256 === "PENDING" ? sha256 : sha256.toLowerCase() };
}

async function setupFakeRelease(runtimeScriptOverride?: string): Promise<{
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
  // The launcher's forced-shutdown deadline is max(spawn + 10s startup window,
  // EOF + 1s grace), so stdin EOF can never force a stop before the window has
  // passed. The default fixture therefore exits on stdin EOF like the real
  // runtime does, which ends the run early and well inside the reap test's wait;
  // the forced-SIGTERM path is pinned at unit level by the timer tests. The
  // stderr banner just mimics the real runtime's startup output and no longer
  // affects any timing decision.
  const runtimeScript = runtimeScriptOverride ?? `
import { appendFileSync, writeFileSync } from "node:fs";

const pidFile = process.env.TEST_RUNTIME_PID_FILE;
const logFile = process.env.TEST_RUNTIME_LOG_FILE;
if (!pidFile || !logFile) throw new Error("missing test runtime env");

process.stderr.write("runtime ready\\n");
writeFileSync(pidFile, String(process.pid), "utf8");
appendFileSync(logFile, "START\\n", "utf8");

process.stdin.resume();
process.stdin.on("end", () => {
  appendFileSync(logFile, "STDIN_END\\n", "utf8");
  clearInterval(hold);
  process.exit(0);
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

// The launcher accepts a PENDING sha256 manifest when
// DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED=1 (sha verification is skipped), so this
// suite runs both on a development tree (sha256: "PENDING") and on a
// release-finalized launcher (real sha embedded by the release workflow).
// Windows-only: bin/launcher.js exits 1 at its process.platform !== "win32"
// guard before ever spawning the fake runtime, so on any other host both
// tests would fail for a reason unrelated to what they pin.
describe.skipIf(process.platform !== "win32")("launcher stdio shutdown", () => {
  it("reaps the spawned runtime when the caller closes stdin", async () => {
    const { cacheRoot, runtimePidFile, runtimeLogFile } = await setupFakeRelease();
    const stderrChunks: string[] = [];
    const launcher = track(spawn(process.execPath, [launcherPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DESKTOP_TOUCH_MCP_HOME: cacheRoot,
        DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED: "1",
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

    // The runtime exits on stdin EOF of its own accord, so the whole run ends
    // well inside this wait — no forced SIGTERM is involved.
    const exit = await waitForExit(launcher, 5_000);
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);

    await eventually(
      async () => (isProcessAlive(runtimePid) ? null : true),
      { timeoutMs: 5_000, intervalMs: 100, label: "runtime exit" }
    );

    const runtimeLog = await readFile(runtimeLogFile, "utf8");
    expect(runtimeLog).toContain("START");
    expect(runtimeLog).toContain("STDIN_END");
    expect(runtimeLog).not.toContain("SIGTERM");

    const launcherStderr = stderrChunks.join("");
    expect(launcherStderr).not.toContain("Failed to start release runtime");
  });

  it("does not kill a slow-starting runtime when stdin is closed at spawn", async () => {
    const slowHelpRuntime = `
import { appendFileSync, writeFileSync } from "node:fs";

const pidFile = process.env.TEST_RUNTIME_PID_FILE;
const logFile = process.env.TEST_RUNTIME_LOG_FILE;
if (!pidFile || !logFile) throw new Error("missing test runtime env");

writeFileSync(pidFile, String(process.pid), "utf8");
appendFileSync(logFile, "START\\n", "utf8");

process.on("SIGTERM", () => {
  appendFileSync(logFile, "SIGTERM\\n", "utf8");
  process.exit(1);
});

setTimeout(() => {
  process.stdout.write("USAGE\\n");
  appendFileSync(logFile, "HELP_DONE\\n", "utf8");
  process.exit(0);
}, 2000);
`;
    const { cacheRoot, runtimePidFile, runtimeLogFile } = await setupFakeRelease(slowHelpRuntime);
    const launcher = track(spawn(process.execPath, [launcherPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DESKTOP_TOUCH_MCP_HOME: cacheRoot,
        DESKTOP_TOUCH_MCP_ALLOW_UNVERIFIED: "1",
        TEST_RUNTIME_PID_FILE: runtimePidFile,
        TEST_RUNTIME_LOG_FILE: runtimeLogFile,
      },
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    }));

    // Reproduce the closed-at-spawn shape: EOF reaches the launcher before
    // the runtime has produced its first byte (the runtime here stays
    // silent for 2s — longer than the normal 1s shutdown grace).
    launcher.stdin?.end();

    const exit = await waitForExit(launcher, 15_000);
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);

    const runtimeLog = await readFile(runtimeLogFile, "utf8");
    expect(runtimeLog).toContain("HELP_DONE");
    expect(runtimeLog).not.toContain("SIGTERM");
  });
});
