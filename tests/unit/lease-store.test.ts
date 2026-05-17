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

// ADR-020 PR-P2-2: recordAct / consumeObservedRoundTripMs round-trip semantics.
describe("LeaseStore — observedRoundTripMs (ADR-020 PR-P2-2)", () => {
  it("returns undefined before any act is recorded", () => {
    const store = new LeaseStore({ nowFn: () => 100 });
    expect(store.consumeObservedRoundTripMs()).toBeUndefined();
  });

  it("returns nowFn() - lastActAtMs after recordAct", () => {
    let now = 1_000;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");        // lastActAtMs = 1_000
    now = 17_500;                       // simulate 16.5s LLM thinking + tool call
    expect(store.consumeObservedRoundTripMs()).toBe(16_500);
  });

  it("is read-once: subsequent consume returns undefined until next recordAct", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");
    now = 5_000;
    expect(store.consumeObservedRoundTripMs()).toBe(5_000);
    // second consume without an intervening act gets undefined (not stale)
    now = 10_000;
    expect(store.consumeObservedRoundTripMs()).toBeUndefined();
  });

  it("a fresh recordAct after consume re-arms the next round-trip measurement", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");
    now = 5_000;
    expect(store.consumeObservedRoundTripMs()).toBe(5_000);   // cleared
    now = 6_000;
    store.recordAct("view-1");                                  // re-arm
    now = 20_000;
    expect(store.consumeObservedRoundTripMs()).toBe(14_000);  // 20_000 - 6_000
  });

  it("recordAct overwrites a prior unconsumed timestamp (latest act wins)", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");        // lastActAtMs = 0
    now = 1_000;
    store.recordAct("view-1");        // overwrite → lastActAtMs = 1_000
    now = 4_000;
    expect(store.consumeObservedRoundTripMs()).toBe(3_000);   // 4_000 - 1_000
  });
});

// ADR-020 PR-P2-2 Codex Round 2/3/4 fix: peek + CAS-guarded commit
// (sampleSeq monotonic token) preserves the round-trip sample across
// transient see() failures, against concurrent recordAct(), AND against
// same-millisecond timestamp collisions.
describe("LeaseStore — peek + CAS commit pattern (ADR-020 PR-P2-2 Codex R2/R3/R4)", () => {
  it("peek returns { elapsedMs, sampleSeq } without clearing the sample", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");           // lastActAtMs = 0, lastActSeq = 1
    now = 5_000;
    const first = store.peekObservedRoundTripMs();
    expect(first).toEqual({ elapsedMs: 5_000, sampleSeq: 1 });
    // repeated peek returns same value (peek does NOT clear)
    expect(store.peekObservedRoundTripMs()).toEqual({ elapsedMs: 5_000, sampleSeq: 1 });
  });

  it("peek returns undefined when no act has been recorded", () => {
    const store = new LeaseStore({ nowFn: () => 100 });
    expect(store.peekObservedRoundTripMs()).toBeUndefined();
  });

  it("CAS commit (matching token) clears the staged sample", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");
    now = 3_000;
    const peeked = store.peekObservedRoundTripMs();
    expect(peeked).toEqual({ elapsedMs: 3_000, sampleSeq: 1 });
    store.commitObservedRoundTripMs(peeked!.sampleSeq);
    expect(store.peekObservedRoundTripMs()).toBeUndefined();
  });

  it("CAS commit with a stale token is a no-op (does not clear newer sample)", () => {
    // Concurrent-act race (Round 3):
    //   1. see()-A peeks (seq=1)
    //   2. ... see()-A awaits snapshot ...
    //   3. another desktop_act recordAct() (seq=2, newer)
    //   4. see()-A's commit(seq=1) must NOT stomp the newer sample
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");                                // seq=1
    const peeked = store.peekObservedRoundTripMs();
    expect(peeked?.sampleSeq).toBe(1);
    // concurrent recordAct between peek and commit
    now = 2_000;
    store.recordAct("view-1");                                // seq=2 (newer)
    // see()-A's stale-token commit must be a no-op
    store.commitObservedRoundTripMs(peeked!.sampleSeq);       // commit(1) → no-op
    now = 5_000;
    // newer sample preserved for the next see()
    expect(store.peekObservedRoundTripMs()).toEqual({ elapsedMs: 3_000, sampleSeq: 2 });
  });

  it("CAS commit is immune to same-millisecond timestamp collisions (Codex R4)", () => {
    // Round 4 race: two recordAct() in the same nowFn() ms tick.
    // With timestamp-based tokens, both would share token=t and a stale
    // commit could clear the newer sample on numeric equality. The
    // monotonic seq token never collides.
    let now = 1_000;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");                                // seq=1, sampleAtMs=1_000
    const peeked = store.peekObservedRoundTripMs();           // seq=1
    expect(peeked?.sampleSeq).toBe(1);

    // Second recordAct in the SAME millisecond (now still 1_000)
    store.recordAct("view-1");                                // seq=2, sampleAtMs=1_000 (same ms!)
    // peek-A's stale commit must not stomp the newer sample
    store.commitObservedRoundTripMs(peeked!.sampleSeq);       // commit(1) → no-op
    // newer sample (seq=2) preserved
    now = 6_000;
    expect(store.peekObservedRoundTripMs()).toEqual({ elapsedMs: 5_000, sampleSeq: 2 });
  });

  it("commit without a staged sample is a no-op (does not throw)", () => {
    const store = new LeaseStore({ nowFn: () => 0 });
    expect(() => store.commitObservedRoundTripMs(0)).not.toThrow();
    expect(store.peekObservedRoundTripMs()).toBeUndefined();
  });

  it("peek-without-commit preserves the sample across a simulated see() failure", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");

    now = 4_000;
    expect(store.peekObservedRoundTripMs()).toEqual({ elapsedMs: 4_000, sampleSeq: 1 });
    // simulate throw — no commit happens

    now = 9_000;
    const peeked = store.peekObservedRoundTripMs();
    expect(peeked).toEqual({ elapsedMs: 9_000, sampleSeq: 1 });
    store.commitObservedRoundTripMs(peeked!.sampleSeq);
    expect(store.peekObservedRoundTripMs()).toBeUndefined();
  });

  it("consumeObservedRoundTripMs (BC shorthand) returns elapsedMs and clears unconditionally", () => {
    let now = 0;
    const store = new LeaseStore({ nowFn: () => now });
    store.recordAct("view-1");
    now = 7_000;
    expect(store.consumeObservedRoundTripMs()).toBe(7_000);
    expect(store.peekObservedRoundTripMs()).toBeUndefined();
  });
});
