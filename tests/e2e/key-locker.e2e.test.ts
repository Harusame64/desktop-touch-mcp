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
import { KeyLockerHost, KEY_LOCKER_PROTOCOL_VERSION } from "../../src/engine/key-locker-host.js";
import { hasExcludedPids } from "../../src/engine/tool-exclusion.js";

const HELPER_EXE = join(process.cwd(), "bin", "key-locker.exe");

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

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

  // L2 §6 #4/#7/#8 (headless slice): the serving-pipe + ticket contract — valid fetch, single-use,
  // forged ticket refused, git context_mismatch refused, context match serves. SendInput (§6 #2/#3)
  // needs a live foreground conhost and is a separate live e2e; this proves the serving path.
  // Since S-pid PR2, `-SelfTestL2` ALSO carries the E3b wire-parse pin (a `t` frame's
  // shellPid/shellStartMs reconstruct through the SAME ParseInjectTarget the live HandleInject uses)
  // + the §4 FILETIME sign-extension pin — asserted here as `wireParse:true`.
  it("serves a ticketed secret once and refuses replay / forged ticket / context mismatch (-SelfTestL2 + S-pid wire-parse pin)", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const storeDir = freshStoreDir();
    dirs.push(storeDir);

    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const c = spawn(HELPER_EXE, ["-SelfTestL2", "-StoreDir", storeDir], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      c.stdout!.on("data", (d) => { out += d.toString("utf8"); });
      c.on("exit", (code) => resolve({ code, stdout: out }));
      setTimeout(() => { killTree(c.pid); resolve({ code: -999, stdout: out }); }, 20_000);
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ ok: true, serving: true, wireParse: true });

    // The serving path decrypts transiently in-process; the at-rest store never holds plaintext.
    const storeJson = readFileSync(join(storeDir, "store.json"), "utf8");
    expect(storeJson).not.toContain("L2-SERVE-SECRET");
  }, 30_000);

  // DF-5: the console-buffer injector (AttachConsole + WriteConsoleInput) is foreground/UIPI-immune and
  // replaces the SendInput path that returned `sent=0`. `-SelfTestInjectConsole` runs the REAL production
  // `Win32Input.ReVerifyAndType` against a self-spawned child console (echo-off cooked-read) and asserts a
  // unicode+surrogate secret round-trips — a deterministic proof that needs no live ssh. (The live native
  // OpenSSH leg is dogfood-only, like capture's dialog.)
  //
  // `skipped:true` = the machine's Default Terminal is Windows Terminal, so the child's AllocConsole handed
  // off to a ConPTY pseudoconsole (window class != ConsoleWindowClass) and the classic-conhost injector
  // could not be exercised here — a supported Win11 config, covered by the live dogfood, not a failure
  // (Codex #523 P2). CI + a default Windows desktop use a classic conhost, so they run the full assertion.
  it("types a unicode+surrogate secret into another process's console and it cooked-reads it back (-SelfTestInjectConsole)", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);

    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const c = spawn(HELPER_EXE, ["-SelfTestInjectConsole"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      c.stdout!.on("data", (d) => { out += d.toString("utf8"); });
      c.on("exit", (code) => resolve({ code, stdout: out }));
      setTimeout(() => { killTree(c.pid); resolve({ code: -999, stdout: out }); }, 25_000);
    });

    expect(code).toBe(0);
    const result = JSON.parse(stdout.trim()) as { ok: boolean; skipped?: boolean };
    if (result.skipped) {
      console.warn("[-SelfTestInjectConsole] skipped: non-classic conhost (Windows Terminal default) — covered by live dogfood");
    } else {
      expect(result).toEqual({ ok: true, skipped: false });
    }
  }, 40_000);
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
    expect(host.protocolVersion).toBe(KEY_LOCKER_PROTOCOL_VERSION);
    expect(await host.ping()).toBe(true);
    expect(await host.version()).toBe(KEY_LOCKER_PROTOCOL_VERSION);
    // Nothing captured yet → exists/delete on an unknown key are false (no dialog opened).
    expect(await host.exists("ssh:nobody")).toBe(false);
    expect(await host.delete("ssh:nobody")).toBe(false);
  }, 40_000);

  it("round-trips the W-3.5 `prompt` verb via the headless -PromptAutoAnswer CLI seam (no GUI, secret-free)", async () => {
    // Exercises the REAL C# HandlePrompt → PromptDialog path end-to-end without a human: `start()` passes the
    // `-PromptAutoAnswer` CLI arg (a spawn-controlled test seam — NOT an env var a production launch could
    // inherit and use to silently bypass the human backstop) so the dialog returns the canned choice before
    // opening a window. Proves the verb plumbing (frame {kind,label} parse → STA marshal → reply); the GUI
    // button logic is dogfood-only (like capture's dialog). The wire carries only the LABEL + the choice.
    expect(existsSync(HELPER_EXE)).toBe(true);
    const storeDir = freshStoreDir();
    dirs.push(storeDir);
    const host = await KeyLockerHost.start({ startupTimeoutMs: 20_000, storeDir, promptAutoAnswerForTest: "autofill" });
    hosts.push(host);
    expect(await host.prompt("confirm", "sudo://host-a")).toBe("autofill");
  }, 40_000);

  it("releases the tool-exclusion PID when the locker dies WITHOUT dispose() (P2-1)", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const storeDir = freshStoreDir();
    dirs.push(storeDir);

    const host = await KeyLockerHost.start({ startupTimeoutMs: 20_000, storeDir });
    hosts.push(host); // afterEach dispose() is a harmless no-op once it is already dead
    expect(hasExcludedPids()).toBe(true);

    // Simulate a crash: kill the locker process directly, no dispose(). The host's socket 'close'
    // must fire and release the exclusion PID, else a dead locker leaves the registry armed
    // (breaking the zero-syscall gate + risking PID-reuse false exclusion).
    killTree(host.helperPid);
    const released = await pollUntil(() => !hasExcludedPids(), 10_000);
    expect(released).toBe(true);
  }, 40_000);
});

describe("key-locker rogue client rejection (kernel client-verify)", () => {
  let child: ChildProcess | undefined;
  let standIn: ChildProcess | undefined;
  afterEach(() => { killTree(child?.pid); child = undefined; killTree(standIn?.pid); standIn = undefined; });

  it("rejects a client whose PID != the locker's -McpPid", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);

    // Launch the real locker but tell it a DIFFERENT process is its MCP. Our connect (this
    // process's pid) must be rejected by the C# kernel client-verify → we CONNECT but get no hello.
    const name = `dtm-locker-rogue-${randomBytes(8).toString("hex")}`;
    // A LIVE other process: since internal #282 the locker opens a handle to its -McpPid at start and exits
    // (code 4) when it cannot, so a made-up pid would no longer reach the client verify this cell is about.
    standIn = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore", windowsHide: true });
    expect(standIn.pid).toBeDefined();
    const wrongMcpPid = standIn.pid!;
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

  it("a pre-existing MULTI-INSTANCE squatter still makes the locker fail-loud (exit 3) — Codex P2 rebuttal", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const name = `dtm-locker-squat-${randomBytes(8).toString("hex")}`;

    // The exact race Codex P2 posits: a same-user squatter pre-creates the pipe with MULTI-INSTANCE
    // (MaxAllowedServerInstances, which is != 1 so .NET does NOT set FILE_FLAG_FIRST_PIPE_INSTANCE
    // on the squatter's create). The claim was that our helper (maxInstances=1) would then attach as
    // a second instance instead of failing. It does NOT: .NET's maxInstances=1 create is refused
    // because the name already exists (first-instance semantics + instance-count mismatch), so the
    // helper exits 3 and the MCP aborts — never connecting to the squatter.
    const squatScript =
      "$o=[System.IO.Pipes.PipeOptions]::Asynchronous -bor [System.IO.Pipes.PipeOptions]::CurrentUserOnly;" +
      `$s=New-Object System.IO.Pipes.NamedPipeServerStream('${name}',` +
      "[System.IO.Pipes.PipeDirection]::InOut,[System.IO.Pipes.NamedPipeServerStream]::MaxAllowedServerInstances," +
      "[System.IO.Pipes.PipeTransmissionMode]::Byte,$o);Write-Host 'READY';Start-Sleep -Seconds 30;";
    const squatter = spawn("powershell.exe", ["-NoProfile", "-Command", squatScript], { stdio: ["ignore", "pipe", "ignore"] });
    kids.push(squatter);

    // Wait until the squatter reports it holds the name.
    await new Promise<void>((resolve, reject) => {
      let out = "";
      const t = setTimeout(() => reject(new Error("squatter never signalled READY")), 15_000);
      squatter.stdout!.on("data", (d) => {
        out += d.toString("utf8");
        if (out.includes("READY")) { clearTimeout(t); resolve(); }
      });
      squatter.on("exit", () => { clearTimeout(t); reject(new Error("squatter exited before READY")); });
    });

    const exit = await new Promise<number | null>((resolve) => {
      const b = spawn(HELPER_EXE, ["-PipeName", name, "-McpPid", String(process.pid)], {
        detached: true, stdio: "ignore", windowsHide: false,
      });
      kids.push(b);
      b.on("exit", (code) => resolve(code));
      setTimeout(() => resolve(-999), 12_000);
    });
    expect(exit).toBe(3);
  }, 40_000);
});

// internal #282: a helper whose server dies BEFORE it connects exits too. win2 2026-10-13: the server's own
// shutdown spawned a fresh helper (fixed in KeyLockerManager.close()), which waited on its pipe for minutes.
// Headless: no dialog, no client ever connects.
describe("key-locker exits when its server dies before connecting (internal #282)", () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const c of kids) killTree(c.pid); kids.length = 0; });

  it("exits with code 5 once the -McpPid process is gone, with no client", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const server = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore", windowsHide: true });
    kids.push(server);
    expect(server.pid).toBeDefined();
    const helper = spawn(HELPER_EXE, ["-PipeName", `dtm-locker-282b-${randomBytes(8).toString("hex")}`, "-McpPid", String(server.pid)], {
      detached: true, stdio: "ignore", windowsHide: false,
    });
    kids.push(helper);
    let helperExit: number | null | undefined;
    helper.on("exit", (code) => { helperExit = code; });

    await new Promise((r) => setTimeout(r, 1_500));
    expect(helperExit).toBeUndefined(); // waiting for its client, as it should

    killTree(server.pid);
    expect(await pollUntil(() => helperExit !== undefined, 10_000)).toBe(true);
    expect(helperExit).toBe(5);
  }, 40_000);

  it("refuses to start (code 4) when its -McpPid is not a running process", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    // A pid that WAS a process and has exited — not a made-up number, which could name a live process.
    const gone = spawn("cmd.exe", ["/c", "exit 0"], { stdio: "ignore", windowsHide: true });
    const gonePid = gone.pid!;
    await new Promise<void>((r) => gone.once("exit", () => r()));
    await new Promise((r) => setTimeout(r, 200)); // let node release its handle to it
    const exit = await new Promise<number | null>((resolve) => {
      const h = spawn(HELPER_EXE, ["-PipeName", `dtm-locker-282c-${randomBytes(8).toString("hex")}`, "-McpPid", String(gonePid)], {
        detached: true, stdio: "ignore", windowsHide: false,
      });
      kids.push(h);
      h.on("exit", (code) => resolve(code));
      setTimeout(() => resolve(-999), 12_000);
    });
    // 4 is the expected answer. 5 is acceptable: if something still holds a handle to the exited process
    // (its conhost, briefly), OpenProcess succeeds on the dead process and the wait returns at once. Either way
    // the helper did not wait for a client (review on 036ed740).
    expect([4, 5]).toContain(exit);
  }, 40_000);
});

// internal #282 (review on 036ed740): the first-run consent dialog goes away with the server too. Opens a real
// window, so it runs only with DTM_E2E_LOCKER_DIALOG=1.
describe.runIf(process.env.DTM_E2E_LOCKER_DIALOG === "1")("key-locker consent dialog exits with the MCP server (internal #282)", () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const c of kids) killTree(c.pid); kids.length = 0; });

  it("closes the consent dialog when the server process dies, and writes no consent.json", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const storeDir = freshStoreDir();
    try {
      const server = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore", windowsHide: true });
      kids.push(server);
      expect(server.pid).toBeDefined();
      const dialog = spawn(HELPER_EXE, ["-Consent", "-StoreDir", storeDir, "-McpPid", String(server.pid)], {
        detached: true, stdio: "ignore", windowsHide: false,
      });
      kids.push(dialog);
      let dialogExit: number | null | undefined;
      dialog.on("exit", (code) => { dialogExit = code; });

      await new Promise((r) => setTimeout(r, 2_000));
      expect(dialogExit).toBeUndefined(); // the dialog is up and waiting for the user

      killTree(server.pid);
      expect(await pollUntil(() => dialogExit !== undefined, 10_000)).toBe(true);
      expect(dialogExit).toBe(5);
      expect(existsSync(join(storeDir, "consent.json"))).toBe(false);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 40_000);
});

// internal #282: the helper and its open dialog must go away with the MCP server. The pipe loop only sees a
// closed pipe between frames, and a capture dialog blocks it, so before the fix the helper outlived the server
// with its dialog on screen. This cell OPENS A REAL WPF DIALOG on the desktop for a few seconds (nobody types
// into it), so it runs only when DTM_E2E_LOCKER_DIALOG=1.
describe.runIf(process.env.DTM_E2E_LOCKER_DIALOG === "1")("key-locker exits with the MCP server (internal #282)", () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const c of kids) killTree(c.pid); kids.length = 0; });

  it("closes an open capture dialog and exits when the server process dies", async () => {
    expect(existsSync(HELPER_EXE)).toBe(true);
    const name = `dtm-locker-282-${randomBytes(8).toString("hex")}`;
    const storeDir = freshStoreDir();
    try {
      // A stand-in MCP server: connects, reads hello, asks for a capture (the dialog opens), then just waits.
      const clientScript =
        `$c=New-Object System.IO.Pipes.NamedPipeClientStream('.','${name}',[System.IO.Pipes.PipeDirection]::InOut);` +
        "$c.Connect(20000);$r=New-Object System.IO.StreamReader($c);$null=$r.ReadLine();" +
        "$w=New-Object System.IO.StreamWriter($c);$w.AutoFlush=$true;$w.NewLine=\"`n\";" +
        // No `purpose`: the autofill capture, the dialog whose answer is written to store.json when it is confirmed.
        "$w.WriteLine('{\"id\":1,\"m\":\"capture\",\"k\":\"e2e-282\",\"label\":\"e2e internal #282 (closes by itself)\"}');" +
        "Write-Host 'SENT';Start-Sleep -Seconds 60;";
      const server = spawn("powershell.exe", ["-NoProfile", "-Command", clientScript], { stdio: ["ignore", "pipe", "ignore"] });
      kids.push(server);
      expect(server.pid).toBeDefined();

      const helper = spawn(HELPER_EXE, ["-PipeName", name, "-McpPid", String(server.pid), "-StoreDir", storeDir], {
        detached: true, stdio: "ignore", windowsHide: false,
      });
      kids.push(helper);
      let helperExit: number | null | undefined;
      helper.on("exit", (code) => { helperExit = code; });

      await new Promise<void>((resolve, reject) => {
        let out = "";
        const t = setTimeout(() => reject(new Error("stand-in server never sent the capture")), 20_000);
        server.stdout!.on("data", (d) => {
          out += d.toString("utf8");
          if (out.includes("SENT")) { clearTimeout(t); resolve(); }
        });
      });
      // Let the dialog come up, and make sure the helper is still waiting on it.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(helperExit).toBeUndefined();

      killTree(server.pid);
      expect(await pollUntil(() => helperExit !== undefined, 10_000)).toBe(true);
      // 0: the dispatcher shut down and Main returned. Anything else means the hard fallback ran (it kills the
      // process after 3 s), which is an exit too but says the dialog did not close cleanly.
      expect(helperExit).toBe(0);
      expect(existsSync(join(storeDir, "store.json"))).toBe(false);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 60_000);
});
