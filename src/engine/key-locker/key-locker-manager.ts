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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HELPER_EXE, KeyLockerHost, type KeyLockerStartOptions } from "../key-locker-host.js";

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

  constructor(private readonly opts: KeyLockerManagerOptions = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The store dir this manager reads consent + bindings from. */
  get storeDir(): string {
    return this.opts.storeDir ?? defaultStoreDir();
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
    const host = await this.ensureHost();
    // Count the op as in-flight so idle-dispose never tears the host down mid-operation (e.g. while a
    // capture dialog is open for minutes); stamp the activity clock on completion (dormancy timer).
    this.inFlight++;
    try {
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
   * while an op is in flight (`inFlight > 0`) or when nothing is live. `dispose()` awaits any in-flight
   * start, so this is safe to race with a lazy `withHost`.
   */
  async disposeIfIdle(idleMs: number): Promise<boolean> {
    if (this.inFlight > 0) return false;                              // an op is running — not idle
    if (this.host === null && this.starting === null) return false;   // nothing live to dispose
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
