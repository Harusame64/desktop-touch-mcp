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

/** A manager whose host start + consent dialog are controllable fakes (no real key-locker.exe / GUI). */
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

  // Consent-dialog fake: counts spawns; `onConsent` (test hook) simulates what the C# -Consent dialog
  // would do on [Enable] (write consent.json); a deferred promise lets a test race concurrent calls.
  consentCalls = 0;
  onConsent: (() => void) | null = null;
  private resolveConsent: (() => void) | null = null;
  readonly pendingConsent = new Promise<void>((res) => { this.resolveConsent = res; });
  protected override spawnConsentDialog(): Promise<void> {
    this.consentCalls++;
    return this.pendingConsent;
  }
  /** Simulate the dialog closing: run the [Enable] side effect (if any), then resolve the spawn. */
  settleConsent(): void { this.onConsent?.(); this.resolveConsent?.(); }
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

describe("KeyLockerManager.ensureConsent — the acquire path", () => {
  it("already accepted ⇒ returns true WITHOUT spawning the dialog", async () => {
    const d = freshDir();
    writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() });
    const mgr = new FakeHostManager({ storeDir: d });
    await expect(mgr.ensureConsent()).resolves.toBe(true);
    expect(mgr.consentCalls).toBe(0); // no dialog when consent already exists
  });

  it("unaccepted ⇒ spawns the dialog; [Enable] writes consent.json ⇒ returns true (re-read is source of truth)", async () => {
    const d = freshDir();
    const mgr = new FakeHostManager({ storeDir: d });
    mgr.onConsent = () => writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() }); // simulate [Enable]
    const p = mgr.ensureConsent();
    mgr.settleConsent();
    await expect(p).resolves.toBe(true);
    expect(mgr.consentCalls).toBe(1);
  });

  it("unaccepted ⇒ [Not now] writes nothing ⇒ returns false (fail-closed)", async () => {
    const d = freshDir();
    const mgr = new FakeHostManager({ storeDir: d });
    // onConsent left null → the dialog wrote no consent.json (declined)
    const p = mgr.ensureConsent();
    mgr.settleConsent();
    await expect(p).resolves.toBe(false);
    expect(mgr.consentCalls).toBe(1);
  });

  it("concurrent ensureConsent calls share ONE dialog (deduped)", async () => {
    const d = freshDir();
    const mgr = new FakeHostManager({ storeDir: d });
    mgr.onConsent = () => writeConsent(d, { version: 1, acceptedAt: new Date().toISOString() });
    const p1 = mgr.ensureConsent();
    const p2 = mgr.ensureConsent();
    mgr.settleConsent();
    await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
    expect(mgr.consentCalls).toBe(1); // a single -Consent spawn served both callers
  });

  it("kill-switched ⇒ throws KeyLockerDisabled and never prompts", async () => {
    process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER = "1";
    const mgr = new FakeHostManager({ storeDir: freshDir() });
    await expect(mgr.ensureConsent()).rejects.toBeInstanceOf(KeyLockerDisabledError);
    expect(mgr.consentCalls).toBe(0);
  });
});

describe("KeyLockerManager.disposeIfIdle — dormancy", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("returns false when nothing is live", async () => {
    const mgr = new FakeHostManager({ storeDir: freshDir(), now: () => 999_999 });
    expect(await mgr.disposeIfIdle(0)).toBe(false);
  });

  it("disposes a live host only after the idle window; a later op lazily re-starts", async () => {
    const d = freshDir();
    writeConsent(d, { version: 1, acceptedAt: "2026-07-06T00:00:00.000Z" });
    let clock = 1_000;
    const mgr = new FakeHostManager({ storeDir: d, now: () => clock });

    const first = mgr.withHost(async () => "x");
    mgr.settleStart();
    expect(await first).toBe("x");
    expect(mgr.startCalls).toBe(1);

    // Still within the window ⇒ no dispose.
    expect(await mgr.disposeIfIdle(5_000)).toBe(false);
    expect(mgr.disposed).toBe(0);

    // Past the idle window ⇒ dispose.
    clock += 6_000;
    expect(await mgr.disposeIfIdle(5_000)).toBe(true);
    expect(mgr.disposed).toBe(1);
    // Idempotent: nothing live now.
    expect(await mgr.disposeIfIdle(5_000)).toBe(false);

    // A later secret op re-starts the host (the resolved start promise re-runs).
    const second = mgr.withHost(async () => "y");
    expect(await second).toBe("y");
    expect(mgr.startCalls).toBe(2);
  });

  it("never disposes while an op is IN FLIGHT, even past the window", async () => {
    const d = freshDir();
    writeConsent(d, { version: 1, acceptedAt: "2026-07-06T00:00:00.000Z" });
    let clock = 1_000;
    const mgr = new FakeHostManager({ storeDir: d, now: () => clock });

    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const op = mgr.withHost(async () => { await gate; return "done"; });
    mgr.settleStart();
    await flush(); // let withHost pass ensureHost + enter the try (inFlight++)

    clock += 100_000; // far past any window
    expect(await mgr.disposeIfIdle(5_000)).toBe(false); // op in flight ⇒ not idle
    expect(mgr.disposed).toBe(0);

    release!();
    expect(await op).toBe("done");
    // The completed op just refreshed the dormancy timer, so advance past the window again before it
    // is eligible to dispose.
    clock += 6_000;
    expect(await mgr.disposeIfIdle(5_000)).toBe(true);
    expect(mgr.disposed).toBe(1);
  });
});
