import { describe, it, expect } from "vitest";
import { LeaseStore } from "../../src/engine/world-graph/lease-store.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

function entity(id: string, gen: string, digest?: string): UiEntity {
  return {
    entityId: id,
    role: "button",
    label: "Start",
    confidence: 0.9,
    sources: ["visual_gpu"],
    affordances: [],
    generation: gen,
    evidenceDigest: digest ?? `digest-${id}`,
  };
}

describe("LeaseStore — issuance", () => {
  it("issue returns a lease with correct fields", () => {
    const now = 10_000;
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 5000 });
    const e = entity("ent-1", "gen-1");
    const lease = store.issue(e, "view-1");
    expect(lease.entityId).toBe("ent-1");
    expect(lease.viewId).toBe("view-1");
    expect(lease.targetGeneration).toBe("gen-1");
    expect(lease.expiresAtMs).toBe(15_000);
    expect(lease.evidenceDigest).toBe("digest-ent-1");
  });

  it("custom ttlMs overrides default", () => {
    const now = 0;
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 5000 });
    const lease = store.issue(entity("e1", "g1"), "v1", 1000);
    expect(lease.expiresAtMs).toBe(1000);
  });

  it("re-issuing replaces the previous lease", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    const e = entity("e1", "gen-1");
    store.issue(e, "v1");
    now = 100;
    const lease2 = store.issue(e, "v2");
    expect(store.get("e1")).toEqual(lease2);
    expect(lease2.viewId).toBe("v2");
  });
});

describe("LeaseStore — validation: ok paths", () => {
  it("validates a fresh lease and returns the re-resolved entity", () => {
    const now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    const e = entity("e1", "gen-1");
    const lease = store.issue(e, "v1");
    const result = store.validate(lease, "gen-1", [e]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity).toEqual(e);
  });
});

describe("LeaseStore — validation: failure paths", () => {
  it("rejects expired lease", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const e = entity("e1", "gen-1");
    const lease = store.issue(e, "v1");
    now = 1001; // past TTL
    const result = store.validate(lease, "gen-1", [e]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects lease with mismatched generation", () => {
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const e = entity("e1", "gen-1");
    const lease = store.issue(e, "v1");
    const result = store.validate(lease, "gen-2", [e]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("generation_mismatch");
  });

  it("rejects lease when entity is no longer in live set", () => {
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const e = entity("e1", "gen-1");
    const lease = store.issue(e, "v1");
    const result = store.validate(lease, "gen-1", []); // empty live set
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });

  it("rejects lease when evidenceDigest has changed (entity mutated)", () => {
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const original = entity("e1", "gen-1", "digest-original");
    const lease = store.issue(original, "v1");
    const mutated = entity("e1", "gen-1", "digest-new");
    const result = store.validate(lease, "gen-1", [mutated]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("digest_mismatch");
  });

  it("validation order: expired is checked before generation_mismatch", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    const e = entity("e1", "gen-1");
    const lease = store.issue(e, "v1");
    now = 1001;
    const result = store.validate(lease, "gen-2", [e]); // both expired AND wrong gen
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });
});

describe("LeaseStore — eviction", () => {
  it("evictExpired removes expired leases", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 1000 });
    store.issue(entity("e1", "gen-1"), "v1");
    store.issue(entity("e2", "gen-1"), "v1");
    now = 500;
    store.issue(entity("e3", "gen-1"), "v1", 2000); // fresh
    now = 1001;
    store.evictExpired();
    expect(store.get("e1")).toBeUndefined();
    expect(store.get("e2")).toBeUndefined();
    expect(store.get("e3")).toBeDefined();
  });

  it("get returns undefined for un-issued entity", () => {
    const store = new LeaseStore();
    expect(store.get("no-such-id")).toBeUndefined();
  });
});

describe("LeaseStore — stale lease rejection (PoC gate)", () => {
  it("stale lease is rejected even if entity still exists — guarded touch must not proceed", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now, defaultTtlMs: 500 });
    const e = entity("btn-start", "gen-1");
    const lease = store.issue(e, "view-42");
    now = 600; // TTL exceeded
    const result = store.validate(lease, "gen-1", [e]);
    expect(result.ok).toBe(false);
    // Guarded touch MUST check ok===true before clicking
    expect(result.ok).not.toBe(true);
  });

  it("same entity re-resolved after generation bump → previous lease invalid", () => {
    const store = new LeaseStore({ nowFn: () => 0, defaultTtlMs: 60_000 });
    const e = entity("btn-start", "gen-1");
    const oldLease = store.issue(e, "view-1");
    // UI updated — generation bumped
    const newE = { ...e, generation: "gen-2" };
    const result = store.validate(oldLease, "gen-2", [newE]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("generation_mismatch");
  });
});
