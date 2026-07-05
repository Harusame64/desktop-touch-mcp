// ADR-014 v2 R3 L3 §6 / L4 §2 — KeyLockerManager + the first-run consent gate.
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l4-tool-surface-plan.md §2
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyLockerHost } from "../../src/engine/key-locker/key-locker-host.js";
import {
  KeyLockerConsentRequiredError,
  KeyLockerDisabledError,
  KeyLockerManager,
  consentAccepted,
  keyLockerDisabled,
} from "../../src/engine/key-locker/key-locker-manager.js";

/** A manager whose host start is a controllable fake (no real key-locker.exe) for lifecycle tests. */
class FakeHostManager extends KeyLockerManager {
  startCalls = 0;
  disposed = 0;
  private resolveStart: ((h: KeyLockerHost) => void) | null = null;
  private readonly fakeHost = { dispose: async () => { this.disposed++; } } as unknown as KeyLockerHost;
  /** A deferred start so a test can dispose WHILE the start is in flight. */
  readonly pendingStart = new Promise<KeyLockerHost>((res) => { this.resolveStart = res; });
  protected override startHost(): Promise<KeyLockerHost> {
    this.startCalls++;
    return this.pendingStart;
  }
  settleStart(): void { this.resolveStart?.(this.fakeHost); }
}

const dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "dtm-l4-mgr-"));
  dirs.push(d);
  return d;
};
const writeConsent = (dir: string, body: unknown): void =>
  writeFileSync(join(dir, "consent.json"), JSON.stringify(body), "utf8");

let savedDisable: string | undefined;
beforeEach(() => { savedDisable = process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER; delete process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER; });
afterEach(() => {
  if (savedDisable === undefined) delete process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER;
  else process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER = savedDisable;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("consentAccepted — fail-closed", () => {
  it("absent consent.json ⇒ false", () => {
    expect(consentAccepted(freshDir())).toBe(false);
  });
  it("well-formed {version:1, acceptedAt} ⇒ true", () => {
    const d = freshDir();
    writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() });
    expect(consentAccepted(d)).toBe(true);
  });
  it("corrupt / wrong-shape ⇒ false (fail closed)", () => {
    const d = freshDir();
    writeFileSync(join(d, "consent.json"), "{not json", "utf8");
    expect(consentAccepted(d)).toBe(false);
    writeConsent(d, { version: 99 });
    expect(consentAccepted(d)).toBe(false);
    writeConsent(d, { version: 1 }); // missing acceptedAt
    expect(consentAccepted(d)).toBe(false);
  });
});

describe("keyLockerDisabled — kill switch", () => {
  it("honors DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1", () => {
    expect(keyLockerDisabled()).toBe(false);
    process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER = "1";
    expect(keyLockerDisabled()).toBe(true);
  });
});

describe("KeyLockerManager.withHost — the effects gate (no spawn before consent)", () => {
  it("throws KeyLockerConsentRequired BEFORE any host spawn when consent is unset", async () => {
    const mgr = new KeyLockerManager({ storeDir: freshDir() });
    let ran = false;
    // The gate rejects before `fn` (and before ensureHost) runs — the callback never executes.
    await expect(mgr.withHost(async () => { ran = true; return "unreachable"; }))
      .rejects.toBeInstanceOf(KeyLockerConsentRequiredError);
    expect(ran).toBe(false);
    expect(mgr.isConsentAccepted()).toBe(false);
  });

  it("throws KeyLockerDisabled (distinct code, not a spawn error) when kill-switched, even with consent", async () => {
    const d = freshDir();
    writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() });
    process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER = "1";
    const mgr = new KeyLockerManager({ storeDir: d });
    // A distinct typed code so the tool layer gives a "you disabled this" hint, not "build the exe".
    await expect(mgr.withHost(async () => "x")).rejects.toBeInstanceOf(KeyLockerDisabledError);
    await expect(mgr.withHost(async () => "x")).rejects.toHaveProperty("code", "KeyLockerDisabled");
    expect(mgr.isDisabled()).toBe(true);
  });

  it("status is readable Node-side without spawning: consent + disabled flags", () => {
    const d = freshDir();
    const mgr = new KeyLockerManager({ storeDir: d });
    expect(mgr.isConsentAccepted()).toBe(false);
    expect(mgr.storeDir).toBe(d);
    writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() });
    expect(mgr.isConsentAccepted()).toBe(true);
  });

  it("dispose is idempotent with no live host", async () => {
    const mgr = new KeyLockerManager({ storeDir: freshDir() });
    await expect(mgr.dispose()).resolves.toBeUndefined();
    await expect(mgr.dispose()).resolves.toBeUndefined();
  });

  it("lazily starts ONE host and reuses it across withHost calls", async () => {
    const d = freshDir();
    writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() });
    const mgr = new FakeHostManager({ storeDir: d });
    mgr.settleStart(); // start resolves immediately
    const r1 = await mgr.withHost(async (h) => { expect(h).toBeDefined(); return "a"; });
    const r2 = await mgr.withHost(async () => "b");
    expect([r1, r2]).toEqual(["a", "b"]);
    expect(mgr.startCalls).toBe(1); // single host, reused
    await mgr.dispose();
    expect(mgr.disposed).toBe(1);
  });

  it("dispose WHILE a start is in flight waits for it and disposes the host (no orphan — Opus PR#497 R1 P2)", async () => {
    const d = freshDir();
    writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() });
    const mgr = new FakeHostManager({ storeDir: d });
    const inFlight = mgr.withHost(async () => "x"); // triggers startHost, start still pending
    const disposing = mgr.dispose();                // dispose races the in-flight start
    mgr.settleStart();                              // now the start resolves
    await Promise.all([inFlight, disposing]);
    expect(mgr.startCalls).toBe(1);
    expect(mgr.disposed).toBe(1); // the just-spawned host WAS torn down, not orphaned
  });
});
