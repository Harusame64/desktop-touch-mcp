// ADR-014 v2 R3 Key Locker — L0 trunk, Node/MCP side (the CLIENT).
//
// Plan: desktop-touch-mcp-internal@main:docs/adr-014-v2-r3-slice-plan.md (L0)
//
// The helper (bin/key-locker.exe, a compiled C# WPF app) owns a CurrentUserOnly named-pipe
// SERVER; this module is the CLIENT. It mirrors S1's bridge-host.ts auth/handshake/framing
// EXACTLY (the proven C#↔C# pipe direction — a Node pipe server does not interop with .NET's
// NamedPipeClientStream). What differs from S1 is the CONTROL VERBS and the trust story:
//
//   * The locker opens a WPF PasswordBox secure dialog on `capture`, DPAPI-encrypts the secret
//     at rest, and serves it to consumers (askpass / SendInput — L2) — never over THIS pipe.
//   * The SECRET NEVER CROSSES THIS PIPE. The wire carries opaque ids + control only; `capture`
//     replies with {captured, rt} booleans, not the secret. So the pipe's integrity guarantee
//     (kernel client-verify, below) protects the CONTROL channel — a squatter-server is inert
//     (it holds no DPAPI store and cannot mint the real one).
//
// Auth (identical to S1 §8, all launch-independent): (1) a ≥128-bit unguessable pipe name minted
// here; (2) the helper creates the server with FILE_FLAG_FIRST_PIPE_INSTANCE, so a squatter that
// won the name makes our helper's create FAIL LOUD — we observe the child die and abort
// (KeyLockerSpawnFailed), never attaching to the squatter; (3) the helper kernel-verifies the
// connected client is us (GetNamedPipeClientProcessId == our pid) and rejects a rogue same-user
// client. The helper's hello.pid is NON-LOAD-BEARING observability, not a security boundary.
//
// Tool-exclusion: on spawn we register the locker's PID with the engine exclusion registry, so
// the locker's own windows (the secure dialog) are dropped from enumWindowsInZOrder() and
// refused by resolveWindowTarget() Cases 1/2 — the MCP's tools cannot address the dialog BY
// WINDOW IDENTITY (hwnd / title / @active). This is BOUNDED: a fullscreen capture or a raw
// mouse-by-coordinate is still physically possible (the accepted structural boundary); the
// secret's secrecy rests on D1's masked PasswordBox, not on this filter. Unregistered on the
// pipe close AND on dispose (a crashed locker must not leave the registry armed).
//
// Wire framing: raw UTF-8 bytes, one JSON object per '\n' line, BUFFERED read.

import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { registerExcludedPid, unregisterExcludedPid } from "./tool-exclusion.js";

// dist/engine/ -> ../../bin/key-locker.exe (same resolution as bridge-host.ts / ocr-bridge.ts).
const HELPER_EXE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "key-locker.exe");

/** Wire protocol version the MCP understands; must match the helper's `hello.v`. */
export const KEY_LOCKER_PROTOCOL_VERSION = "1";

export type KeyLockerErrorCode =
  | "KeyLockerSpawnFailed"
  | "KeyLockerHandshakeRejected"
  | "KeyLockerPipeUnavailable";

/**
 * Typed failure for the key locker. L0 defines the codes locally; L4 wires them into
 * `src/tools/_errors.ts` (`SUGGESTS` + `classify`) when the tool surface lands.
 */
export class KeyLockerError extends Error {
  readonly code: KeyLockerErrorCode;
  constructor(code: KeyLockerErrorCode, message: string) {
    super(message);
    this.name = "KeyLockerError";
    this.code = code;
  }
}

export interface KeyLockerStartOptions {
  /** Overall budget for spawn → connect → verified hello. Default 15000ms. */
  startupTimeoutMs?: number;
  /** Backoff between connect retries while the helper's server comes up. Default 100ms. */
  connectBackoffMs?: number;
  /** Override the locker's at-rest store directory (tests). Production uses the locker default. */
  storeDir?: string;
}

interface PendingRequest {
  resolve: (reply: LockerReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface LockerReply {
  id: number;
  ok: boolean;
  r: string;
  e?: string;
  /** `capture` only: whether the user entered + saved a secret (false = cancelled). */
  captured?: boolean;
  /** `capture` only: whether the locker's in-process DPAPI round-trip verified. */
  rt?: boolean;
  /** `inject` only: whether the secret was typed (after a passing re-verify). */
  injected?: boolean;
  /** `inject` only: whether the injection-instant re-verify passed. */
  verified?: boolean;
  /** `mint_ticket` only: the per-injection serving-pipe name the locker created. */
  pipe?: string;
}

// L2 wire contracts (the locker owns these frame shapes; the injector orchestrator consumes them).

/** The dedicated-conhost target of a SendInput (`inject`) — §2.1 of the L2 plan. */
export interface InjectTarget {
  /** The console window HWND (decimal string). */
  hwnd: string;
  /**
   * The pid that OWNS the console window (`GetWindowThreadProcessId(hwnd)`), which for a modern
   * pseudoconsole-hosted shell is the SHELL process (powershell/pwsh), not literally conhost — L3
   * supplies `getWindowProcessId(hwnd)` and the locker re-verifies with the SAME API on the same
   * hwnd, so the value matches by construction (L3 plan §4). The `ConsoleWindowClass` allowlist is
   * what excludes a WT multiplexer; this pid is the window-owner, not a separate conhost pid.
   */
  consolePid: number;
  /** Opaque hash of the expected pane identity (secondary anchor). */
  titleFp: string;
  /** Append Enter after the secret. */
  submit?: boolean;
}

/** Git credential-field context bound into a ticket for serve-time `context_mismatch` (§3.1). */
export interface MintTicketContext {
  protocol: string;
  host: string;
  path?: string;
}

/** Every abort reason the `inject` verb can return (§2.1 reply contract). */
export type InjectAbortCode =
  | "target_mismatch" | "target_gone" | "not_foreground" | "target_multiplexed"
  | "no_secret" | "bad_target" | "executor_failed";

/** `inject` result: verified+injected, or a typed abort code. */
export type InjectClientResult =
  | { ok: true; verified: boolean }
  | { ok: false; code: InjectAbortCode };

/** `mint_ticket` result: the non-secret ticket + serving-pipe name, or no such secret. */
export type MintTicketResult =
  | { ok: true; ticket: string; pipe: string }
  | { ok: false; code: "no_secret" };

const INJECT_ABORT_CODES: readonly InjectAbortCode[] = [
  "target_mismatch", "target_gone", "not_foreground", "target_multiplexed",
  "no_secret", "bad_target", "executor_failed",
];

/** Map a wire `e` string onto a known abort code so `InjectClientResult.code` never lies. */
function normalizeAbort(e: string | undefined): InjectAbortCode {
  return e !== undefined && (INJECT_ABORT_CODES as readonly string[]).includes(e)
    ? (e as InjectAbortCode)
    : "executor_failed";
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_BACKOFF_MS = 100;
const HELLO_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
// `capture` blocks on human dialog input, so it gets a far longer budget than control verbs.
const CAPTURE_TIMEOUT_MS = 180_000;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A live key-locker session: a verified pipe connection to the helper. Create with
 * `KeyLockerHost.start()`; always `dispose()` it (onclose / unsubscribe / shutdown —
 * long-lived-resource discipline).
 */
export class KeyLockerHost {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buf = "";
  private disposed = false;
  private disposing = false;
  private excludedPid = 0;

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
    this.socket.on("close", () => this.onSocketClosed());
    this.socket.on("error", () => { /* surfaced via close / pending timeouts */ });
  }

  /**
   * The pipe dropped — locker exited / crashed / graceful dispose. Release the tool-exclusion PID
   * HERE (not only in dispose), so a locker that dies WITHOUT dispose() never leaves the registry
   * armed: otherwise `hasExcludedPids()` stays true with no locker alive (breaking the zero-syscall
   * gate) and, on Windows PID reuse, an unrelated process's windows would silently vanish from
   * screenshot / desktop_discover (Opus R1 P2-1). Idempotent with dispose().
   */
  private onSocketClosed(): void {
    this.disposed = true;
    this.releaseExclusion();
    this.failAllPending(new KeyLockerError("KeyLockerPipeUnavailable", "pipe closed"));
  }

  /** Un-exclude the locker PID exactly once (idempotent across close + dispose). */
  private releaseExclusion(): void {
    if (this.excludedPid > 0) {
      unregisterExcludedPid(this.excludedPid);
      this.excludedPid = 0;
    }
  }

  /** Launch the locker, register it for tool-exclusion, connect, read `hello`, return a session. */
  static async start(opts: KeyLockerStartOptions = {}): Promise<KeyLockerHost> {
    if (process.platform !== "win32") {
      throw new KeyLockerError("KeyLockerSpawnFailed", "key locker is Windows-only");
    }
    if (!existsSync(HELPER_EXE)) {
      throw new KeyLockerError(
        "KeyLockerSpawnFailed",
        `key-locker.exe not found at ${HELPER_EXE}. Build: cd tools/key-locker && dotnet publish -c Release -o ../../bin/`,
      );
    }

    const startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const backoffMs = opts.connectBackoffMs ?? DEFAULT_CONNECT_BACKOFF_MS;
    const deadline = Date.now() + startupTimeoutMs;

    // Unguessable per-session name (≥128-bit) — the load-bearing per-launch secret.
    const pipeName = `dtm-locker-${randomBytes(16).toString("hex")}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    const mcpPid = process.pid;

    const argv = ["-PipeName", pipeName, "-McpPid", String(mcpPid)];
    if (opts.storeDir) argv.push("-StoreDir", opts.storeDir);

    // Direct-spawn the locker (detached, no stdio redirect). It is our DIRECT child, so if it
    // fail-louds on a non-fresh pipe (squatter won the name) we observe the exit and abort BEFORE
    // connecting. The WPF app is headless until a `capture` opens its dialog.
    const child = spawn(HELPER_EXE, argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    const state: { helperDied: boolean; spawnError: Error | null } = { helperDied: false, spawnError: null };
    child.on("error", (e) => { state.spawnError = e; state.helperDied = true; });
    child.on("exit", () => { state.helperDied = true; });

    const killPid = child.pid ?? 0;
    if (child.pid === undefined) {
      throw new KeyLockerError("KeyLockerSpawnFailed", `locker spawn returned no pid: ${state.spawnError?.message ?? ""}`);
    }

    // Register for tool-exclusion IMMEDIATELY on spawn — before the handshake — so the locker's
    // windows are dropped from every engine surface even during startup / a racing capture.
    registerExcludedPid(child.pid);

    try {
      const socket = await connectWithBackoff(pipePath, deadline, backoffMs, () => ({ ...state }));
      try {
        const host = await KeyLockerHost.handshake(socket, killPid, deadline);
        host.excludedPid = child.pid;
        return host;
      } catch (e) {
        try { socket.destroy(); } catch { /* ignore */ }
        throw e;
      }
    } catch (e) {
      // ANY startup failure must un-exclude + kill the child — including the alive-but-slow
      // timeout path (helper still running), which would otherwise orphan a key-locker.exe
      // holding its pipe (e.g. first-run AV scan of the exe).
      unregisterExcludedPid(child.pid);
      killTree(killPid);
      throw e;
    }
  }

  /**
   * TEST-ONLY seam: connect to an ALREADY-listening pipe (no spawn) and run the handshake, so a
   * Node fake peer can exercise the client protocol (hello parse, control verbs, dispose)
   * deterministically. Not used in production. Registers no exclusion PID.
   */
  static async connectForTest(pipePath: string, o: { timeoutMs?: number } = {}): Promise<KeyLockerHost> {
    const socket: net.Socket = await new Promise((resolve, reject) => {
      const s = net.connect(pipePath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    const deadline = Date.now() + (o.timeoutMs ?? 5_000);
    try {
      return await KeyLockerHost.handshake(socket, 0, deadline);
    } catch (e) {
      try { socket.destroy(); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Read the helper's first `hello` frame. Accepts any WELL-FORMED hello — the node-side security
   * is the secret pipe name + the fail-loud liveness abort in `start()`, NOT an identity assertion
   * on the hello (see the file header auth note).
   */
  private static handshake(socket: net.Socket, killPid: number, deadline: number): Promise<KeyLockerHost> {
    return new Promise<KeyLockerHost>((resolve, reject) => {
      let buf = "";
      const helloBudget = Math.max(0, Math.min(HELLO_TIMEOUT_MS, deadline - Date.now()));
      const timer = setTimeout(() => {
        cleanup();
        reject(new KeyLockerError("KeyLockerHandshakeRejected", "no hello frame from locker within timeout"));
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
          reject(new KeyLockerError("KeyLockerHandshakeRejected", `unparseable hello frame: ${line.slice(0, 120)}`));
          return;
        }
        if (hello.t !== "hello" || typeof hello.pid !== "number" || typeof hello.v !== "string") {
          reject(new KeyLockerError("KeyLockerHandshakeRejected", `unexpected first frame: ${line.slice(0, 120)}`));
          return;
        }
        if (hello.v !== KEY_LOCKER_PROTOCOL_VERSION) {
          reject(new KeyLockerError(
            "KeyLockerHandshakeRejected",
            `locker protocol '${hello.v}' != expected '${KEY_LOCKER_PROTOCOL_VERSION}'`,
          ));
          return;
        }

        const host = new KeyLockerHost(socket, killPid, hello.pid, hello.v);
        // Hand any bytes that arrived after the hello line to the live reader.
        const rest = buf.slice(nl + 1);
        if (rest.length > 0) host.onData(Buffer.from(rest, "utf8"));
        resolve(host);
      };

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("data", onData);
      };
      socket.on("data", onData);
    });
  }

  /**
   * Round-trip a control request; rejects on timeout or a closed pipe. `extra` carries additive
   * frame fields for the L2 verbs (`inject`'s `t`, `mint_ticket`'s `ctx`) — old lockers ignore
   * unknown props (Program.cs reads only id/m/k), so this stays wire-safe.
   */
  private request(
    method: string,
    key?: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
    extra?: Record<string, unknown>,
  ): Promise<LockerReply> {
    if (this.disposed) return Promise.reject(new KeyLockerError("KeyLockerPipeUnavailable", "locker disposed"));
    const id = this.nextId++;
    return new Promise<LockerReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KeyLockerError("KeyLockerPipeUnavailable", `request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const frame: Record<string, unknown> = { id, m: method, ...extra };
      if (key !== undefined) frame.k = key;
      try {
        this.socket.write(`${JSON.stringify(frame)}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new KeyLockerError("KeyLockerPipeUnavailable", `write failed: ${(e as Error).message}`));
      }
    });
  }

  /** Liveness check → the locker's `pong`. */
  async ping(): Promise<boolean> {
    const reply = await this.request("ping");
    return reply.ok && reply.r === "pong";
  }

  /** The locker's reported protocol version (also available as `protocolVersion`). */
  async version(): Promise<string> {
    const reply = await this.request("version");
    return reply.r;
  }

  /**
   * Open the secure dialog for `key`, capture + DPAPI-store the secret, and verify it in-process.
   * The secret NEVER crosses the pipe — only {captured, rt} come back. `captured=false` means the
   * user cancelled. Uses the long capture budget (blocks on human input).
   */
  async capture(key: string): Promise<{ captured: boolean; rt: boolean }> {
    const reply = await this.request("capture", key, CAPTURE_TIMEOUT_MS);
    return { captured: reply.captured === true, rt: reply.rt === true };
  }

  /** Whether a secret is stored under `key`. */
  async exists(key: string): Promise<boolean> {
    const reply = await this.request("exists", key);
    return reply.ok && reply.r === "1";
  }

  /** Delete the secret stored under `key`. Returns whether an entry was removed. */
  async delete(key: string): Promise<boolean> {
    const reply = await this.request("delete", key);
    return reply.ok && reply.r === "1";
  }

  /**
   * SendInput the secret stored under `key` into a dedicated conhost `target`, AFTER the locker
   * re-verifies the target at the injection instant (§2.2: HWND/consolePid, ConsoleWindowClass,
   * foreground, titleFp). The secret NEVER crosses the pipe — only {injected, verified} come back;
   * an abort returns the typed reason.
   */
  async inject(key: string, target: InjectTarget): Promise<InjectClientResult> {
    const reply = await this.request("inject", key, REQUEST_TIMEOUT_MS, { t: target });
    if (reply.ok) return { ok: true, verified: reply.verified === true };
    return { ok: false, code: normalizeAbort(reply.e) };
  }

  /**
   * Mint a single-use, TTL-bounded ticket + create a per-injection serving pipe for the askpass
   * helper to fetch the secret under `key` (the secret flows locker→helper on that pipe, never here).
   * `ctx` binds git credential fields into the ticket for serve-time `context_mismatch` (§3.1);
   * omit it for ssh-password askpass. The ticket + pipe name are NON-secret capability handles.
   */
  async mintTicket(key: string, ctx?: MintTicketContext): Promise<MintTicketResult> {
    const reply = await this.request("mint_ticket", key, REQUEST_TIMEOUT_MS, ctx ? { ctx } : undefined);
    if (reply.ok && typeof reply.pipe === "string" && reply.r.length > 0) {
      return { ok: true, ticket: reply.r, pipe: reply.pipe };
    }
    return { ok: false, code: "no_secret" };
  }

  /** Tear down the session: best-effort `shutdown`, un-exclude the PID, close the socket, kill. */
  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true; // re-entrancy guard; `disposed` is flipped AFTER shutdown is sent
    // Send the graceful `shutdown` FIRST (while requests are still accepted), so the locker's
    // shutdown handler actually runs — THEN flip `disposed` to reject further requests.
    try {
      await Promise.race([this.request("shutdown"), delay(500)]);
    } catch { /* best-effort */ }
    this.disposed = true;
    this.releaseExclusion();
    try { this.socket.end(); this.socket.destroy(); } catch { /* ignore */ }
    this.failAllPending(new KeyLockerError("KeyLockerPipeUnavailable", "locker disposed"));
    if (this.killPid > 0) killTree(this.killPid);
  }

  private onData(d: Buffer | string): void {
    this.buf += typeof d === "string" ? d : d.toString("utf8");
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      let reply: LockerReply;
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
        reject(new KeyLockerError(
          "KeyLockerSpawnFailed",
          `locker exited before connect${spawnError ? `: ${spawnError.message}` : " (fail-loud create?)"}`,
        ));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new KeyLockerError("KeyLockerSpawnFailed", "locker did not accept a connection before startup timeout"));
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
