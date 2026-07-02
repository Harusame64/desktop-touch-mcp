// ADR-014 v2 R3 L1 — acceptance §8 #7: store CRUD + reconciliation + atomicity.
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BindingStore, LockerNotBoundError, type BindingMeta } from "../../src/engine/key-locker/binding-store.js";

const dirs: string[] = [];
const freshDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "dtm-l1-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const meta = (over: Partial<BindingMeta> = {}): BindingMeta => ({
  scheme: "sudo",
  displayUri: "sudo://localhost/root",
  host: "localhost",
  targetUser: "root",
  createdAt: new Date().toISOString(),
  ...over,
});

const alwaysExists = async (): Promise<boolean> => true;

describe("BindingStore — CRUD round-trip", () => {
  it("bind → resolve → list → unbind, persisted across a reload", async () => {
    const dir = freshDir();
    const store = BindingStore.load(dir, alwaysExists);
    store.bind("sudo://localhost/root", "aa".repeat(16), meta());
    expect(await store.resolve("sudo://localhost/root")).toEqual({ opaqueId: "aa".repeat(16) });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ canonicalKey: "sudo://localhost/root", scheme: "sudo" });

    // Reload from disk — the row survived the atomic save.
    const reloaded = BindingStore.load(dir, alwaysExists);
    expect(await reloaded.resolve("sudo://localhost/root")).toEqual({ opaqueId: "aa".repeat(16) });

    expect(reloaded.unbind("sudo://localhost/root")).toBe(true);
    expect(reloaded.unbind("sudo://localhost/root")).toBe(false);
    expect(await reloaded.resolve("sudo://localhost/root")).toBeUndefined();
  });

  it("resolve misses an unknown canonical without touching the locker", async () => {
    let lockerCalls = 0;
    const store = BindingStore.load(freshDir(), async () => { lockerCalls++; return true; });
    expect(await store.resolve("sudo://nowhere/root")).toBeUndefined();
    expect(lockerCalls).toBe(0);
  });
});

describe("BindingStore — locker reconciliation (§5.3)", () => {
  it("resolve prunes a stale row when the locker no longer holds the secret", async () => {
    const dir = freshDir();
    const store = BindingStore.load(dir, async () => false); // locker lost everything
    store.bind("sudo://localhost/root", "bb".repeat(16), meta());
    expect(await store.resolve("sudo://localhost/root")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    // The prune was persisted, not just in-memory.
    expect(BindingStore.load(dir, alwaysExists).list()).toHaveLength(0);
  });

  it("reconcile bulk-prunes only the stale rows and reports the count", async () => {
    const dir = freshDir();
    const live = new Set(["cc".repeat(16)]);
    const store = BindingStore.load(dir, async (id) => live.has(id));
    store.bind("sudo://localhost/root", "cc".repeat(16), meta());
    store.bind("sudo://localhost/deploy", "dd".repeat(16), meta({ targetUser: "deploy" }));
    store.bind("https-cred://github.com:443", "ee".repeat(16), meta({ scheme: "https-cred", displayUri: "https-cred://github.com" }));
    expect(await store.reconcile()).toBe(2);
    expect(store.list().map((r) => r.opaqueId)).toEqual(["cc".repeat(16)]);
  });

  it("management-only store (no existsInLocker): bind/list work, resolve/reconcile throw typed", async () => {
    const store = BindingStore.load(freshDir());
    store.bind("sudo://localhost/root", "ff".repeat(16), meta());
    expect(store.list()).toHaveLength(1);
    await expect(store.resolve("sudo://localhost/root")).rejects.toBeInstanceOf(LockerNotBoundError);
    await expect(store.reconcile()).rejects.toBeInstanceOf(LockerNotBoundError);
  });
});

describe("BindingStore — file tolerance + atomic save", () => {
  it("corrupt bindings.json ⇒ starts empty, preserving the original as .corrupt", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "bindings.json"), "{not json!!", "utf8");
    const store = BindingStore.load(dir, alwaysExists);
    expect(store.list()).toHaveLength(0);
    expect(existsSync(join(dir, "bindings.json.corrupt"))).toBe(true);
  });

  it("wrong-shape file (valid JSON, not our schema) is treated as corrupt", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "bindings.json"), JSON.stringify({ version: 99, whatever: [] }), "utf8");
    expect(BindingStore.load(dir, alwaysExists).list()).toHaveLength(0);
  });

  it("a stale .tmp from a simulated mid-write crash never shadows the real file", async () => {
    const dir = freshDir();
    const store = BindingStore.load(dir, alwaysExists);
    store.bind("sudo://localhost/root", "aa".repeat(16), meta());
    // Simulate a crash mid-save: a half-written tmp sits next to an intact real file.
    writeFileSync(join(dir, "bindings.json.tmp"), "{half-writ", "utf8");
    const reloaded = BindingStore.load(dir, alwaysExists);
    expect(await reloaded.resolve("sudo://localhost/root")).toEqual({ opaqueId: "aa".repeat(16) });
    // The next save replaces both atomically.
    reloaded.bind("sudo://localhost/deploy", "bb".repeat(16), meta({ targetUser: "deploy" }));
    expect(JSON.parse(readFileSync(join(dir, "bindings.json"), "utf8")).version).toBe(1);
  });

  it("no secret-shaped field ever lands in bindings.json", () => {
    const dir = freshDir();
    const store = BindingStore.load(dir, alwaysExists);
    store.bind("sudo://localhost/root", "aa".repeat(16), meta());
    const raw = readFileSync(join(dir, "bindings.json"), "utf8");
    // The file carries exactly the §5.1 shape: URIs, ids, timestamps — assert the keys we wrote.
    const parsed = JSON.parse(raw) as { bindings: Record<string, Record<string, unknown>> };
    expect(Object.keys(parsed.bindings["sudo://localhost/root"]).sort()).toEqual(
      ["createdAt", "displayUri", "host", "opaqueId", "scheme", "targetUser"].sort(),
    );
  });
});
