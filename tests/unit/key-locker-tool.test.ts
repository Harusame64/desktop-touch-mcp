/**
 * key-locker-tool.test.ts — ADR-014 R3 L4 §1. Exercises the `key_locker` tool handler end to end with a
 * fake-host manager (no real key-locker.exe / dialog / ssh): action dispatch, the consent gate, the
 * management actions (list / status / set_policy), save/forget through a faked capture/delete, and the
 * no-secret-in-output invariant.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyLockerHost } from "../../src/engine/key-locker/key-locker-host.js";
import { KeyLockerManager } from "../../src/engine/key-locker/key-locker-manager.js";
import { BindingStore } from "../../src/engine/key-locker/binding-store.js";
import { keyLockerHandler, __setKeyLockerManagerForTest, __setSshExecForTest } from "../../src/tools/key-locker-tool.js";
import type { KeyLockerArgs } from "../../src/tools/key-locker-tool.js";
import type { ExecFn } from "../../src/engine/key-locker/ssh-resolve.js";

/** A manager whose host capture/delete + consent dialog are fakes (no exe / GUI / ssh). */
class FakeManager extends KeyLockerManager {
  captureCalls: string[] = [];
  deleteCalls: string[] = [];
  captureReturn = { captured: true, rt: true };
  acceptOnConsent = false;
  constructor(private readonly dir: string) {
    super({ storeDir: dir });
  }
  protected override startHost(): Promise<KeyLockerHost> {
    return Promise.resolve({
      capture: async (id: string) => { this.captureCalls.push(id); return this.captureReturn; },
      delete: async (id: string) => { this.deleteCalls.push(id); return true; },
      dispose: async () => {},
    } as unknown as KeyLockerHost);
  }
  protected override spawnConsentDialog(): Promise<void> {
    if (this.acceptOnConsent) {
      writeFileSync(join(this.dir, "consent.json"), JSON.stringify({ version: 1, acceptedAt: new Date().toISOString() }), "utf8");
    }
    return Promise.resolve();
  }
}

const dirs: string[] = [];
let mgr: FakeManager;
let dir: string;
let savedDisable: string | undefined;

const acceptConsent = (): void =>
  writeFileSync(join(dir, "consent.json"), JSON.stringify({ version: 1, acceptedAt: new Date().toISOString() }), "utf8");
const seed = (canonical: string, meta: Record<string, unknown>): void =>
  BindingStore.load(dir).bind(canonical, "aa".repeat(16), meta as never);

beforeEach(() => {
  savedDisable = process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER;
  delete process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER;
  dir = mkdtempSync(join(tmpdir(), "dtm-l4-tool-"));
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  mgr = new FakeManager(dir);
  __setKeyLockerManagerForTest(mgr);
});
afterEach(() => {
  __setKeyLockerManagerForTest(null);
  __setSshExecForTest(null);
  if (savedDisable === undefined) delete process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER;
  else process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER = savedDisable;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const call = async (args: KeyLockerArgs): Promise<Record<string, unknown>> =>
  JSON.parse((await keyLockerHandler(args)).content[0]!.text) as Record<string, unknown>;

describe("key_locker — status (exempt from the consent gate)", () => {
  it("reports consent + disabled + bindingCount without enabling", async () => {
    const s = await call({ action: "status" });
    expect(s).toMatchObject({ consentAccepted: false, disabled: false, bindingCount: 0, envInjectionEnabled: false });
  });
  it("reflects consent + saved bindings + the kill switch", async () => {
    acceptConsent();
    seed("sudo://host/root", { scheme: "sudo", displayUri: "sudo://host/root", host: "host", targetUser: "root", createdAt: new Date().toISOString() });
    process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER = "1";
    const s = await call({ action: "status" });
    expect(s).toMatchObject({ consentAccepted: true, disabled: true, bindingCount: 1 });
  });
});

describe("key_locker — the consent gate (every action except status)", () => {
  it("list / forget / set_policy fail with KeyLockerConsentRequired when consent is unset", async () => {
    for (const args of [
      { action: "list" },
      { action: "forget", uri: "sudo://host/root" },
      { action: "set_policy", uri: "sudo://host/root", confirmEveryInjection: true },
    ] as KeyLockerArgs[]) {
      const r = await call(args);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("KeyLockerConsentRequired");
    }
  });
});

describe("key_locker — list", () => {
  it("returns non-secret metadata (confirmEveryInjection defaults TRUE = confirm), no opaqueId/secret", async () => {
    acceptConsent();
    seed("sudo://host/root", { scheme: "sudo", displayUri: "sudo://host/root", host: "host", targetUser: "root", createdAt: "2026-07-05T00:00:00.000Z" });
    const r = await call({ action: "list" });
    const bindings = r.bindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(1);
    // Unset policy ⇒ RESOLVED confirm=true (matches the capture-loop's `?? true` backstop, not `?? false`).
    expect(bindings[0]).toEqual({ displayUri: "sudo://host/root", scheme: "sudo", host: "host", createdAt: "2026-07-05T00:00:00.000Z", confirmEveryInjection: true });
    // No secret / opaqueId / targetUser leak in the tool output.
    expect(JSON.stringify(r)).not.toContain("aa".repeat(16));
    expect(bindings[0]).not.toHaveProperty("opaqueId");
  });
});

describe("key_locker — save (non-ssh, faked capture)", () => {
  it("declined consent → KeyLockerConsentRequired, nothing stored", async () => {
    mgr.acceptOnConsent = false;
    const r = await call({ action: "save", uri: "sudo://host/root" });
    expect(r.code).toBe("KeyLockerConsentRequired");
    expect(BindingStore.load(dir).list()).toHaveLength(0);
  });
  it("accepted consent + captured → binds the credential", async () => {
    mgr.acceptOnConsent = true;
    const r = await call({ action: "save", uri: "sudo://host/root" });
    expect(r).toMatchObject({ captured: true });
    expect(mgr.captureCalls).toHaveLength(1);
    const rows = BindingStore.load(dir).list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scheme: "sudo", host: "host", targetUser: "root", opaqueId: mgr.captureCalls[0] });
  });
  it("cancelled dialog (captured:false) → no binding written", async () => {
    mgr.acceptOnConsent = true;
    mgr.captureReturn = { captured: false, rt: false };
    const r = await call({ action: "save", uri: "sudo://host/root" });
    expect(r).toMatchObject({ captured: false });
    expect(BindingStore.load(dir).list()).toHaveLength(0);
  });
  it("a malformed URI is a typed reject", async () => {
    mgr.acceptOnConsent = true;
    const r = await call({ action: "save", uri: "not-a-uri" });
    expect(r.ok).toBe(false);
  });
});

describe("key_locker — save (ssh, faked ssh -G / ssh-keygen exec) — #500 P3-3 parity lock", () => {
  it("routes ssh through resolveCanonicalForSshCommand and binds under the RESOLVED canonical (fp tail)", async () => {
    mgr.acceptOnConsent = true;
    // A real known_hosts file so the resolver's existsSync() passes; its bytes are irrelevant (the
    // faked ssh-keygen returns the fingerprint regardless — we are pinning the tool's ROUTING, not ssh).
    const kh = join(dir, "known_hosts");
    writeFileSync(kh, "real.example.com ssh-ed25519 AAAAdummy\n", "utf8");
    const fp = "SHA256:ABCdef0123456789ABCdef0123456789ABCdef01234";
    const fakeExec: ExecFn = async (file, args) => {
      if (file === "ssh" && args[0] === "-G") {
        return { code: 0, stdout: `hostname real.example.com\nuser bob\nport 22\nuserknownhostsfile ${kh}\n`, stderr: "" };
      }
      if (file === "ssh-keygen") return { code: 0, stdout: `1 ${fp} real.example.com\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected exec" };
    };
    __setSshExecForTest(fakeExec);

    const r = await call({ action: "save", uri: "ssh://bob@real.example.com" });
    expect(r).toMatchObject({ captured: true });
    expect(mgr.captureCalls).toHaveLength(1);
    const rows = BindingStore.load(dir).list();
    expect(rows).toHaveLength(1);
    // Bound under the resolver's canonical (the fp-set tail the capture-loop's deriveBinding also
    // produces — save↔derive key parity), NOT a raw URI; the secret sits under the same opaqueId.
    expect(rows[0]).toMatchObject({ scheme: "ssh", host: "real.example.com", user: "bob", port: 22, fpSet: [fp], opaqueId: mgr.captureCalls[0] });
    expect(rows[0].canonicalKey).toContain("|fp=");
  });

  it("host-not-known (empty fp union) → KeyLockerSshUnresolved, fails closed BEFORE capture", async () => {
    mgr.acceptOnConsent = true;
    const fakeExec: ExecFn = async (file, args) => {
      if (file === "ssh" && args[0] === "-G") {
        // A known_hosts path that does not exist ⇒ existsSync false ⇒ empty union ⇒ host-not-known.
        return { code: 0, stdout: `hostname new.example.com\nuser bob\nport 22\nuserknownhostsfile ${join(dir, "absent_known_hosts")}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    __setSshExecForTest(fakeExec);

    const r = await call({ action: "save", uri: "ssh://bob@new.example.com" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("KeyLockerSshUnresolved");
    expect(BindingStore.load(dir).list()).toHaveLength(0);
    expect(mgr.captureCalls).toHaveLength(0); // no dialog opened — resolution fails closed first
  });
});

describe("key_locker — forget", () => {
  it("removes the binding and deletes the locker secret", async () => {
    acceptConsent();
    seed("sudo://host/root", { scheme: "sudo", displayUri: "sudo://host/root", host: "host", targetUser: "root", createdAt: new Date().toISOString() });
    const r = await call({ action: "forget", uri: "sudo://host/root" });
    expect(r).toMatchObject({ removed: true });
    expect(mgr.deleteCalls).toEqual(["aa".repeat(16)]);
    expect(BindingStore.load(dir).list()).toHaveLength(0);
  });
  it("an unknown binding → KeyLockerNoSuchBinding", async () => {
    acceptConsent();
    const r = await call({ action: "forget", uri: "sudo://nope/root" });
    expect(r.code).toBe("KeyLockerNoSuchBinding");
  });
});

describe("key_locker — set_policy", () => {
  it("flips confirmEveryInjection on a saved binding", async () => {
    acceptConsent();
    seed("sudo://host/root", { scheme: "sudo", displayUri: "sudo://host/root", host: "host", targetUser: "root", createdAt: new Date().toISOString() });
    const r = await call({ action: "set_policy", uri: "sudo://host/root", confirmEveryInjection: true });
    expect(r).toMatchObject({ updated: true });
    expect(BindingStore.load(dir).list()[0].confirmEveryInjection).toBe(true);
  });
  it("an unknown binding → KeyLockerNoSuchBinding", async () => {
    acceptConsent();
    const r = await call({ action: "set_policy", uri: "sudo://nope/root", confirmEveryInjection: true });
    expect(r.code).toBe("KeyLockerNoSuchBinding");
  });
});

describe("key_locker — kill switch", () => {
  it("save while disabled → KeyLockerDisabled (never prompts / captures)", async () => {
    process.env.DESKTOP_TOUCH_DISABLE_KEY_LOCKER = "1";
    mgr.acceptOnConsent = true;
    const r = await call({ action: "save", uri: "sudo://host/root" });
    expect(r.code).toBe("KeyLockerDisabled");
    expect(mgr.captureCalls).toHaveLength(0);
  });
});
