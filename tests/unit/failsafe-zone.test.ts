/**
 * tests/unit/failsafe-zone.test.ts
 *
 * ADR-030 Phase 1 (AC1 / plan §4.1) — pure zone predicates. The pre-fix
 * predicate `x <= 10 && y <= 10` had no lower bound, so on multi-monitor
 * setups with a monitor left of / above the primary (negative virtual-screen
 * coordinates) the failsafe zone silently expanded into a full band or the
 * whole monitor. These tests pin the fixed predicate by coordinate injection
 * alone — no second monitor needed, so the regression is detectable forever
 * on single-monitor CI.
 */

import { describe, it, expect, vi } from "vitest";

// `failsafe.ts` imports the nut-js mouse at module scope; mock it so this
// pure-predicate test never loads the native input module.
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: { getPosition: vi.fn() },
}));
vi.mock("../../src/utils/balloon.js", () => ({
  showBalloonTip: vi.fn(async () => {}),
}));
vi.mock("../../src/engine/diagnostic-log.js", () => ({
  logDiagnostic: vi.fn(),
}));

import { isInFailsafeZone, isInLegacyGhostZone } from "../../src/utils/failsafe.js";

describe("isInFailsafeZone — primary monitor top-left corner only", () => {
  it.each([
    [0, 0],
    [10, 10],
    [5, 5],
  ])("(%i, %i) is in-zone", (x, y) => {
    expect(isInFailsafeZone(x, y)).toBe(true);
  });

  it.each([
    [11, 5], // past the radius on x
    [5, 11], // past the radius on y
    [-1, 0], // just past the new lower bound on x
    [0, -1], // just past the new lower bound on y
    [-1000, 5], // monitor LEFT of the primary (ADR-030 §3 row 1)
    [5, -500], // monitor ABOVE the primary (row 2)
    [-1000, -500], // monitor UPPER-LEFT of the primary (row 3)
  ])("(%i, %i) is out-of-zone", (x, y) => {
    expect(isInFailsafeZone(x, y)).toBe(false);
  });
});

describe("isInLegacyGhostZone — the band the pre-fix predicate treated as in-zone", () => {
  it.each([
    [-1, 5],
    [-1000, 5],
    [5, -500],
    [-1000, -500],
  ])("(%i, %i) is in the ghost zone", (x, y) => {
    expect(isInLegacyGhostZone(x, y)).toBe(true);
  });

  it.each([
    [5, 5], // the REAL zone is not the ghost zone
    [50, 50], // fully outside both predicates
    [-5, 11], // y out of range even under the pre-fix predicate
  ])("(%i, %i) is NOT in the ghost zone", (x, y) => {
    expect(isInLegacyGhostZone(x, y)).toBe(false);
  });
});
