// ADR-014 v2 R3 Key Locker — L3 §6 / L4 §2: the KeyLockerManager (single owner of the locker host)
// + the first-run consent gate.
//
// Plan: L3 §6 (lifecycle) + L4 §2 (consent). desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-capture
//   -plan.md / adr-014-v2-r3-l4-tool-surface-plan.md
//
// Nothing owns a locker in production today (grounding §5) — this is the first owner. It:
//   * lazily `KeyLockerHost.start()`s ONE host on first secret use and guarantees `dispose()`;
//   * GATES every secret-touching op (capture/inject/mint) on FIRST-RUN CONSENT (effects-gated, NOT
//     process-spawn — Opus L4-R1 P1-2): consent is a persisted flag `consent.json` in the locker
//     store dir, WRITTEN by the C# locker's `-Consent` dialog mode (a secret-free spawn); this module
//     only READS it, fail-closed on absent/corrupt.
//
// The C# `-Consent` dialog mode + the ssh process-tree pop watch that drives the SessionTracker are
// separate pieces (see the impl-handoff doc) — this module defines the Node-side contract they plug
// into.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HELPER_EXE, KeyLockerError, KeyLockerHost, type KeyLockerStartOptions } from "../key-locker-host.js";
import {
  buildProcessParentMap,
  enumWindowsInZOrder,
  getProcessCommandLineByPid,
  getProcessIdentityByPid,
  getWindowProcessId,
  getWindowTitleW,
} from "../win32.js";
import { SessionTracker } from "./session-tracker.js";
import { SshSessionWatch, type ProcessSnapshot } from "./ssh-session-watch.js";

/** Typed reject when a secret op is attempted before first-run consent is accepted (L4 §2). */
export class KeyLockerConsentRequiredError extends Error {
  readonly code = "KeyLockerConsentRequired";
  constructor() {
    super("KeyLockerConsentRequired: the key locker must be enabled once before it can store or fill secrets");
    this.name = "KeyLockerConsentRequiredError";
  }
}

/**
 * Typed reject when the whole feature is hard-disabled by the kill switch (L4 §2). A DISTINCT code from
 * the spawn/consent errors so `_errors.ts` (L4 tool wiring) can give a "you disabled this" hint rather
 * than a misleading "build key-locker.exe" spawn-failure hint (Opus PR#497 R1 P2).
 */
export class KeyLockerDisabledError extends Error {
  readonly code = "KeyLockerDisabled";
  constructor() {
    super("KeyLockerDisabled: the key locker is disabled (DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1)");
    this.name = "KeyLockerDisabledError";
  }
}

/** Mirrors the locker's default store dir (Program.cs: %LOCALAPPDATA%\desktop-touch-mcp\locker). */
function defaultStoreDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "desktop-touch-mcp", "locker");
}

const CONSENT_FILE = "consent.json";
/** The Win32 class of a CLASSIC conhost console window — the ONLY window L2 injection can target (the
 *  `Injection.cs` ReVerify positive-allowlist). Windows Terminal is a XAML host with a different class. */
const CONSOLE_WINDOW_CLASS = "ConsoleWindowClass";

/** Read the persisted first-run consent flag (fail-closed: absent/corrupt/wrong-shape ⇒ false). */
export function consentAccepted(storeDir?: string): boolean {
  const path = join(storeDir ?? defaultStoreDir(), CONSENT_FILE);
  try {
    // readFileSync alone is atomic + fail-closed (a missing file throws → false), so no existsSync
    // pre-check is needed (it would only add a TOCTOU window — both directions fail closed anyway).
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null &&
      (raw as { version?: unknown }).version === 1 &&
      typeof (raw as { acceptedAt?: unknown }).acceptedAt === "string";
  } catch {
    return false;
  }
}

/** True if the whole feature is hard-disabled by the kill switch (regardless of consent, L4 §2). */
export function keyLockerDisabled(): boolean {
  return process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER === "1";
}

export interface KeyLockerManagerOptions extends KeyLockerStartOptions {
  /** Override the store dir (tests); production uses the locker default. */
  storeDir?: string;
  /** Injected monotonic-ish clock for idle-dispose dormancy (default `Date.now`); overridden in tests. */
  now?: () => number;
  /**
   * Win32 process-tree seams for the SshSessionWatch snapshot adapter (W-3, §2.1). Default to the real
   * `win32.ts` bindings; tests inject a fake tree so the watch reconciliation unit-tests without native calls.
   */
  win32?: {
    buildProcessParentMap: () => Map<number, number>;
    /** Raw identity (native `processName` is NOT lowercased at source — the adapter lowercases it). */
    getProcessIdentity: (pid: number) => { processName: string; processStartTimeMs: number };
    getProcessCommandLine: (pid: number) => string[] | null;
  };
}

/**
 * Owns the single live `KeyLockerHost`. Lazy start on the first `withHost` (secret op), guaranteed
 * dispose. Every secret op flows through `withHost`, which enforces the kill switch + consent gate
 * BEFORE any host spawn — so no locker process starts for a secret op until the user has opted in.
 * (The secret-free `-Consent` dialog spawn is a separate path, not gated here.)
 */
export class KeyLockerManager {
  private host: KeyLockerHost | null = null;
  private starting: Promise<KeyLockerHost> | null = null;
  private consenting: Promise<void> | null = null; // in-flight `-Consent` dialog (dedupes concurrent prompts)
  private inFlight = 0;        // secret ops currently running through withHost (idle-dispose never runs mid-op)
  private lastActivityMs = 0;  // clock stamp of the last withHost completion (idle-dispose dormancy timer)

  // W-3 (§2.1): the single live session tracker + ssh session-end watch this manager owns. The watch is
  // built with a snapshot seam that adapts the real Win32 process-tree bindings (or a test fake) into the
  // pure `ProcessSnapshot` shape the watch/driver reconcile against. The capture-DRIVER (W-2) is constructed
  // with these (`{ tracker, watch, snapshot }`) + the loop seams by the wiring root (W-4); the wiring drives
  // the DRIVER's `tickWatch()` (which owns the correlate + baseline-advance + hygiene reconcile) on a timer —
  // this manager provides the tracker/watch/snapshot infrastructure, not the reconcile loop itself.
  private readonly sessionTracker = new SessionTracker();
  private readonly sshWatch: SshSessionWatch;

  constructor(private readonly opts: KeyLockerManagerOptions = {}) {
    this.sshWatch = new SshSessionWatch({ snapshot: () => this.snapshotProcessTree(), tracker: this.sessionTracker });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The live per-pane session tracker (the driver anchors/records/forgets it). */
  get tracker(): SessionTracker {
    return this.sessionTracker;
  }

  /** The live ssh session-end watch (the driver registers/reconciles session ssh children through it). */
  get watch(): SshSessionWatch {
    return this.sshWatch;
  }

  /**
   * One live process-tree snapshot for the watch/driver reconcile (W-3 §2.1 — the Win32 adapter). PUBLIC so
   * the wiring root (W-4) can build the capture-driver's `snapshot` seam from the SAME manager-owned adapter
   * the watch uses — passing `() => manager.snapshotProcessTree()` — rather than duplicating it and risking
   * production/test drift (Codex W-3). Wires the real (or injected) `buildProcessParentMap` +
   * `getProcessIdentity` + `getProcessCommandLine` into the pure `ProcessSnapshot` shape. Two adaptations the
   * watch's contract requires:
   *   - `identify().name` is the native `processName` LOWERCASED (win32 does NOT lowercase at source; the watch
   *     compares against the lowercase literal `"ssh"`), with `startTimeMs` from `processStartTimeMs`.
   *   - `commandLine(pid)` passes `getProcessCommandLine` through verbatim (null on ANY read failure — the
   *     W-2b argv scan treats null as "possibly interactive" and fails safe).
   * A snapshot failure surfaces as an EMPTY `parentMap` (`buildProcessParentMap` swallows errors → {}) / an
   * empty identity (`{ name: "", startTimeMs: 0 }`) — the watch tolerates both (it skips a degenerate tick and
   * treats "" as gone-or-unreadable), so this adapter never throws.
   */
  snapshotProcessTree(): ProcessSnapshot {
    const w = this.opts.win32;
    const parentMapOf = w?.buildProcessParentMap ?? buildProcessParentMap;
    const identityOf = w?.getProcessIdentity ?? getProcessIdentityByPid;
    const commandLineOf = w?.getProcessCommandLine ?? getProcessCommandLineByPid;
    return {
      parentMap: parentMapOf(),
      identify: (pid) => {
        const id = identityOf(pid);
        return { name: id.processName.toLowerCase(), startTimeMs: id.processStartTimeMs };
      },
      commandLine: (pid) => commandLineOf(pid),
    };
  }

  /** The store dir this manager reads consent + bindings from. */
  get storeDir(): string {
    return this.opts.storeDir ?? defaultStoreDir();
  }

  /**
   * W-4 (gap1, §3 W1): launch a KNOWN-LOCAL, INJECTABLE terminal pane the Key Locker can anchor. Code-verified
   * constraints (Fable 2026-07-08): the ONLY injectable window is a CLASSIC conhost (`ConsoleWindowClass` — the
   * L2 `Injection.cs` ReVerify positive-allowlist; Windows Terminal is a XAML host ⇒ `target_multiplexed`), and
   * `workspace_launch` blocks all shells, and R1's cooperative terminal is headless-only (the visible-console
   * launch is R2's unshipped S2). So the manager launches a locker-owned, fixed, local conhost DIRECTLY (an
   * internal spawn — it does NOT route through `workspace_launch`'s executable blocklist, which exists to stop
   * the ASSISTANT from launching arbitrary shells) via `cmd /c start` and polls for the new
   * `ConsoleWindowClass` window (DF-1: `cmd /c start` is what forces a NEW console — see the impl note below).
   * Returns `{ hwnd, shellPid }` where `shellPid = getWindowProcessId(hwnd)` = the SHELL (powershell) process
   * that OWNS the console window (dogfood-verified: on Win11 the console window's owner is the shell, and
   * conhost is its PARENT). Any ssh/sudo the human runs are CHILDREN of that shell, so `shellPid` is exactly
   * the `sshDescendants` subtree root. The wiring fires
   * `onLocalPaneLaunched(String(hwnd), shellPid)`. The console gets a UNIQUE window title (`dtm-locker-console-
   * <nonce>`) — the CLAIM key here (child.pid is the transient cmd.exe, not the conhost) AND the title-keyed
   * read/inject seams' resolver (`resolveTitleByHwnd` declines any pane whose title is not substring-unique, so
   * without this a second console (or a same-titled user window) would never autofill — Codex W-4a R3
   * read-path). **NOT unit-testable — the live-desktop console-allocation behavior is covered by the §5
   * dogfood (see the DF-1 followups doc).** Throws if no console window appears within `timeoutMs`.
   */
  async launchAnchoredConsole(
    o: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ hwnd: bigint; shellPid: number; title: string }> {
    const timeoutMs = o.timeoutMs ?? 8000;
    const pollMs = o.pollMs ?? 150;
    const title = `dtm-locker-console-${randomBytes(8).toString("hex")}`; // globally unique ⇒ unambiguous title read
    // Snapshot existing console hwnds so we claim only the NEW one this spawn creates.
    const before = new Set(
      enumWindowsInZOrder().filter((w) => w.className === CONSOLE_WINDOW_CLASS).map((w) => w.hwnd),
    );
    // DF-1 (live dogfood 2026-07-08, followups doc): a bare `spawn("conhost.exe", …)` allocates NO console
    // window under the MCP server's context — Node's child_process cannot pass the Win32 CREATE_NEW_CONSOLE
    // flag and the server parent has no console to share, so no console is created (verified: conhost AND
    // powershell, detached or not + stdio:ignore, produce zero `ConsoleWindowClass` windows). `cmd /c start`
    // is the one form that forces a NEW console. Bonus: the `start`-ed console is REPARENTED off the transient
    // cmd.exe (which exits at once), so the console OUTLIVES this process for free — no node-side tree-kill can
    // reach it (the "console outlives the session" requirement, Opus W-4a P2-1). Absolute System32 paths: a
    // credential feature must never resolve its spawn executables via PATH (hijack hardening).
    const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const cmdExe = join(sys32, "cmd.exe");
    const conhostExe = join(sys32, "conhost.exe");
    // `start "" <conhost> powershell -NoExit -Command <title>`: the empty "" is start's window-title arg (so a
    // quoted exe path is never mistaken for the title); `-NoExit` leaves an interactive prompt for the human
    // (cooperative model, we never read its stdio); `-Command` applies the UNIQUE title. The title nonce is hex
    // (no cmd `&^%` metachars), so Node's default arg quoting is safe through cmd (dogfood-verified).
    const child = spawn(
      cmdExe,
      ["/c", "start", "", conhostExe, "powershell.exe", "-NoExit", "-Command", `$Host.UI.RawUI.WindowTitle = '${title}'`],
      { detached: true, stdio: "ignore", windowsHide: false },
    );
    child.on("error", () => { /* spawn failure surfaces as the poll timing out below */ });
    child.unref(); // never pin Node's loop on cmd's (or the console's) lifetime.
    // A failed spawn has no pid ⇒ nothing was launched ⇒ let the poll below time out.
    if (child.pid === undefined) throw new KeyLockerError("KeyLockerSpawnFailed", "cmd spawn returned no pid");

    // CLAIM BY UNIQUE TITLE — NOT by `child.pid`: under `cmd /c start`, `child.pid` is the transient cmd.exe,
    // never the conhost. The title is an 8-byte random nonce excluded against `before`, so a match is
    // unambiguously OUR console (consistent with `resolveTitleByHwnd` declining non-unique titles); after the
    // claim every read/inject is hwnd-keyed, so the title is a one-shot startup correlation only. `shellPid =
    // getWindowProcessId(hwnd)` is the SHELL (powershell) process that owns the console window — conhost is its
    // PARENT (dogfood-verified) — so `shellPid` is exactly the `sshDescendants` subtree root (ssh/sudo run as
    // CHILDREN of the shell). A window's owner pid can read 0 transiently during creation, so keep polling
    // until it resolves NON-ZERO (a 0 root would break the subtree walk).
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const fresh = enumWindowsInZOrder().find(
        (w) => w.className === CONSOLE_WINDOW_CLASS && !before.has(w.hwnd) && getWindowTitleW(w.hwnd) === title,
      );
      if (fresh !== undefined) {
        const shellPid = getWindowProcessId(fresh.hwnd);
        if (shellPid !== 0) return { hwnd: fresh.hwnd, shellPid, title };
      }
      if (this.now() >= deadline) {
        // Best-effort leak sweep: cmd.exe has already exited (`child.kill()` is a no-op), so if OUR nonce-titled
        // console DID appear late, kill it by owner pid — a timeout must not orphan a console. Bounded to one
        // sweep; a console materializing after this is a documented rare leak.
        const leaked = enumWindowsInZOrder().find(
          (w) => w.className === CONSOLE_WINDOW_CLASS && !before.has(w.hwnd) && getWindowTitleW(w.hwnd) === title,
        );
        if (leaked !== undefined) {
          const pid = getWindowProcessId(leaked.hwnd);
          if (pid !== 0) {
            try { spawn(join(sys32, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).unref(); }
            catch { /* best-effort */ }
          }
        }
        throw new KeyLockerError("KeyLockerSpawnFailed", "anchored console window did not appear");
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Consent state for `status` (readable Node-side without spawning the locker). */
  isConsentAccepted(): boolean {
    return consentAccepted(this.opts.storeDir);
  }

  isDisabled(): boolean {
    return keyLockerDisabled();
  }

  /**
   * Run `fn` with the live locker host, lazily starting it. THROWS before any spawn if the feature
   * is kill-switched (`KeyLockerError`) or consent is unaccepted (`KeyLockerConsentRequiredError`) —
   * the effects gate (L4 §2). The host is reused across calls; `dispose()` tears it down.
   */
  async withHost<T>(fn: (host: KeyLockerHost) => Promise<T>): Promise<T> {
    if (this.isDisabled()) {
      throw new KeyLockerDisabledError();
    }
    if (!this.isConsentAccepted()) {
      throw new KeyLockerConsentRequiredError();
    }
    // Count the op as in-flight BEFORE acquiring the host, so idle-dispose never tears the host down
    // mid-operation NOR during its lazy START (Opus R1 P2-B: `inFlight++` after `ensureHost` left the
    // start phase — and every post-idle restart — unguarded, so a racing `disposeIfIdle` could dispose
    // the host `fn` is about to use). Stamp the activity clock on completion (dormancy timer).
    this.inFlight++;
    try {
      const host = await this.ensureHost();
      return await fn(host);
    } finally {
      this.inFlight--;
      this.lastActivityMs = this.now();
    }
  }

  /**
   * Idle-dispose (dormancy): tear the live host down if no secret op has run for `idleMs`, so a locker
   * that spawned once but is no longer in use does not linger for the process lifetime (the long-lived-
   * resource discipline). The assembly calls this on a timer. Returns whether it disposed. NEVER disposes
   * while an op is in flight (`inFlight > 0`, which now spans the lazy start too) or when nothing is
   * live. `dispose()` awaits any in-flight start, so this is safe to race with a lazy `withHost`.
   */
  async disposeIfIdle(idleMs: number): Promise<boolean> {
    // `inFlight` now covers the whole withHost body incl. the start, so a start-in-flight is inFlight>0;
    // the `starting` check is belt-and-braces (no ensureHost path runs outside withHost).
    if (this.inFlight > 0 || this.starting !== null) return false;    // an op / start is running — not idle
    if (this.host === null) return false;                            // nothing live to dispose
    if (this.now() - this.lastActivityMs < idleMs) return false;      // used within the window
    await this.dispose();
    return true;
  }

  /**
   * Acquire first-run consent, prompting the user if needed (the ACQUIRE path; `withHost` only GATES).
   * The tool's `save` action calls this before capture. Idempotent: if consent is already accepted,
   * returns true WITHOUT spawning. Otherwise spawns the locker's SECRET-FREE `-Consent` dialog (allowed
   * pre-consent — the gate is on secret effects, not this spawn), waits for it, and RE-READS the flag as
   * the source of truth (the C# locker is the sole writer; Node never writes consent.json). Kill-switched
   * ⇒ throws `KeyLockerDisabledError` and never prompts. Concurrent calls share ONE dialog.
   */
  async ensureConsent(): Promise<boolean> {
    if (this.isDisabled()) throw new KeyLockerDisabledError();
    if (this.isConsentAccepted()) return true;
    this.consenting ??= this.spawnConsentDialog().finally(() => { this.consenting = null; });
    await this.consenting;
    return this.isConsentAccepted();
  }

  /**
   * Spawn `key-locker.exe -Consent` and resolve when it exits (exit code is ignored — `ensureConsent`
   * re-reads consent.json as the source of truth). A protected seam so tests inject a controllable
   * dialog without a real exe / GUI.
   */
  protected spawnConsentDialog(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(HELPER_EXE, ["-Consent", "-StoreDir", this.storeDir], { windowsHide: false });
      child.once("error", reject);            // exe missing / spawn failure
      child.once("exit", () => resolve());     // dialog closed (accepted or declined) — re-read decides
    });
  }

  /** Spawn the live locker host. A protected seam so tests can inject a controllable start. */
  protected startHost(): Promise<KeyLockerHost> {
    return KeyLockerHost.start(this.opts);
  }

  private async ensureHost(): Promise<KeyLockerHost> {
    if (this.host !== null) return this.host;
    if (this.starting !== null) return this.starting;
    this.starting = this.startHost()
      .then((h) => { this.host = h; this.starting = null; return h; })
      .catch((e) => { this.starting = null; throw e; });
    return this.starting;
  }

  /**
   * Tear down the live host (MCP shutdown / idle dormancy). Idempotent. If a start is IN FLIGHT, wait
   * for it first and dispose the host it produces — else a shutdown racing an in-flight `withHost` would
   * orphan the just-spawned `key-locker.exe` (the `starting` promise sets `this.host` AFTER dispose read
   * the still-null field — Opus PR#497 R1 P2 leak).
   */
  async dispose(): Promise<void> {
    const pending = this.starting;
    if (pending !== null) {
      try { await pending; } catch { /* start rejected — no host was created, nothing to dispose */ }
    }
    const h = this.host;
    this.host = null;
    this.starting = null;
    if (h !== null) await h.dispose();
  }
}
