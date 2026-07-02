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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyLockerError, KeyLockerHost, type KeyLockerStartOptions } from "../key-locker-host.js";

/** Typed reject when a secret op is attempted before first-run consent is accepted (L4 §2). */
export class KeyLockerConsentRequiredError extends Error {
  readonly code = "KeyLockerConsentRequired";
  constructor() {
    super("KeyLockerConsentRequired: the key locker must be enabled once before it can store or fill secrets");
    this.name = "KeyLockerConsentRequiredError";
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
  if (!existsSync(path)) return false;
  try {
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

  constructor(private readonly opts: KeyLockerManagerOptions = {}) {}

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
      throw new KeyLockerError("KeyLockerSpawnFailed", "key locker is disabled (DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1)");
    }
    if (!this.isConsentAccepted()) {
      throw new KeyLockerConsentRequiredError();
    }
    const host = await this.ensureHost();
    return fn(host);
  }

  private async ensureHost(): Promise<KeyLockerHost> {
    if (this.host !== null) return this.host;
    if (this.starting !== null) return this.starting;
    this.starting = KeyLockerHost.start(this.opts)
      .then((h) => { this.host = h; this.starting = null; return h; })
      .catch((e) => { this.starting = null; throw e; });
    return this.starting;
  }

  /** Tear down the live host (MCP shutdown / idle dormancy). Idempotent. */
  async dispose(): Promise<void> {
    const h = this.host;
    this.host = null;
    if (h !== null) await h.dispose();
  }
}
