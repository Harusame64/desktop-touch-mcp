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
import { CAPTURE_TIMEOUT_MS, DIALOG_CLOSE_MS, KeyLockerHost, KEY_LOCKER_PROTOCOL_VERSION } from "../../src/engine/key-locker-host.js";

function pipePath(): string {
  return `\\\\.\\pipe\\dtm-locker-test-${randomBytes(8).toString("hex")}`;
}

interface FakeState { store: Set<string>; captureReply: { captured: boolean; rt: boolean; timedOut?: boolean }; lastFrames: string[]; }

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
    consoleEchoes?: boolean;
    otherReader?: boolean;
    selecting?: boolean;
    noProbe?: boolean;
    seed?: string[];
    captureReply?: { captured: boolean; rt: boolean; timedOut?: boolean };
    state?: FakeState;
    /** The `r` value the fake replies to a `prompt` verb (a raw choice string, or `__err__` for ok:false). */
    promptReply?: string;
  } = {},
): net.Server {
  const proto = opts.protocol ?? KEY_LOCKER_PROTOCOL_VERSION;
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
            const { captured, rt, timedOut } = state.captureReply;
            if (captured) state.store.add(req.k ?? "");
            // The fake mirrors the C# reply shape: r is EMPTY, secret NEVER appears on the wire.
            write({ id: req.id, ok: true, r: "", captured, rt, ...(timedOut === true ? { timedOut } : {}) });
            break;
          }
          case "prompt": {
            const reply = opts.promptReply ?? "autofill";
            if (reply === "__err__") write({ id: req.id, ok: false, r: "", e: "bad_prompt" });
            else write({ id: req.id, ok: true, r: reply }); // r = the choice; NO secret ever on the wire
            break;
          }
          case "probe": {
            // internal #335: the inject checks with no write; an older helper answers unknown_method.
            if (opts.noProbe === true) write({ id: req.id, ok: false, r: "", e: "unknown_method:probe" });
            else if (opts.selecting === true) write({ id: req.id, ok: false, r: "", e: "console_selecting" });
            else write({ id: req.id, ok: true, r: "" });
            break;
          }
          case "inject": {
            // Mirrors Injection.cs's fill_once gate: `requireEchoOff` and an echoing console → echo_on.
            const t = (req as unknown as { t?: { requireEchoOff?: boolean } }).t;
            // internal #335: selection mode is checked first, for every write.
            if (opts.selecting === true) write({ id: req.id, ok: false, r: "", e: "console_selecting" });
            else if (t?.requireEchoOff === true && opts.consoleEchoes === true) write({ id: req.id, ok: false, r: "", e: "echo_on" });
            // internal #333: another process on the console is waiting in a read.
            else if (t?.requireEchoOff === true && opts.otherReader === true) write({ id: req.id, ok: false, r: "", e: "other_reader" });
            else write({ id: req.id, ok: true, r: "", verified: true });
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
    expect(host.protocolVersion).toBe("3");
    expect(await host.ping()).toBe(true);
    expect(await host.version()).toBe("3");
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
    expect(Object.keys(parsed).sort()).toEqual(["deadline", "id", "k", "m"]);
    expect(parsed.k).toBe("ssh:example.com");
  });

  it("capture() with a dialog sends only the secret-free label / note / purpose beside the key (#277)", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    await host.capture("opaque-1", { label: "locker console 1234", note: "log in to the build box", purpose: "fill_once" });
    const parsed = JSON.parse(state.lastFrames.find((f) => f.includes('"capture"'))!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["deadline", "id", "k", "label", "m", "note", "purpose"]);
    expect(parsed).toMatchObject({ k: "opaque-1", label: "locker console 1234", note: "log in to the build box", purpose: "fill_once" });
  });

  it("inject() carries requireEchoOff on the wire, and echo_on comes back as itself, not executor_failed (#806)", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state, consoleEchoes: true }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    const target = { shellPid: 4321, shellStartMs: 10, submit: true };
    expect(await host.inject("op-1", target)).toEqual({ ok: true, verified: true }); // the loop's write: no gate
    expect(await host.inject("op-1", { ...target, requireEchoOff: true })).toEqual({ ok: false, code: "echo_on" });
    const frame = JSON.parse(state.lastFrames.filter((f) => f.includes('"inject"')).at(-1)!) as { t: Record<string, unknown> };
    expect(frame.t.requireEchoOff).toBe(true);
  });

  it("other_reader comes back as itself, not executor_failed (internal #333)", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state, otherReader: true }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    const target = { shellPid: 4321, shellStartMs: 10, submit: true, requireEchoOff: true };
    expect(await host.inject("op-1", target)).toEqual({ ok: false, code: "other_reader" });
  });

  it("probe() answers the inject checks with no key; an older helper without the verb passes (internal #335)", async () => {
    const target = { shellPid: 4321, shellStartMs: 10, submit: false, requireEchoOff: true };
    for (const [opts, want] of [
      [{ selecting: true }, { ok: false, code: "console_selecting" }],
      [{}, { ok: true }],
      [{ noProbe: true }, { ok: true }],
    ] as const) {
      const path = pipePath();
      const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
      await listen(makeFakeLocker(path, { state, ...opts }), path);
      const host = await KeyLockerHost.connectForTest(path);
      hosts.push(host);
      expect(await host.probe(target)).toEqual(want);
      const frame = JSON.parse(state.lastFrames.find((f) => f.includes('"probe"'))!) as Record<string, unknown>;
      expect(frame.k).toBeUndefined();
    }
  });

  it("console_selecting comes back as itself, for a fill_once and an autofill write alike (internal #335)", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { selecting: true }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    for (const requireEchoOff of [true, false]) {
      const target = { shellPid: 4321, shellStartMs: 10, submit: true, requireEchoOff };
      expect(await host.inject("op-1", target)).toEqual({ ok: false, code: "console_selecting" });
    }
  });

  it("capture() reports a cancelled dialog as {captured:false}", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { captureReply: { captured: false, rt: false } }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    const r = await host.capture("ssh:cancel");
    expect(r).toEqual({ captured: false, rt: false });
  });

  it("prompt('confirm') returns the choice; the frame carries only {kind,label} — NO key, NO secret (W-3.5)", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state, promptReply: "autofill" }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    expect(await host.prompt("confirm", "sudo://host-a")).toBe("autofill");
    const frame = state.lastFrames.find((f) => f.includes('"prompt"'));
    const parsed = JSON.parse(frame!) as Record<string, unknown>;
    // The wire carries {id, m, kind, label} — the LABEL (a display URI), never a key or secret.
    expect(Object.keys(parsed).sort()).toEqual(["deadline", "id", "kind", "label", "m"]);
    expect(parsed).toMatchObject({ m: "prompt", kind: "confirm", label: "sudo://host-a" });
    expect(parsed.k).toBeUndefined();
  });

  it("capture() carries a kept fill_once's tag beside label / note / purpose (internal #281)", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    await host.capture("opaque-2", { label: "locker console", note: "jump host", purpose: "fill_once", tag: "jump" });
    const parsed = JSON.parse(state.lastFrames.find((f) => f.includes('"capture"'))!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["deadline", "id", "k", "label", "m", "note", "purpose", "tag"]);
    expect(parsed.tag).toBe("jump");
  });

  it("confirmKeptFill() sends kind fill_kept with label / note / tag only (no key) and returns fill (internal #281)", async () => {
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state, promptReply: "fill" }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    expect(await host.confirmKeptFill({ label: "locker console", note: "jump host", tag: "jump" })).toBe("fill");
    const parsed = JSON.parse(state.lastFrames.find((f) => f.includes('"prompt"'))!) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["deadline", "id", "kind", "label", "m", "note", "tag"]);
    expect(parsed).toMatchObject({ kind: "fill_kept", tag: "jump" });
  });

  it("confirmKeptFill() returns fill_always when the user ticked 'always' (the dialog's checkbox)", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { promptReply: "fill_always" }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    expect(await host.confirmKeptFill({ label: "l", note: "n", tag: "t" })).toBe("fill_always");
  });

  it("every dialog frame carries a deadline the window closes by, inside the server's wait (review of #890)", async () => {
    expect(DIALOG_CLOSE_MS).toBeLessThan(CAPTURE_TIMEOUT_MS);
    const path = pipePath();
    const state: FakeState = { store: new Set(), captureReply: { captured: true, rt: true }, lastFrames: [] };
    await listen(makeFakeLocker(path, { state, promptReply: "fill" }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    const before = Date.now();
    await host.capture("op-1", { purpose: "fill_once" });
    await host.confirmKeptFill({ label: "l", note: "n", tag: "t" });
    await host.prompt("offer", "ssh://h");
    const after = Date.now();
    const deadlines = state.lastFrames
      .filter((f) => f.includes('"capture"') || f.includes('"prompt"'))
      .map((f) => (JSON.parse(f) as { deadline?: number }).deadline);
    expect(deadlines).toHaveLength(3);
    for (const d of deadlines) {
      expect(d).toBeGreaterThanOrEqual(before + DIALOG_CLOSE_MS);
      expect(d).toBeLessThanOrEqual(after + DIALOG_CLOSE_MS);
    }
  });

  it("capture() and confirmKeptFill() say when the dialog closed itself at its deadline (internal #338)", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { captureReply: { captured: false, rt: false, timedOut: true }, promptReply: "timed_out" }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    expect(await host.capture("op-1", { purpose: "fill_once" })).toEqual({ captured: false, rt: false, timedOut: true });
    expect(await host.confirmKeptFill({ label: "l", note: "n", tag: "t" })).toBe("timed_out");
  });

  it.each(["cancel", "__err__", "autofill", "save", "", "FILL_ALWAYS", "fill always"])("confirmKeptFill() FAILS CLOSED to cancel on reply %j", async (reply) => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { promptReply: reply }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    expect(await host.confirmKeptFill({ label: "l", note: "n", tag: "t" })).toBe("cancel");
  });

  it("confirmKeptFill() on a disposed host is cancel, and alive turns false", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, {}), path);
    const host = await KeyLockerHost.connectForTest(path);
    expect(host.alive).toBe(true);
    await host.dispose();
    expect(host.alive).toBe(false);
    expect(await host.confirmKeptFill({ label: "l", note: "n", tag: "t" })).toBe("cancel");
  });

  it("prompt('offer') returns a 3-way SaveChoice", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { promptReply: "never" }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    expect(await host.prompt("offer", "ssh://deploy@host-a")).toBe("never");
  });

  it("prompt() FAILS CLOSED on ok:false — confirm→type_it, offer→not_now", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { promptReply: "__err__" }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    expect(await host.prompt("confirm", "sudo://h")).toBe("type_it");
    expect(await host.prompt("offer", "sudo://h")).toBe("not_now");
  });

  it("prompt() FAILS CLOSED on an out-of-kind reply value (a confirm reply of 'save' is rejected)", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { promptReply: "save" }), path); // 'save' is an OFFER choice, invalid for confirm
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);
    expect(await host.prompt("confirm", "sudo://h")).toBe("type_it"); // not honored → fail-closed
  });

  it("matches concurrent requests to their replies by id", async () => {
    const path = pipePath();
    await listen(makeFakeLocker(path, { seed: ["a"] }), path);
    const host = await KeyLockerHost.connectForTest(path);
    hosts.push(host);

    const [p, v, e] = await Promise.all([host.ping(), host.version(), host.exists("a")]);
    expect(p).toBe(true);
    expect(v).toBe("3");
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
    await listen(makeFakeLocker(path, { protocol: "4" }), path);
    await expect(KeyLockerHost.connectForTest(path)).rejects.toThrow(/protocol '4' != expected '3'/);
  });

  it("rejects a v2 locker — the helper from before kept tags (internal #281)", async () => {
    // A v2 helper ignores `tag` (its dialog says "one-time entry (not saved)" for a secret that IS kept) and
    // answers the fill_kept confirm `bad_prompt`.
    const path = pipePath();
    await listen(makeFakeLocker(path, { protocol: "2" }), path);
    await expect(KeyLockerHost.connectForTest(path)).rejects.toThrow(/protocol '2' != expected '3'/);
  });

  it("rejects a v1 locker — the helper from before capture carried label/note/purpose (PR #806)", async () => {
    // A stale bin/key-locker.exe would show a fill_once dialog with an opaque id and a [Save] button.
    const path = pipePath();
    await listen(makeFakeLocker(path, { protocol: "1" }), path);
    await expect(KeyLockerHost.connectForTest(path)).rejects.toThrow(/protocol '1' != expected '3'/);
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
