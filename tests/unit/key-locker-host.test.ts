// ADR-014 v2 R3 Key Locker — unit tests for the Node/MCP client (KeyLockerHost).
//
// L0's node-side security is the secret pipe name + the fail-loud liveness abort in start() +
// the C# server's kernel client-verify — NOT an identity assertion on `hello` (see
// key-locker-host.ts header). So the deterministic unit layer here is the CLIENT WIRE PROTOCOL
// against a Node fake peer standing in for bin/key-locker.exe: hello parse, ping / version /
// exists / delete / capture round-trip, malformed-hello reject, protocol-version reject, dispose.
// The real-process stack (spawn, kernel client-verify, FIRST_PIPE fail-loud, DPAPI) is the gated
// e2e (tests/e2e/key-locker.e2e.test.ts). The SECRET NEVER CROSSES THIS PIPE — `capture` returns
// only {captured, rt}, which this suite asserts.

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { KeyLockerHost } from "../../src/engine/key-locker-host.js";

function pipePath(): string {
  return `\\\\.\\pipe\\dtm-locker-test-${randomBytes(8).toString("hex")}`;
}

interface FakeState { store: Set<string>; captureReply: { captured: boolean; rt: boolean }; lastFrames: string[]; }

/**
 * A Node stand-in for the C# locker: writes a `hello` frame on connect, then answers the L0
 * control verbs. `captured` opts control what a `capture` returns (the fake never opens a GUI).
 */
function makeFakeLocker(
  path: string,
  opts: {
    reportPid?: number;
    firstFrame?: string;
    protocol?: string;
    seed?: string[];
    captureReply?: { captured: boolean; rt: boolean };
    state?: FakeState;
  } = {},
): net.Server {
  const proto = opts.protocol ?? "1";
  const reportPid = opts.reportPid ?? 4343;
  const state = opts.state ?? { store: new Set(opts.seed ?? []), captureReply: opts.captureReply ?? { captured: true, rt: true }, lastFrames: [] };
  return net.createServer((sock) => {
    let buf = "";
    const write = (o: unknown) => sock.write(JSON.stringify(o) + "\n");
    sock.write((opts.firstFrame ?? JSON.stringify({ t: "hello", pid: reportPid, v: proto })) + "\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        state.lastFrames.push(line);
        const req = JSON.parse(line) as { id: number; m: string; k?: string };
        switch (req.m) {
          case "ping": write({ id: req.id, ok: true, r: "pong" }); break;
          case "version": write({ id: req.id, ok: true, r: proto }); break;
          case "exists": write({ id: req.id, ok: true, r: state.store.has(req.k ?? "") ? "1" : "0" }); break;
          case "delete": { const had = state.store.delete(req.k ?? ""); write({ id: req.id, ok: true, r: had ? "1" : "0" }); break; }
          case "capture": {
            const { captured, rt } = state.captureReply;
            if (captured) state.store.add(req.k ?? "");
            // The fake mirrors the C# reply shape: r is EMPTY, secret NEVER appears on the wire.
            write({ id: req.id, ok: true, r: "", captured, rt });
            break;
          }
          case "shutdown": write({ id: req.id, ok: true, r: "bye" }); break;
          default: write({ id: req.id, ok: false, r: "", e: `unknown_method:${req.m}` });
        }
      }
    });
    sock.on("error", () => { /* client may drop */ });
  });
}

describe("KeyLockerHost client protocol (fake peer)", () => {
  const servers: net.Server[] = [];
  const hosts: KeyLockerHost[] = [];

  afterEach(async () => {
    for (const h of hosts) { try { await h.dispose(); } catch { /* ignore */ } }
    hosts.length = 0;
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
    await listen(makeFakeLocker(path, { reportPid: 515_151 }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    expect(host.helperPid).toBe(515_151);
    expect(host.protocolVersion).toBe("1");
    expect(await host.ping()).toBe(true);
    expect(await host.version()).toBe("1");
  });

  it("exists() reflects the store; delete() removes", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(["ssh:host"]), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    expect(await host.exists("ssh:host")).toBe(true);
    expect(await host.exists("nope")).toBe(false);
    expect(await host.delete("ssh:host")).toBe(true);
    expect(await host.exists("ssh:host")).toBe(false);
    expect(await host.delete("ssh:host")).toBe(false); // already gone
  });

  it("capture() returns {captured, rt} and the secret never crosses the pipe", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    const r = await host.capture("ssh:example.com");
    expect(r).toEqual({ captured: true, rt: true });
    expect(await host.exists("ssh:example.com")).toBe(true);
    // The client sends only {id, m, k} — the request frame carries the opaque KEY, never a secret.
    const captureFrame = state.lastFrames.find((f) => f.includes('"capture"'));
    expect(captureFrame).toBeDefined();
    const parsed = JSON.parse(captureFrame!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["id", "k", "m"]);
    expect(parsed.k).toBe("ssh:example.com");
  });

  it("capture() reports a cancelled dialog as {captured:false}", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { captureReply: { captured: false, rt: false } }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    const r = await host.capture("ssh:cancel");
    expect(r).toEqual({ captured: false, rt: false });
  });

  it("matches concurrent requests to their replies by id", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { seed: ["a"] }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    const [p, v, e] = await Promise.all([host.ping(), host.version(), host.exists("a")]);
    expect(p).toBe(true);
    expect(v).toBe("1");
    expect(e).toBe(true);
  });

  it("rejects a peer whose first frame is not a well-formed hello", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { firstFrame: JSON.stringify({ id: 1, ok: true, r: "nope" }) }), path);
    await expect(KeyLockerHost.connectForTest(path)).rejects.toThrow(/unexpected first frame/);
  });

  it("rejects a peer whose first frame is unparseable", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { firstFrame: "{not json" }), path);
    await expect(KeyLockerHost.connectForTest(path)).rejects.toThrow(/unparseable hello/);
  });

  it("rejects a locker whose protocol version does not match", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { protocol: "2" }), path);
    await expect(KeyLockerHost.connectForTest(path)).rejects.toThrow(/protocol '2' != expected '1'/);
  });

  it("fails pending requests after dispose", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, {}), path);
    const host = await KeyLockerHost.connectForTest(path);
    await host.dispose();
    await expect(host.ping()).rejects.toThrow(/disposed/);
  });

  it("sends a graceful shutdown frame on dispose (not just force-kill)", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state }), path);
    const host = await KeyLockerHost.connectForTest(path);
    await host.dispose();
    expect(state.lastFrames.some((f) => f.includes('"shutdown"'))).toBe(true);
  });
});
