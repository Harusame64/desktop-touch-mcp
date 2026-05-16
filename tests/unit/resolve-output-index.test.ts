/**
 * ADR-019 Stage 5 — `resolveOutputIndexForHwnd` unit tests.
 *
 * Sub-plan: `docs/adr-019-stage-5-plan.md` §3 SSOT row `resolve-output-index.test.ts`
 * (5 cases: primary / secondary / boundary-straddle / off-screen / MAX cap).
 *
 * The resolver is pure (consumes an injected `enumerate` provider) so no
 * native binding is touched. The Stage 5 module re-uses the same monitor
 * order returned by `enumMonitors()` from `src/engine/win32.ts` — production
 * wires that automatically; the tests inject mocks.
 */

import { describe, it, expect } from "vitest";

import { resolveOutputIndexForHwnd, STAGE5_CONSTANTS } from "../../src/engine/any-change.js";

const PRIMARY_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };
const SECONDARY_BOUNDS = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("resolveOutputIndexForHwnd", () => {
  it("single-monitor primary window resolves to output 0", () => {
    const result = resolveOutputIndexForHwnd(
      1n,
      { x: 100, y: 100, width: 800, height: 600 },
      { enumerate: () => [{ bounds: PRIMARY_BOUNDS }] },
    );
    expect(result).toEqual({ ok: true, outputIndex: 0, crossMonitor: false });
  });

  it("dual-monitor secondary window resolves to output 1", () => {
    const result = resolveOutputIndexForHwnd(
      2n,
      // Window center at (3200, 720) — inside SECONDARY_BOUNDS.
      { x: 2800, y: 600, width: 800, height: 240 },
      {
        enumerate: () => [
          { bounds: PRIMARY_BOUNDS },
          { bounds: SECONDARY_BOUNDS },
        ],
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outputIndex).toBe(1);
      expect(result.crossMonitor).toBe(false);
    }
  });

  it("dual-monitor straddling window: center on primary, crossMonitor true", () => {
    // 800px wide, centred at x=1820 (inside primary) but extending into
    // secondary (1920..2220).
    const result = resolveOutputIndexForHwnd(
      3n,
      { x: 1420, y: 100, width: 800, height: 600 },
      {
        enumerate: () => [
          { bounds: PRIMARY_BOUNDS },
          { bounds: SECONDARY_BOUNDS },
        ],
      },
    );
    expect(result).toEqual({ ok: true, outputIndex: 0, crossMonitor: true });
  });

  it("off-screen window (minimised / virtualised) reports off_screen", () => {
    // Window centred at -3200 — outside every monitor.
    const result = resolveOutputIndexForHwnd(
      4n,
      { x: -3600, y: -1200, width: 800, height: 600 },
      { enumerate: () => [{ bounds: PRIMARY_BOUNDS }] },
    );
    expect(result).toEqual({ ok: false, reason: "off_screen" });
  });

  it("no monitors enumerated → no_monitors", () => {
    const result = resolveOutputIndexForHwnd(
      5n,
      { x: 0, y: 0, width: 800, height: 600 },
      { enumerate: () => [] },
    );
    expect(result).toEqual({ ok: false, reason: "no_monitors" });
  });

  it("output index above STAGE5_MAX_OUTPUT_INDEX → out_of_range", () => {
    // Build STAGE5_MAX_OUTPUT_INDEX + 2 monitors arranged horizontally; the
    // window's center falls in the last one (index = MAX + 1, above cap).
    const monitorCount = STAGE5_CONSTANTS.STAGE5_MAX_OUTPUT_INDEX + 2;
    const monitors = Array.from({ length: monitorCount }, (_, i) => ({
      bounds: { x: i * 1000, y: 0, width: 1000, height: 1000 },
    }));
    const lastBounds = monitors[monitorCount - 1].bounds;
    const result = resolveOutputIndexForHwnd(
      6n,
      {
        x: lastBounds.x + 100,
        y: 100,
        width: 200,
        height: 200,
      },
      { enumerate: () => monitors },
    );
    expect(result).toEqual({ ok: false, reason: "out_of_range" });
  });
});
