/**
 * bridge-host.e2e.test.ts — ADR-014 v2 S1 live smoke + negative (headless).
 *
 * Spawns the REAL bin/bridge-host.exe (direct, detached, headless — no window in
 * S1), so it is gated to the e2e project. Validates the launch-independent locked
 * contract end to end: direct-spawn -> C# CurrentUserOnly server -> kernel
 * client-verify (GetNamedPipeClientProcessId == our pid) -> hello -> ping/version.
 * The window + crux (a) are S2. The pure protocol is covered deterministically by
 * tests/unit/bridge-host.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { BridgeHost } from "../../src/engine/bridge-host.js";

const HELPER_EXE = join(process.cwd(), "bin", "bridge-host.exe");

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
  afterEach(() => {
    if (child?.pid) {
      try { spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
      catch { /* ignore */ }
    }
    child = undefined;
  });

  it("rejects a client whose PID != the helper's -McpPid", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);

    // Launch the real helper DIRECTLY (as production does) but tell it a DIFFERENT
    // process is its MCP. Our connect (this process's pid) must be rejected by the
    // C# kernel client-verify, so we never receive a `hello` frame. (Direct-spawn,
    // not conhost, so the helper actually runs — a conhost launch would exit and
    // give a false pass.)
    const name = `dtm-bridge-rogue-${randomBytes(8).toString("hex")}`;
    const wrongMcpPid = process.pid + 100_000; // definitely not us
    child = spawn(HELPER_EXE, ["-PipeName", name, "-McpPid", String(wrongMcpPid)], {
      detached: true, stdio: "ignore", windowsHide: false,
    });

    const gotHello = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };

      const tryConnect = (attempt: number) => {
        const sock = net.connect(`\\\\.\\pipe\\${name}`);
        sock.once("connect", () => {
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

    expect(gotHello).toBe(false);
  }, 40_000);
});
