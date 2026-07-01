// ADR-014 v2 S1 — cooperative terminal bridge, Node/MCP side (OQ #6 option (C)).
//
// Plan: desktop-touch-mcp-internal@HEAD:docs/adr-014-v2-s1-option-c-design.md
//
// The helper (bin/bridge-host.exe, a compiled C# console app) owns a
// CurrentUserOnly named-pipe SERVER; this module is the CLIENT. S1 is HEADLESS —
// it stands up the server + handshake + ping/version only. The dedicated console
// window a human types sudo/ssh into (crux (a)) is S2 (a C# self-bootstrap that
// re-execs under conhost with CREATE_NEW_CONSOLE); there is no MCP tool surface yet
// (that is S3), so nothing here is wired into a tool.
//
// What S1 LOCKS (all launch-method-independent, so S2's window mechanism does not
// perturb it): the pipe protocol (hello/ping/version/shutdown), the CurrentUserOnly
// server, the kernel client-verify, net.connect backoff, and the typed errors.
//
// The threat-model §8 guarantees, and where they live:
//   * cross-user  → the helper's CurrentUserOnly ACL (a different user cannot open
//     the pipe at all).
//   * casual same-user race → three launch-independent facts: (1) the pipe name is
//     an unguessable ≥128-bit secret minted here; (2) the helper creates the server
//     with FILE_FLAG_FIRST_PIPE_INSTANCE, so if a squatter won the name our helper's
//     create FAILS LOUD and it exits — which we observe as the child dying and abort
//     (BridgeHelperSpawnFailed), never connecting to the squatter; (3) the helper
//     kernel-verifies the connected client is us (GetNamedPipeClientProcessId ==
//     our pid) and rejects a rogue same-user client.
// The helper's self-reported `hello.pid` is NON-LOAD-BEARING observability (liveness
// + version), NOT a security boundary — an adversarial same-user process is out of
// §8 scope, and the guarantees above do not depend on it.
//
// Wire framing: raw UTF-8 bytes, one JSON object per '\n' line, BUFFERED read.

import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// dist/engine/ -> ../../bin/bridge-host.exe (same resolution as ocr-bridge.ts).
const HELPER_EXE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "bridge-host.exe");

/** Wire protocol version the MCP understands; must match the helper's `hello.v`. */
export const BRIDGE_PROTOCOL_VERSION = "1";

export type BridgeErrorCode =
  | "BridgeHelperSpawnFailed"
  | "BridgeHandshakeRejected"
  | "BridgePipeUnavailable";

/**
 * Typed failure for the bridge. S1 defines the codes locally; S4 wires them into
 * `src/tools/_errors.ts` (`SUGGESTS` + `classify`) when the tool surface lands.
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export interface BridgeStartOptions {
  /** Overall budget for spawn → connect → verified hello. Default 15000ms. */
  startupTimeoutMs?: number;
  /** Backoff between connect retries while the helper's server comes up. Default 100ms. */
  connectBackoffMs?: number;
}

interface PendingRequest {
  resolve: (reply: BridgeReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeReply {
  id: number;
  ok: boolean;
  r: string;
  e?: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_BACKOFF_MS = 100;
const HELLO_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A live cooperative-terminal session: a verified pipe connection to the helper.
 * Create with `BridgeHost.start()`; always `dispose()` it (onclose / unsubscribe /
 * shutdown — long-lived-resource discipline).
 */
export class BridgeHost {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buf = "";
  private disposed = false;

  private constructor(
    private readonly socket: net.Socket,
    /** PID to tear down on dispose (the process we spawned). 0 in test seams. */
    private readonly killPid: number,
    /** The helper's self-reported PID from `hello` (observability, non-load-bearing). */
    readonly helperPid: number,
    /** The helper's wire protocol version from `hello`. */
    readonly protocolVersion: string,
  ) {
    this.socket.on("data", (d) => this.onData(d));
    this.socket.on("close", () => this.failAllPending(new BridgeError("BridgePipeUnavailable", "pipe closed")));
    this.socket.on("error", () => { /* surfaced via close / pending timeouts */ });
  }

  /** Launch the helper (headless), connect, read `hello`, and return a live session. */
  static async start(opts: BridgeStartOptions = {}): Promise<BridgeHost> {
    if (process.platform !== "win32") {
      throw new BridgeError("BridgeHelperSpawnFailed", "bridge is Windows-only");
    }
    if (!existsSync(HELPER_EXE)) {
      throw new BridgeError(
        "BridgeHelperSpawnFailed",
        `bridge-host.exe not found at ${HELPER_EXE}. Build: cd tools/bridge-host && dotnet publish -c Release -o ../../bin/`,
      );
    }

    const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const backoffMs = opts.connectBackoffMs ?? DEFAULT_CONNECT_BACKOFF_MS;
    const deadline = Date.now() + startupTimeoutMs;

    // Unguessable per-session name (≥128-bit) — the load-bearing per-launch secret.
    const pipeName = `dtm-bridge-${randomBytes(16).toString("hex")}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const mcpPid = process.pid;

    // S1: direct-spawn the helper HEADLESS (detached, no stdio redirect). It is our
    // DIRECT child, so if it fail-louds on a non-fresh pipe (squatter won the name)
    // we observe the exit and abort BEFORE connecting. (S2 replaces this with a C#
    // self-bootstrap that re-execs under conhost for a dedicated window; that does
    // NOT change this module's locked protocol/auth contract.)
    const child = spawn(HELPER_EXE, ["-PipeName", pipeName, "-McpPid", String(mcpPid)], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    // Holder object (not `let`) so the callback assignments are visible to callers
    // without control-flow narrowing them back to their initial values.
    const state: { helperDied: boolean; spawnError: Error | null } = { helperDied: false, spawnError: null };
    child.on("error", (e) => { state.spawnError = e; state.helperDied = true; });
    child.on("exit", () => { state.helperDied = true; });

    const killPid = child.pid ?? 0;
    if (child.pid === undefined) {
      throw new BridgeError("BridgeHelperSpawnFailed", `helper spawn returned no pid: ${state.spawnError?.message ?? ""}`);
    }

    try {
      const socket = await connectWithBackoff(pipePath, deadline, backoffMs, () => ({ ...state }));
      try {
        return await BridgeHost.handshake(socket, killPid, deadline);
      } catch (e) {
        try { socket.destroy(); } catch { /* ignore */ }
        throw e;
      }
    } catch (e) {
      // ANY startup failure must kill the child — including the alive-but-slow
      // timeout path (helper still running), which would otherwise orphan a
      // bridge-host.exe holding its pipe (e.g. first-run AV scan of the exe).
      killTree(killPid);
      throw e;
    }
  }

  /**
   * TEST-ONLY seam: connect to an ALREADY-listening pipe (no spawn) and run the
   * handshake, so a Node fake peer can exercise the client protocol (hello parse,
   * ping/version, dispose) deterministically. Not used in production.
   */
  static async connectForTest(pipePath: string, o: { timeoutMs?: number } = {}): Promise<BridgeHost> {
    const socket: net.Socket = await new Promise((resolve, reject) => {
      const s = net.connect(pipePath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    const deadline = Date.now() + (o.timeoutMs ?? 5_000);
    try {
      return await BridgeHost.handshake(socket, 0, deadline);
    } catch (e) {
      try { socket.destroy(); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Read the helper's first `hello` frame. Accepts any WELL-FORMED hello — the
   * node-side security is the secret pipe name + the fail-loud liveness abort in
   * `start()`, NOT an identity assertion on the hello (see the file header §8 note).
   */
  private static handshake(socket: net.Socket, killPid: number, deadline: number): Promise<BridgeHost> {
    return new Promise<BridgeHost>((resolve, reject) => {
      let buf = "";
      const helloBudget = Math.max(0, Math.min(HELLO_TIMEOUT_MS, deadline - Date.now()));
      const timer = setTimeout(() => {
        cleanup();
        reject(new BridgeError("BridgeHandshakeRejected", "no hello frame from helper within timeout"));
      }, helloBudget);

      const onData = (d: Buffer | string) => {
        buf += typeof d === "string" ? d : d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return; // wait for a full first frame
        const line = buf.slice(0, nl).replace(/\r$/, "");
        cleanup();

        let hello: { t?: string; pid?: number; v?: string };
        try {
          hello = JSON.parse(line);
        } catch {
          reject(new BridgeError("BridgeHandshakeRejected", `unparseable hello frame: ${line.slice(0, 120)}`));
          return;
        }
        if (hello.t !== "hello" || typeof hello.pid !== "number" || typeof hello.v !== "string") {
          reject(new BridgeError("BridgeHandshakeRejected", `unexpected first frame: ${line.slice(0, 120)}`));
          return;
        }
        if (hello.v !== BRIDGE_PROTOCOL_VERSION) {
          reject(new BridgeError(
            "BridgeHandshakeRejected",
            `helper protocol '${hello.v}' != expected '${BRIDGE_PROTOCOL_VERSION}'`,
          ));
          return;
        }

        const bridge = new BridgeHost(socket, killPid, hello.pid, hello.v);
        // Hand any bytes that arrived after the hello line to the live reader.
        const rest = buf.slice(nl + 1);
        if (rest.length > 0) bridge.onData(Buffer.from(rest, "utf8"));
        resolve(bridge);
      };

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("data", onData);
      };
      socket.on("data", onData);
    });
  }

  /** Round-trip a control request; rejects on timeout or a closed pipe. */
  private request(method: string): Promise<BridgeReply> {
    if (this.disposed) return Promise.reject(new BridgeError("BridgePipeUnavailable", "bridge disposed"));
    const id = this.nextId++;
    return new Promise<BridgeReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("BridgePipeUnavailable", `request '${method}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify({ id, m: method })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError("BridgePipeUnavailable", `write failed: ${(e as Error).message}`));
      }
    });
  }

  /** Liveness check → the helper's `pong`. */
  async ping(): Promise<boolean> {
    const reply = await this.request("ping");
    return reply.ok && reply.r === "pong";
  }

  /** The helper's reported protocol version (also available as `protocolVersion`). */
  async version(): Promise<string> {
    const reply = await this.request("version");
    return reply.r;
  }

  /** Tear down the session: best-effort `shutdown`, close the socket, kill the tree. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await Promise.race([this.request("shutdown"), delay(500)]);
    } catch { /* best-effort */ }
    try { this.socket.end(); this.socket.destroy(); } catch { /* ignore */ }
    this.failAllPending(new BridgeError("BridgePipeUnavailable", "bridge disposed"));
    if (this.killPid > 0) killTree(this.killPid);
  }

  private onData(d: Buffer | string): void {
    this.buf += typeof d === "string" ? d : d.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      let reply: BridgeReply;
      try {
        reply = JSON.parse(line);
      } catch {
        continue; // ignore malformed frames
      }
      const p = this.pending.get(reply.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(reply.id);
        p.resolve(reply);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** net.connect with bounded backoff; aborts early if the helper already died. */
function connectWithBackoff(
  pipePath: string,
  deadline: number,
  backoffMs: number,
  liveness: () => { helperDied: boolean; spawnError: Error | null },
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const attempt = () => {
      const { helperDied, spawnError } = liveness();
      if (helperDied) {
        reject(new BridgeError(
          "BridgeHelperSpawnFailed",
          `helper exited before connect${spawnError ? `: ${spawnError.message}` : " (fail-loud create?)"}`,
        ));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new BridgeError("BridgeHelperSpawnFailed", "helper did not accept a connection before startup timeout"));
        return;
      }
      const sock = net.connect(pipePath);
      const onConnect = () => { sock.removeListener("error", onError); resolve(sock); };
      const onError = (_e: Error) => {
        sock.removeListener("connect", onConnect);
        sock.destroy();
        // ENOENT (not created yet) / EPIPE-busy (max=1, servicing another) → retry.
        setTimeout(attempt, backoffMs);
      };
      sock.once("connect", onConnect);
      sock.once("error", onError);
    };
    attempt();
  });
}

/** Kill a spawned helper process tree (best-effort, Windows). */
function killTree(pid: number): void {
  try {
    const p = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    p.unref(); // best-effort cleanup must not keep the event loop / test runner alive
  } catch { /* ignore */ }
}
