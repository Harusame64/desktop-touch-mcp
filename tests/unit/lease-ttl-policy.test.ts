import { describe, it, expect } from "vitest";
import {
  computeLeaseTtlMs,
  computeSoftExpiresAtMs,
  LEASE_TTL_POLICY,
} from "../../src/engine/world-graph/lease-ttl-policy.js";

// ADR-020 PR-P2-2: computeLeaseTtlMs return shape is now { ttlMs, refreshRequired }.
// Existing assertions previously read the bare number; they now read .ttlMs and
// (implicitly) refreshRequired === false for inputs without observedRoundTripMs.

describe("computeLeaseTtlMs — view dimension", () => {
  it("action view has no bonus (base 15000ms)", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5 })).toEqual({ ttlMs: 15_000, refreshRequired: false });
  });

  it("undefined view defaults to action", () => {
    expect(computeLeaseTtlMs({ view: undefined, entityCount: 5 })).toEqual({ ttlMs: 15_000, refreshRequired: false });
  });

  it("explore view adds 5000ms bonus", () => {
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 5 })).toEqual({ ttlMs: 20_000, refreshRequired: false });
  });

  it("debug view adds 10000ms bonus", () => {
    expect(computeLeaseTtlMs({ view: "debug", entityCount: 5 })).toEqual({ ttlMs: 25_000, refreshRequired: false });
  });

  it("explore TTL is strictly greater than action TTL for same entityCount", () => {
    const a = computeLeaseTtlMs({ view: "action",  entityCount: 30 });
    const e = computeLeaseTtlMs({ view: "explore", entityCount: 30 });
    expect(e.ttlMs).toBeGreaterThan(a.ttlMs);
  });
});

describe("computeLeaseTtlMs — entity count dimension", () => {
  it("entityCount <= 20 yields no bonus", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 0  }).ttlMs).toBe(15_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 20 }).ttlMs).toBe(15_000);
  });

  it("each entity above 20 adds 100ms", () => {
    // action(base 15000) + (40 - 20) * 100 = 17000
    expect(computeLeaseTtlMs({ view: "action",  entityCount: 40 }).ttlMs).toBe(17_000);
    // explore(base 20000) + (50 - 20) * 100 = 23000
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 50 }).ttlMs).toBe(23_000);
  });

  it("bonus is monotonically non-decreasing in entityCount (same view)", () => {
    let prev = -1;
    for (let n = 0; n <= 100; n += 5) {
      const r = computeLeaseTtlMs({ view: "explore", entityCount: n });
      expect(r.ttlMs).toBeGreaterThanOrEqual(prev);
      prev = r.ttlMs;
    }
  });
});

describe("computeLeaseTtlMs — clamping", () => {
  it("clamps to cap (60000ms) even for extreme inputs", () => {
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 10_000 }).ttlMs).toBe(60_000);
    expect(computeLeaseTtlMs({ view: "debug",   entityCount: 10_000 }).ttlMs).toBe(60_000);
  });

  it("floor (2000ms) is respected (defensive lower bound)", () => {
    const minTtl = computeLeaseTtlMs({ view: "action", entityCount: 0 }).ttlMs;
    expect(minTtl).toBeGreaterThanOrEqual(LEASE_TTL_POLICY.floor);
  });
});

describe("computeLeaseTtlMs — invariants", () => {
  it("never returns a non-finite or negative number", () => {
    for (const view of ["action", "explore", "debug", undefined] as const) {
      for (const n of [0, 1, 20, 50, 100, 500]) {
        const r = computeLeaseTtlMs({ view, entityCount: n });
        expect(Number.isFinite(r.ttlMs)).toBe(true);
        expect(r.ttlMs).toBeGreaterThan(0);
        expect(typeof r.refreshRequired).toBe("boolean");
      }
    }
  });
});

// No-compromise lease A: payload-size aware TTL + soft expiry. Larger
// responses give the LLM more text to read before deciding the next call,
// so the TTL window expands with payloadBytes (capped so a multi-megabyte
// outlier can't push the cap to absurd values).
describe("computeLeaseTtlMs — payload-size dimension", () => {
  it("payloadBytes <= baseline yields no payload bonus", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 0    }).ttlMs).toBe(15_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 2000 }).ttlMs).toBe(15_000);
  });

  it("each byte over baseline adds 0.5ms", () => {
    // 15_000 base + (10_000 - 2_000) * 0.5 = 15_000 + 4_000 = 19_000
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 10_000 }).ttlMs).toBe(19_000);
  });

  it("payload bonus is itself capped at 10000ms", () => {
    const r = computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 1_000_000 });
    // base(15000) + payloadCap(10000) = 25000
    expect(r.ttlMs).toBe(25_000);
  });

  it("payloadBytes undefined / NaN / negative is silently treated as zero (defensive)", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5 }).ttlMs).toBe(15_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: NaN  }).ttlMs).toBe(15_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: -100 }).ttlMs).toBe(15_000);
  });

  it("all bonuses stack and respect the cap", () => {
    // explore(+5000) + entityBonus((50-20)*100=3000) + payloadCap(10000)
    // base(15000) + 5000 + 3000 + 10000 = 33000  (still under cap 60000)
    const r = computeLeaseTtlMs({ view: "explore", entityCount: 50, payloadBytes: 100_000 });
    expect(r.ttlMs).toBe(33_000);
  });
});

// ADR-020 PR-P2-2 (F refactor): observedRoundTripMs 2-branch contract.
describe("computeLeaseTtlMs — observedRoundTripMs 2-branch contract (F)", () => {
  describe("branch (a): observedRoundTripMs ≤ cap → ttlMs ≥ observedRoundTripMs, refreshRequired === false", () => {
    it("returns policy raw when observedRoundTripMs is below it (raw wins)", () => {
      // base 15000 > observed 5000 → ttlMs = 15000
      const r = computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: 5_000 });
      expect(r.ttlMs).toBe(15_000);
      expect(r.refreshRequired).toBe(false);
    });

    it("returns observed value when above policy raw (observed wins)", () => {
      // base 15000 < observed 30000 → ttlMs = 30000
      const r = computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: 30_000 });
      expect(r.ttlMs).toBe(30_000);
      expect(r.refreshRequired).toBe(false);
    });

    it("ttlMs ≥ observedRoundTripMs invariant holds across a wide range below cap", () => {
      for (const observed of [1, 100, 1_000, 5_000, 15_000, 30_000, 45_000, 59_999]) {
        const r = computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: observed });
        expect(r.ttlMs).toBeGreaterThanOrEqual(observed);
        expect(r.refreshRequired).toBe(false);
      }
    });

    it("respects cap when policy raw + entity bonus would otherwise exceed it", () => {
      // explore(20k) + entityBonus(huge) clamps to 60_000; observed 10k loses to policy raw at cap
      const r = computeLeaseTtlMs({ view: "explore", entityCount: 10_000, observedRoundTripMs: 10_000 });
      expect(r.ttlMs).toBe(60_000);
      expect(r.refreshRequired).toBe(false);
    });
  });

  describe("branch (b): observedRoundTripMs > cap → ttlMs = cap, refreshRequired === true", () => {
    it("saturates at cap and flags refresh when observedRoundTripMs exceeds cap", () => {
      const r = computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: 90_000 });
      expect(r.ttlMs).toBe(60_000);
      expect(r.refreshRequired).toBe(true);
    });

    it("refreshRequired === true holds for any observedRoundTripMs > cap", () => {
      for (const observed of [60_001, 70_000, 120_000, 300_000]) {
        const r = computeLeaseTtlMs({ view: "explore", entityCount: 20, observedRoundTripMs: observed });
        expect(r.ttlMs).toBe(60_000);
        expect(r.refreshRequired).toBe(true);
      }
    });

    it("boundary exactly at cap is treated as branch (a) (NOT refreshRequired)", () => {
      const r = computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: 60_000 });
      expect(r.ttlMs).toBe(60_000);
      expect(r.refreshRequired).toBe(false);
    });
  });

  describe("defensive: invalid observedRoundTripMs values are ignored", () => {
    it("undefined falls back to policy-only path", () => {
      const r = computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: undefined });
      expect(r.ttlMs).toBe(15_000);
      expect(r.refreshRequired).toBe(false);
    });

    it("NaN is treated as no observation (policy-only)", () => {
      const r = computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: NaN });
      expect(r.ttlMs).toBe(15_000);
      expect(r.refreshRequired).toBe(false);
    });

    it("zero or negative is treated as no observation (policy-only)", () => {
      expect(computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: 0 }).ttlMs).toBe(15_000);
      expect(computeLeaseTtlMs({ view: "action", entityCount: 5, observedRoundTripMs: -100 }).ttlMs).toBe(15_000);
    });
  });
});

describe("computeSoftExpiresAtMs", () => {
  it("returns issuedAt + 60% of TTL by default", () => {
    expect(computeSoftExpiresAtMs(1000, 10_000)).toBe(7_000); // 1000 + floor(6000)
    expect(computeSoftExpiresAtMs(0,    5_000)).toBe(3_000);  // 0    + floor(3000)
  });

  it("strictly less than (issuedAt + ttl) — soft < hard", () => {
    for (const ttl of [2_000, 5_000, 10_000, 30_000, 60_000]) {
      const issuedAt = 100_000;
      const soft = computeSoftExpiresAtMs(issuedAt, ttl);
      expect(soft).toBeLessThan(issuedAt + ttl);
    }
  });

  it("integer output (no fractional ms) so JSON round-trip is stable", () => {
    const soft = computeSoftExpiresAtMs(100, 7_777);
    expect(Number.isInteger(soft)).toBe(true);
  });
});
