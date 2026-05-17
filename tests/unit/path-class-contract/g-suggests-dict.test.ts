/**
 * tests/unit/path-class-contract/g-suggests-dict.test.ts
 * ADR-020 Phase 2 PR-P2-3 — G 軸 contract test (table + generated variants).
 *
 * Contract (ADR-020 §4.2 G 行):
 *   ∀ failure_code ∈ desc.if_unexpected. ∃ envelope.
 *     envelope(failure_with_code).suggests ⊇ desc.suggests[failure_code]
 *
 * Pins the SUGGESTS dictionary as the SSOT for failure_code → recovery-hint
 * mapping (PR #174 SSOT pattern, PR #329 added the ExecutorFailed entry for
 * #327 item G). The contract guarantees that every documented typed error
 * code has a non-empty suggest list — a missing entry means buildFailureEnvelope
 * would emit `suggest: []` to the LLM, defeating the if_unexpected advisory.
 *
 * Uses the existing `getSuggestsForCode()` accessor (read-only access to the
 * private SUGGESTS dict, src/tools/_errors.ts:463) — no new helper extraction.
 *
 * Revert detection:
 *   - Revert PR #329 (SUGGESTS.ExecutorFailed entry + desktopActRawHandler
 *     local attach) → getSuggestsForCode("ExecutorFailed") returns [] and
 *     the ExecutorFailed test case fails.
 *
 * @see docs/adr-020-phase-2-p2-3-contract-test-plan.md §1.1 C (G 軸)
 * @see src/tools/_errors.ts:20 (SUGGESTS dict) + :463 (getSuggestsForCode)
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { getSuggestsForCode } from "../../../src/tools/_errors.js";

// Table: typed error codes that MUST have non-empty suggest lists.
// Each entry corresponds to a documented if_unexpected / failure path the
// LLM should be guided through. Adding a code here without a SUGGESTS entry
// would surface as a failing case.
const REQUIRED_CODES: readonly string[] = [
  "InvalidArgs",
  "WindowNotFound",
  "ElementNotFound",
  "InvokePatternNotSupported",
  "BlockedKeyCombo",
  "UiaTimeout",
  "ElementDisabled",
  "BrowserNotConnected",
  "TerminalWindowNotFound",
  "TerminalTextPatternUnavailable",
  "BrowserSearchNoResults",
  "BrowserSearchTimeout",
  // #327 item G — PR #329 ExecutorFailed entry (representative 3 件 candidate)
  "ExecutorFailed",
] as const;

describe("G contract — SUGGESTS dict ⊇ documented failure codes", () => {
  it.each(REQUIRED_CODES)("typed error code %s has non-empty suggest list", (code) => {
    const suggests = getSuggestsForCode(code);
    expect(suggests).toBeInstanceOf(Array);
    expect(suggests.length).toBeGreaterThan(0);
    // every entry is a non-empty string
    for (const s of suggests) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it("ExecutorFailed entry is present (PR #329, #327 item G fix)", () => {
    // Direct pin for the representative 3 件 C revert/diff demo (alongside D + F).
    const suggests = getSuggestsForCode("ExecutorFailed");
    expect(suggests.length).toBeGreaterThan(0);
    // The entry text mentions the recovery path the LLM should take.
    const joined = suggests.join(" | ");
    expect(joined.length).toBeGreaterThan(20);   // non-trivial text, not just a stub
  });

  it("unknown / undocumented codes return empty array (defensive)", () => {
    expect(getSuggestsForCode("ThisCodeDoesNotExist")).toEqual([]);
    expect(getSuggestsForCode("")).toEqual([]);
  });

  it("getSuggestsForCode is referentially transparent (property-based, no global state mutation)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...REQUIRED_CODES), (code) => {
        const first = getSuggestsForCode(code);
        const second = getSuggestsForCode(code);
        expect(first).toEqual(second);
        expect(first.length).toBeGreaterThan(0);
      }),
      { numRuns: 50 },
    );
  });
});
