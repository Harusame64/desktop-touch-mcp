/**
 * bridge-host.e2e.test.ts — ADR-014 v2 S1 live smoke + negatives (headless).
 *
 * Spawns the REAL bin/bridge-host.exe (direct, detached, headless — no window in
 * S1), so it is gated to the e2e project. Validates the launch-independent locked
 * contract end to end: direct-spawn -> C# CurrentUserOnly server -> kernel
 * client-verify (GetNamedPipeClientProcessId == our pid) -> hello -> ping/version,
 * plus the two load-bearing negatives (rogue client rejected; FIRST_PIPE_INSTANCE
 * fail-loud). The window + crux (a) are S2. The pure protocol is covered
 * deterministically by tests/unit/bridge-host.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { BridgeHost } from "../../src/engine/bridge-host.js";

const HELPER_EXE = join(process.cwd(), "bin", "bridge-host.exe");

function killTree(pid?: number): void {
  if (pid === undefined) return;
  try { spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
  catch { /* ignore */ }
}

describe("bridge-host live smoke", () => {
  const bridges: BridgeHost[] = [];
  afterEach(async () => {
    for (const b of bridges) { try { await b.dispose(); } catch { /* ignore */ } }
    bridges.length = 0;
  });

  it("spawns the real headless helper, handshakes, pings and reports version", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);

    const bridge = await BridgeHost.start({ startupTimeoutMs: 20_000 });
    bridges.push(bridge);

    expect(bridge.helperPid).toBeGreaterThan(0);
    expect(bridge.protocolVersion).toBe("1");
    expect(await bridge.ping()).toBe(true);
    expect(await bridge.version()).toBe("1");
  }, 40_000);
});

describe("bridge-host rogue client rejection (kernel client-verify)", () => {
  let child: ChildProcess | undefined;
  afterEach(() => { killTree(child?.pid); child = undefined; });

  it("rejects a client whose PID != the helper's -McpPid", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);

    // Launch the real helper DIRECTLY (as production does) but tell it a DIFFERENT
    // process is its MCP. Our connect (this process's pid) must be rejected by the
    // C# kernel client-verify, so we CONNECT but never receive a `hello`.
    const name = `dtm-bridge-rogue-${randomBytes(8).toString("hex")}`;
    const wrongMcpPid = process.pid + 100_000; // definitely not us
    child = spawn(HELPER_EXE, ["-PipeName", name, "-McpPid", String(wrongMcpPid)], {
      detached: true, stdio: "ignore", windowsHide: false,
    });

    const result = await new Promise<{ connected: boolean; gotHello: boolean }>((resolve) => {
      let settled = false;
      let connected = false;
      const done = (gotHello: boolean) => { if (!settled) { settled = true; resolve({ connected, gotHello }); } };

      const tryConnect = (attempt: number) => {
        const sock = net.connect(`\\\\.\\pipe\\${name}`);
        sock.once("connect", () => {
          connected = true; // the pipe was up — the helper IS running
          sock.on("data", (d) => { if (d.toString("utf8").includes('"hello"')) { sock.destroy(); done(true); } });
          sock.on("close", () => done(false)); // helper disconnected us (rejected)
          setTimeout(() => { sock.destroy(); done(false); }, 4_000);
        });
        sock.once("error", () => {
          sock.destroy();
          if (attempt < 40) setTimeout(() => tryConnect(attempt + 1), 200); // pipe not up yet
          else done(false);
        });
      };
      tryConnect(0);
    });

    // The assertion that makes this a REAL client-verify test (not a false pass from
    // the helper never starting): we must have actually connected, then been rejected
    // (closed) WITHOUT a hello.
    expect(result.connected).toBe(true);
    expect(result.gotHello).toBe(false);
  }, 40_000);
});

describe("bridge-host FIRST_PIPE_INSTANCE fail-loud", () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const c of kids) killTree(c.pid); kids.length = 0; });

  it("a second helper on the same pipe name fails loud and exits non-zero", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const name = `dtm-bridge-fpi-${randomBytes(8).toString("hex")}`;
    const mcp = String(process.pid);

    // A creates the CurrentUserOnly server (holds the name) and waits for a client.
    const a = spawn(HELPER_EXE, ["-PipeName", name, "-McpPid", mcp], {
      detached: true, stdio: "ignore", windowsHide: false,
    });
    kids.push(a);

    // Poll (no fixed sleep → no AV-cold-start flake) until A's pipe accepts a
    // connection = the name is registered; KEEP the probe open so A stays alive
    // holding the name while B races. (We are A's McpPid, so A verifies + keeps us.)
    const probe = await new Promise<net.Socket>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const tryIt = () => {
        const s = net.connect(`\\\\.\\pipe\\${name}`);
        s.once("connect", () => resolve(s));
        s.once("error", () => {
          s.destroy();
          if (Date.now() < deadline) setTimeout(tryIt, 150);
          else reject(new Error("helper A never registered its pipe"));
        });
      };
      tryIt();
    });

    try {
      // B tries the SAME name → FILE_FLAG_FIRST_PIPE_INSTANCE (maxInstances=1) makes
      // its create fail → the helper exits 3 (pipe-create-failed), never attaching.
      const bExit = await new Promise<number | null>((resolve) => {
        const b = spawn(HELPER_EXE, ["-PipeName", name, "-McpPid", mcp], {
          detached: true, stdio: "ignore", windowsHide: false,
        });
        kids.push(b);
        b.on("exit", (code) => resolve(code));
        setTimeout(() => resolve(-999), 12_000);
      });
      expect(bExit).toBe(3);
    } finally {
      probe.destroy();
    }
  }, 40_000);
});
