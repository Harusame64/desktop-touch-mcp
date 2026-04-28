import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const distEntry = path.join(repoRoot, "dist", "index.js");

interface SpawnedServer {
  proc: ChildProcess;
  stderrLines: string[];
  stdoutLines: string[];
}

const tracked: ChildProcess[] = [];

function spawnServer(): SpawnedServer {
  const proc = spawn(process.execPath, [distEntry], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, DESKTOP_TOUCH_DISABLE_TRAY: "1" },
  });
  tracked.push(proc);
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];
  proc.stderr!.setEncoding("utf8");
  proc.stdout!.setEncoding("utf8");
  let stderrBuf = "";
  let stdoutBuf = "";
  proc.stderr!.on("data", (chunk: string) => {
    stderrBuf += chunk;
    let idx;
    while ((idx = stderrBuf.indexOf("\n")) >= 0) {
      stderrLines.push(stderrBuf.slice(0, idx));
      stderrBuf = stderrBuf.slice(idx + 1);
    }
  });
  proc.stdout!.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      stdoutLines.push(stdoutBuf.slice(0, idx));
      stdoutBuf = stdoutBuf.slice(idx + 1);
    }
  });
  return { proc, stderrLines, stdoutLines };
}

function sendRpc(proc: ChildProcess, msg: unknown): void {
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

async function waitFor<T>(predicate: () => T | null | undefined, timeoutMs: number, label: string): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = predicate();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

async function waitForExit(
  proc: ChildProcess,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }> {
  if (proc.exitCode !== null) return { code: proc.exitCode, signal: proc.signalCode, ms: 0 };
  const t0 = Date.now();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - t0 });
    });
  });
}

afterEach(async () => {
  for (const proc of tracked.splice(0)) {
    if (proc.exitCode === null && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 100));
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  }
});

describe("server-windows stdio EOF (issue #68)", () => {
  it("Scenario A: closes cleanly when stdin closes with no in-flight tool call", async () => {
    const { proc, stderrLines, stdoutLines } = spawnServer();
    await waitFor(
      () => stderrLines.some((l) => l.includes("MCP server running (stdio)")),
      10_000,
      "server start"
    );

    sendRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    await waitFor(
      () =>
        stdoutLines.some((l) => {
          try {
            const m = JSON.parse(l);
            return m.id === 1 && m.result;
          } catch {
            return false;
          }
        }),
      10_000,
      "initialize response"
    );

    proc.stdin!.end();
    const exit = await waitForExit(proc, 5_000);

    expect(exit.code).toBe(0);
    // Should NOT defer (no in-flight) — message must be the prompt non-deferred shutdown.
    const stderr = stderrLines.join("\n");
    expect(stderr).toContain("stdin closed — parent exited");
    expect(stderr).not.toContain("deferring shutdown");
    expect(stderr).toContain("Shutting down...");
  }, 20_000);

  it("Scenario B: defers shutdown until in-flight tool call drains, response is delivered", async () => {
    const { proc, stderrLines, stdoutLines } = spawnServer();
    await waitFor(
      () => stderrLines.some((l) => l.includes("MCP server running (stdio)")),
      10_000,
      "server start"
    );

    sendRpc(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    await waitFor(
      () =>
        stdoutLines.some((l) => {
          try {
            return JSON.parse(l).id === 1;
          } catch {
            return false;
          }
        }),
      10_000,
      "initialize response"
    );
    sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

    // Fire a wait_until that is guaranteed to take ~5s (window will never appear).
    // Generous timeoutMs so even on a slow Windows CI runner the call is still
    // genuinely in-flight when we close stdin.
    sendRpc(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "wait_until",
        arguments: {
          condition: "window_appears",
          target: { windowTitle: "ZZZZ-no-such-window-issue68-ZZZZ" },
          timeoutMs: 5_000,
          intervalMs: 100,
        },
      },
    });

    // Let the tool start polling, then close stdin mid-flight. 1500ms gives
    // even slow CI runners ~15 polling iterations before stdin closes, so the
    // "tool is in-flight when EOF arrives" precondition is robust.
    await new Promise((r) => setTimeout(r, 1500));
    proc.stdin!.end();

    // The server must NOT exit before the response arrives.
    const got2 = await waitFor(
      () =>
        stdoutLines.find((l) => {
          try {
            return JSON.parse(l).id === 2;
          } catch {
            return false;
          }
        }) ?? null,
      10_000,
      "in-flight tool response"
    );
    expect(got2).toBeTruthy();

    const exit = await waitForExit(proc, 12_000);
    expect(exit.code).toBe(0);

    const stderr = stderrLines.join("\n");
    expect(stderr).toContain("deferring shutdown");
    expect(stderr).toContain("in-flight requests drained");
    expect(stderr).toContain("Shutting down...");
  }, 30_000);
});
