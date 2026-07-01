/**
 * key-locker.e2e.test.ts — ADR-014 v2 R3 Key Locker L0 live smoke + negatives.
 *
 * Spawns the REAL bin/key-locker.exe, so it is gated to the e2e project. Validates the
 * launch-independent locked L0 contract end to end:
 *   1. DPAPI at-rest store — headless `-SelfTest` (encrypt → persist → decrypt round-trip +
 *      wrong-value + corrupt-tag rejection), no pipe, no GUI;
 *   2. the pipe control plane — direct-spawn → C# CurrentUserOnly server → kernel client-verify
 *      (GetNamedPipeClientProcessId == our pid) → hello → ping / version / exists / delete
 *      (NO capture — that opens the WPF dialog which needs a human);
 *   3. the two load-bearing auth negatives — rogue client rejected; FIRST_PIPE_INSTANCE fail-loud.
 *
 * The secure-dialog capture path + the D1 un-capturability were proven by the D1 spike and are
 * enforced structurally by tool-exclusion (unit-covered). The pure client protocol is covered
 * deterministically by tests/unit/key-locker-host.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { KeyLockerHost } from "../../src/engine/key-locker-host.js";

const HELPER_EXE = join(process.cwd(), "bin", "key-locker.exe");

function killTree(pid?: number): void {
  if (pid === undefined) return;
  try { spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
  catch { /* ignore */ }
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "dtm-locker-e2e-"));
}

describe("key-locker DPAPI store (-SelfTest, headless)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } dirs.length = 0; });

  it("round-trips a secret and rejects wrong-value + corrupt-tag", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const storeDir = freshStoreDir();
    dirs.push(storeDir);

    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const c = spawn(HELPER_EXE, ["-SelfTest", "-StoreDir", storeDir], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      c.stdout!.on("data", (d) => { out += d.toString("utf8"); });
      c.on("exit", (code) => resolve({ code, stdout: out }));
      setTimeout(() => { killTree(c.pid); resolve({ code: -999, stdout: out }); }, 20_000);
    });

    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim()) as { ok: boolean; roundTrip: boolean; wrongValueRejected: boolean; corruptRejected: boolean };
    expect(result).toEqual({ ok: true, roundTrip: true, wrongValueRejected: true, corruptRejected: true });

    // The at-rest store must hold NO plaintext — only DPAPI-wrapped base64. -SelfTest deletes its
    // own entry, so entries is empty; assert the sentinel secret never appears regardless.
    const storeJson = readFileSync(join(storeDir, "store.json"), "utf8");
    expect(storeJson).not.toContain("DPAPI-ROUNDTRIP-");
  }, 30_000);
});

describe("key-locker live smoke (pipe control plane)", () => {
  const hosts: KeyLockerHost[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const h of hosts) { try { await h.dispose(); } catch { /* ignore */ } }
    hosts.length = 0;
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    dirs.length = 0;
  });

  it("spawns the real locker, handshakes, and answers ping / version / exists / delete", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const storeDir = freshStoreDir();
    dirs.push(storeDir);

    const host = await KeyLockerHost.start({ startupTimeoutMs: 20_000, storeDir });
    hosts.push(host);

    expect(host.helperPid).toBeGreaterThan(0);
    expect(host.protocolVersion).toBe("1");
    expect(await host.ping()).toBe(true);
    expect(await host.version()).toBe("1");
    // Nothing captured yet → exists/delete on an unknown key are false (no dialog opened).
    expect(await host.exists("ssh:nobody")).toBe(false);
    expect(await host.delete("ssh:nobody")).toBe(false);
  }, 40_000);
});

describe("key-locker rogue client rejection (kernel client-verify)", () => {
  let child: ChildProcess | undefined;
  afterEach(() => { killTree(child?.pid); child = undefined; });

  it("rejects a client whose PID != the locker's -McpPid", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);

    // Launch the real locker but tell it a DIFFERENT process is its MCP. Our connect (this
    // process's pid) must be rejected by the C# kernel client-verify → we CONNECT but get no hello.
    const name = `dtm-locker-rogue-${randomBytes(8).toString("hex")}`;
    const wrongMcpPid = process.pid + 100_000;
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
          connected = true;
          sock.on("data", (d) => { if (d.toString("utf8").includes('"hello"')) { sock.destroy(); done(true); } });
          sock.on("close", () => done(false));
          setTimeout(() => { sock.destroy(); done(false); }, 4_000);
        });
        sock.once("error", () => {
          sock.destroy();
          if (attempt < 40) setTimeout(() => tryConnect(attempt + 1), 200);
          else done(false);
        });
      };
      tryConnect(0);
    });

    expect(result.connected).toBe(true);
    expect(result.gotHello).toBe(false);
  }, 40_000);
});

describe("key-locker FIRST_PIPE_INSTANCE fail-loud", () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const c of kids) killTree(c.pid); kids.length = 0; });

  it("a second locker on the same pipe name fails loud and exits code 3", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const name = `dtm-locker-fpi-${randomBytes(8).toString("hex")}`;
    const mcp = String(process.pid);

    // A creates the CurrentUserOnly server (holds the name) and waits for a client.
    const a = spawn(HELPER_EXE, ["-PipeName", name, "-McpPid", mcp], {
      detached: true, stdio: "ignore", windowsHide: false,
    });
    kids.push(a);

    // Poll until A's pipe accepts a connection (name registered); KEEP the probe open so A stays
    // alive holding the name while B races. (We are A's McpPid, so A verifies + keeps us.)
    const probe = await new Promise<net.Socket>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const tryIt = () => {
        const s = net.connect(`\\\\.\\pipe\\${name}`);
        s.once("connect", () => resolve(s));
        s.once("error", () => {
          s.destroy();
          if (Date.now() < deadline) setTimeout(tryIt, 150);
          else reject(new Error("locker A never registered its pipe"));
        });
      };
      tryIt();
    });

    try {
      // B tries the SAME name → FILE_FLAG_FIRST_PIPE_INSTANCE (maxInstances=1) makes its create
      // fail → the locker exits 3 (pipe-create-failed), never attaching to A.
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
