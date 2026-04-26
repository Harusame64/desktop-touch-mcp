import { describe, it, expect } from "vitest";
import {
  computeLeaseTtlMs,
  computeSoftExpiresAtMs,
  LEASE_TTL_POLICY,
} from "../../src/engine/world-graph/lease-ttl-policy.js";

describe("computeLeaseTtlMs — view dimension", () => {
  it("action view has no bonus (base 5000ms)", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5 })).toBe(5_000);
  });

  it("undefined view defaults to action", () => {
    expect(computeLeaseTtlMs({ view: undefined, entityCount: 5 })).toBe(5_000);
  });

  it("explore view adds 5000ms bonus", () => {
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 5 })).toBe(10_000);
  });

  it("debug view adds 10000ms bonus", () => {
    expect(computeLeaseTtlMs({ view: "debug", entityCount: 5 })).toBe(15_000);
  });

  it("explore TTL is strictly greater than action TTL for same entityCount", () => {
    const a = computeLeaseTtlMs({ view: "action",  entityCount: 30 });
    const e = computeLeaseTtlMs({ view: "explore", entityCount: 30 });
    expect(e).toBeGreaterThan(a);
  });
});

describe("computeLeaseTtlMs — entity count dimension", () => {
  it("entityCount <= 20 yields no bonus", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 0  })).toBe(5_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 20 })).toBe(5_000);
  });

  it("each entity above 20 adds 100ms", () => {
    // action(base 5000) + (40 - 20) * 100 = 7000
    expect(computeLeaseTtlMs({ view: "action",  entityCount: 40 })).toBe(7_000);
    // explore(base 10000) + (50 - 20) * 100 = 13000
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 50 })).toBe(13_000);
  });

  it("bonus is monotonically non-decreasing in entityCount (same view)", () => {
    let prev = -1;
    for (let n = 0; n <= 100; n += 5) {
      const ttl = computeLeaseTtlMs({ view: "explore", entityCount: n });
      expect(ttl).toBeGreaterThanOrEqual(prev);
      prev = ttl;
    }
  });
});

describe("computeLeaseTtlMs — clamping", () => {
  it("clamps to cap (60000ms) even for extreme inputs", () => {
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 10_000 })).toBe(60_000);
    expect(computeLeaseTtlMs({ view: "debug",   entityCount: 10_000 })).toBe(60_000);
  });

  it("floor (2000ms) is respected (defensive lower bound)", () => {
    const minTtl = computeLeaseTtlMs({ view: "action", entityCount: 0 });
    expect(minTtl).toBeGreaterThanOrEqual(LEASE_TTL_POLICY.floor);
  });
});

describe("computeLeaseTtlMs — invariants", () => {
  it("never returns a non-finite or negative number", () => {
    for (const view of ["action", "explore", "debug", undefined] as const) {
      for (const n of [0, 1, 20, 50, 100, 500]) {
        const t = computeLeaseTtlMs({ view, entityCount: n });
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThan(0);
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
    // Baseline = 2000 bytes. Inputs at or below baseline behave like the
    // no-payload path.
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 0    })).toBe(5_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 2000 })).toBe(5_000);
  });

  it("each byte over baseline adds 0.5ms", () => {
    // 5_000 base + (10_000 - 2_000) * 0.5 = 5_000 + 4_000 = 9_000
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 10_000 })).toBe(9_000);
  });

  it("payload bonus is itself capped at 10000ms", () => {
    // Even an absurd 1 MB payload can only contribute 10s on top of the
    // other dimensions.
    const ttl = computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: 1_000_000 });
    // base(5000) + payloadCap(10000) = 15000
    expect(ttl).toBe(15_000);
  });

  it("payloadBytes undefined / NaN / negative is silently treated as zero (defensive)", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5 })).toBe(5_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: NaN  })).toBe(5_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5, payloadBytes: -100 })).toBe(5_000);
  });

  it("all bonuses stack and respect the cap", () => {
    // explore(+5000) + entityBonus((50-20)*100=3000) + payloadCap(10000)
    // base(5000) + 5000 + 3000 + 10000 = 23000  (well under cap 60000)
    const ttl = computeLeaseTtlMs({ view: "explore", entityCount: 50, payloadBytes: 100_000 });
    expect(ttl).toBe(23_000);
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
