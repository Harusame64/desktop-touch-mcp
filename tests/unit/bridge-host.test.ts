// ADR-014 v2 S1 — unit tests for the cooperative-terminal bridge (Node/MCP side).
//
// S1 is headless and the node-side security is the secret pipe name + the fail-loud
// liveness abort in start() + the helper's kernel client-verify — NOT an identity
// assertion on `hello` (see bridge-host.ts header). So the deterministic unit layer
// here is the CLIENT WIRE PROTOCOL against a Node fake peer standing in for
// bin/bridge-host.exe: hello parse, ping/version round-trip, malformed-hello reject,
// dispose. The real-process stack (spawn, kernel client-verify, fail-loud) is the
// gated e2e smoke.

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { BridgeHost } from "../../src/engine/bridge-host.js";

function pipePath(): string {
  return `\\\\.\\pipe\\dtm-bridge-test-${randomBytes(8).toString("hex")}`;
}

/**
 * A Node stand-in for the C# helper: writes a `hello` frame on connect, then
 * answers ping/version/shutdown. `reportPid` is the pid it self-reports.
 */
function makeFakePeer(
  path: string,
  opts: { reportPid?: number; firstFrame?: string; protocol?: string },
): net.Server {
  const proto = opts.protocol ?? "1";
  const reportPid = opts.reportPid ?? 4242;
  const server = net.createServer((sock) => {
    let buf = "";
    const write = (o: unknown) => sock.write(JSON.stringify(o) + "\n");
    const first = opts.firstFrame ?? JSON.stringify({ t: "hello", pid: reportPid, v: proto });
    sock.write(first + "\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line) as { id: number; m: string };
        if (req.m === "ping") write({ id: req.id, ok: true, r: "pong" });
        else if (req.m === "version") write({ id: req.id, ok: true, r: proto });
        else if (req.m === "shutdown") write({ id: req.id, ok: true, r: "bye" });
        else write({ id: req.id, ok: false, r: "", e: "unknown" });
      }
    });
    sock.on("error", () => { /* client may drop */ });
  });
  return server;
}

describe("BridgeHost client protocol (fake peer)", () => {
  const servers: net.Server[] = [];
  const bridges: BridgeHost[] = [];

  afterEach(async () => {
    for (const b of bridges) { try { await b.dispose(); } catch { /* ignore */ } }
    bridges.length = 0;
    for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
    servers.length = 0;
  });

  async function listen(server: net.Server, path: string): Promise<void> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
  }

  it("handshakes, reports helperPid + version, pings and reports version", async () => {
    const path = pipePath();
    const reportPid = 424_242;
    await listen(makeFakePeer(path, { reportPid }), path);

    const bridge = await BridgeHost.connectForTest(path);
    bridges.push(bridge);

    expect(bridge.helperPid).toBe(reportPid);
    expect(bridge.protocolVersion).toBe("1");
    expect(await bridge.ping()).toBe(true);
    expect(await bridge.version()).toBe("1");
  });

  it("matches concurrent requests to their replies by id", async () => {
    const path = pipePath();
    await listen(makeFakePeer(path, {}), path);
    const bridge = await BridgeHost.connectForTest(path);
    bridges.push(bridge);

    const [p, v] = await Promise.all([bridge.ping(), bridge.version()]);
    expect(p).toBe(true);
    expect(v).toBe("1");
  });

  it("rejects a peer whose first frame is not a well-formed hello", async () => {
    const path = pipePath();
    await listen(
      makeFakePeer(path, { firstFrame: JSON.stringify({ id: 1, ok: true, r: "nope" }) }),
      path,
    );
    await expect(BridgeHost.connectForTest(path)).rejects.toThrow(/unexpected first frame/);
  });

  it("rejects a peer whose first frame is unparseable", async () => {
    const path = pipePath();
    await listen(makeFakePeer(path, { firstFrame: "{not json" }), path);
    await expect(BridgeHost.connectForTest(path)).rejects.toThrow(/unparseable hello/);
  });

  it("fails pending requests after dispose", async () => {
    const path = pipePath();
    await listen(makeFakePeer(path, {}), path);
    const bridge = await BridgeHost.connectForTest(path);
    await bridge.dispose();
    await expect(bridge.ping()).rejects.toThrow(/disposed/);
  });
});
