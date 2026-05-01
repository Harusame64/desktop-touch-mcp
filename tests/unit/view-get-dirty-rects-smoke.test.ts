/**
 * tests/unit/view-get-dirty-rects-smoke.test.ts
 *
 * **G2 contract Test G2-4** (Opus PR #108 Round 1 P1-2 + sub-plan
 * `docs/adr-008-d2-c-plan.md` §3.8 D2-C-7 + User feedback 2026-05-01):
 *
 * Node-side smoke test for the `viewGetDirtyRects` napi binding (S2
 * D2-C). Calls the export once and verifies it does NOT throw +
 * returns an object with the expected shape (`monitorIndex` field
 * echoed back for round-trip integrity per CLAUDE.md §3.2 PR #102
 * 教訓).
 *
 * **What this catches that compile-time `check:native-types` does
 * not** (User feedback rationale, sub-plan §0):
 *   - native binding registration drop (rust→addon symbol miswire)
 *   - JS export missing from `index.js`
 *   - runtime symbol mismatch (renamed Rust fn vs index.d.ts decl)
 *   - pipeline init crash (panicking `ensure_perception_pipeline`)
 *
 * **What this does NOT cover** (carry-over to expansion):
 *   - DXGI live frame rect counts (no real DXGI driver in CI)
 *   - vitest live integration (Notepad/Edge fixture-based) — sub-plan §1.3
 */

import { describe, it, expect } from "vitest";

describe("viewGetDirtyRects (G2-4 smoke)", () => {
  it("returns a NativeDirtyRectsResult shape with monitor_index echoed", async () => {
    // Dynamic import: the addon is loaded lazily so a missing /
    // unbuilt `index.node` surfaces as a clear failure here rather
    // than at module-load time of the entire test suite.
    const addon = await import("../../index.js");

    // The function must exist on the export (compile-time
    // `check:native-types` ensures the declaration; this checks the
    // actual runtime symbol).
    expect(typeof addon.viewGetDirtyRects).toBe("function");

    // First-call lazy init of the perception pipeline. With no DXGI
    // events emitted, the result is an empty (but well-formed) shape:
    //   { monitorIndex: 0, liveFrameCount: 0, latest: null }
    // The key contract is that the call doesn't throw and the
    // returned object has the shape the TS layer expects (CLAUDE.md
    // §3.2 PR #102 教訓: monitor_index round-trip integrity).
    const result = addon.viewGetDirtyRects(0);

    expect(result).toBeDefined();
    expect(result.monitorIndex).toBe(0);
    expect(typeof result.liveFrameCount).toBe("number");
    // `latest` is `NativeDirtyRectFrame | null | undefined` — napi-rs
    // serialises `Option::None` as `undefined` (not null) in JS
    // contexts, so accept both. Smoke-with-no-events case: undefined
    // / null. With DXGI events flowing: object with frameIndex +
    // count (vitest live integration scope, sub-plan §1.3 carry-over).
    expect(
      result.latest === null ||
        result.latest === undefined ||
        (typeof result.latest === "object" &&
          typeof result.latest.frameIndex === "bigint" &&
          typeof result.latest.count === "bigint"),
    ).toBe(true);
  });

  it("returns the requested monitor_index back even for non-zero indices", async () => {
    // Per-monitor query smoke (CLAUDE.md §3.2 PR #102 教訓 follow-up):
    // the binding must NOT hard-code monitor_index=0 in the response.
    // Even with no rects emitted for monitor=1, the result must echo
    // the queried index.
    const addon = await import("../../index.js");
    const result = addon.viewGetDirtyRects(1);
    expect(result.monitorIndex).toBe(1);
  });
});
