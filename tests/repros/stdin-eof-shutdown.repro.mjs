// Repro: does desktop-touch-mcp server exit when stdin EOF arrives?
// Spawns dist/index.js directly (bypassing launcher), completes MCP `initialize`,
// then closes stdin and observes:
//   - whether the server logs "stdin closed — parent exited"
//   - whether the process exits and with what code
//   - how long it takes
//
// Two scenarios:
//   A) close stdin RIGHT AFTER initialize    → baseline, no in-flight tool
//   B) close stdin WHILE a tool call is in-flight → matches the log pattern
//
// Run from repo root:  node tests/repros/stdin-eof-shutdown.repro.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const distEntry = path.join(repoRoot, "dist", "index.js");

function spawnServer() {
  const proc = spawn(process.execPath, [distEntry], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, DESKTOP_TOUCH_DISABLE_TRAY: "1" },
  });
  const stderrLines = [];
  const stdoutLines = [];
  proc.stderr.setEncoding("utf8");
  proc.stdout.setEncoding("utf8");
  let stderrBuf = "";
  let stdoutBuf = "";
  proc.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
    let idx;
    while ((idx = stderrBuf.indexOf("\n")) >= 0) {
      stderrLines.push(stderrBuf.slice(0, idx));
      stderrBuf = stderrBuf.slice(idx + 1);
    }
  });
  proc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      stdoutLines.push(stdoutBuf.slice(0, idx));
      stdoutBuf = stdoutBuf.slice(idx + 1);
    }
  });
  return { proc, stderrLines, stdoutLines };
}

function send(proc, msg) {
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function waitForStdoutLine(stdoutLines, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const found = stdoutLines.find((l) => {
        try { return predicate(JSON.parse(l)); } catch { return false; }
      });
      if (found) {
        clearInterval(tick);
        resolve(JSON.parse(found));
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timeout waiting for stdout line after ${timeoutMs}ms`));
      }
    }, 50);
  });
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) return resolve({ code: proc.exitCode, signal: proc.signalCode, ms: 0 });
    const t0 = Date.now();
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - t0 });
    });
  });
}

async function scenarioA() {
  console.log("\n== Scenario A: close stdin immediately after initialize ==");
  const { proc, stderrLines, stdoutLines } = spawnServer();
  // wait for "MCP server running (stdio)"
  await new Promise((r) => {
    const tick = setInterval(() => {
      if (stderrLines.some((l) => l.includes("MCP server running"))) { clearInterval(tick); r(); }
    }, 50);
  });
  console.log("  server started");
  send(proc, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "repro", version: "0" } },
  });
  await waitForStdoutLine(stdoutLines, (m) => m.id === 1 && m.result, 10_000);
  console.log("  initialize done, closing stdin...");
  proc.stdin.end();
  const exit = await waitForExit(proc, 5_000);
  console.log(`  exit: code=${exit.code} signal=${exit.signal} after ${exit.ms}ms`);
  const sawShutdownMsg = stderrLines.some((l) => l.includes("stdin closed — parent exited"));
  console.log(`  stderr saw "stdin closed — parent exited": ${sawShutdownMsg}`);
  return { exit, sawShutdownMsg };
}

async function scenarioB() {
  console.log("\n== Scenario B: close stdin WHILE a tool call is in-flight ==");
  const { proc, stderrLines, stdoutLines } = spawnServer();
  await new Promise((r) => {
    const tick = setInterval(() => {
      if (stderrLines.some((l) => l.includes("MCP server running"))) { clearInterval(tick); r(); }
    }, 50);
  });
  console.log("  server started");
  send(proc, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "repro", version: "0" } },
  });
  await waitForStdoutLine(stdoutLines, (m) => m.id === 1 && m.result, 10_000);
  send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

  // Fire a long-running wait_until(quiet) call so the server is genuinely
  // mid-polling when we close stdin.
  console.log("  firing wait_until(window_appears) with 10s timeout — guaranteed in-flight...");
  send(proc, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: {
      name: "wait_until",
      arguments: {
        condition: "window_appears",
        target: { windowTitle: "ZZZZ-no-such-window-ZZZZ" },
        timeoutMs: 10_000,
        intervalMs: 200,
      },
    },
  });

  // Wait 1 second so the server is mid-poll, then close stdin
  await new Promise((r) => setTimeout(r, 1000));
  console.log("  closing stdin while tool is in-flight...");
  proc.stdin.end();

  const exit = await waitForExit(proc, 8_000);
  console.log(`  exit: code=${exit.code} signal=${exit.signal} after ${exit.ms}ms`);
  const sawShutdownMsg = stderrLines.some((l) => l.includes("stdin closed — parent exited"));
  const sawShutdownGeneric = stderrLines.some((l) => l.includes("Shutting down"));
  console.log(`  stderr saw "stdin closed — parent exited": ${sawShutdownMsg}`);
  console.log(`  stderr saw "Shutting down": ${sawShutdownGeneric}`);
  // Did the in-flight call return a response?
  const got2 = stdoutLines.find((l) => { try { return JSON.parse(l).id === 2; } catch { return false; } });
  console.log(`  in-flight tool call response received: ${got2 ? "YES" : "NO (silent kill)"}`);
  return { exit, sawShutdownMsg };
}

(async () => {
  try {
    const a = await scenarioA();
    const b = await scenarioB();
    console.log("\n== Summary ==");
    console.log(`A: exit code=${a.exit.code} after ${a.exit.ms}ms; shutdown msg: ${a.sawShutdownMsg}`);
    console.log(`B: exit code=${b.exit.code} after ${b.exit.ms}ms; shutdown msg: ${b.sawShutdownMsg}`);
    process.exit(0);
  } catch (e) {
    console.error("repro failed:", e);
    process.exit(1);
  }
})();
