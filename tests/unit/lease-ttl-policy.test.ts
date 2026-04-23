import { describe, it, expect } from "vitest";
import { computeLeaseTtlMs, LEASE_TTL_POLICY } from "../../src/engine/world-graph/lease-ttl-policy.js";

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
  it("clamps to cap (30000ms) even for extreme inputs", () => {
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 10_000 })).toBe(30_000);
    expect(computeLeaseTtlMs({ view: "debug",   entityCount: 10_000 })).toBe(30_000);
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
