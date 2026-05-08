/**
 * issue-196-terminal-run-quiet-detection.test.ts
 *
 * Pure-helper unit tests for issue #196 symptom 2 fix.
 *
 *   - `evaluateQuietState`: gates the quiet-completion timer behind the
 *     first observed text change. Pre-fix logic fired `completion.reason:
 *     "quiet"` after quietMs even when the buffer had not changed at all
 *     since send (echo not yet rendered to UIA TextPattern). The new helper
 *     keeps state in "still" until firstChangeAt is set.
 *
 *   - `evaluateRunReadIntegrity`: 3-condition AND gate that decides whether
 *     the run handler's final read should suppress its `output` because the
 *     baseline marker could not be located in the post-run buffer.
 *     Suppression prevents scrollback from previous sessions leaking into
 *     `output`. False positives are guarded by requiring sinceMarker to be
 *     defined and `invalidatedBy` to be undefined.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateQuietState,
  evaluateRunReadIntegrity,
} from "../../src/tools/terminal.js";

describe("issue #196 (a): evaluateQuietState gates quiet timer behind first change", () => {
  it("returns 'still' when firstChangeAt is null, even if quietMs has elapsed since lastTextChangedAt", () => {
    // The buffer never changed; pre-fix logic would have fired quiet here.
    const state = evaluateQuietState({
      now: 5_000,
      lastTextChangedAt: 0,
      firstChangeAt: null,
      quietMs: 800,
    });
    expect(state).toBe("still");
  });

  it("returns 'active' when firstChangeAt is set but quietMs has not elapsed", () => {
    const state = evaluateQuietState({
      now: 1_500,
      lastTextChangedAt: 1_000,
      firstChangeAt: 1_000,
      quietMs: 1_500,
    });
    // 500ms since last change, quietMs=1500 — still active.
    expect(state).toBe("active");
  });

  it("returns 'quiet' when firstChangeAt is set AND quietMs has elapsed since last change", () => {
    const state = evaluateQuietState({
      now: 2_500,
      lastTextChangedAt: 1_000,
      firstChangeAt: 1_000,
      quietMs: 1_500,
    });
    // 1500ms since last change → quiet.
    expect(state).toBe("quiet");
  });

  it("does NOT regress to 'still' once firstChangeAt is set, even if `now` and `lastTextChangedAt` get equal", () => {
    // Edge case: a single change just landed at `now`. firstChangeAt is also
    // `now`. Time-since-change is 0 → not yet quiet, but we are out of "still".
    const state = evaluateQuietState({
      now: 100,
      lastTextChangedAt: 100,
      firstChangeAt: 100,
      quietMs: 1_500,
    });
    expect(state).toBe("active");
  });

  it("respects the quietMs boundary (>=, not strictly >)", () => {
    const exact = evaluateQuietState({
      now: 1_500,
      lastTextChangedAt: 0,
      firstChangeAt: 0,
      quietMs: 1_500,
    });
    expect(exact).toBe("quiet");
  });
});

describe("issue #196 (c): evaluateRunReadIntegrity 3-condition AND gate for stale-output suppression", () => {
  it("returns 'ok' when sinceMarker is undefined (baselineRead failed — gate not applicable)", () => {
    const integrity = evaluateRunReadIntegrity({
      sinceMarker: undefined,
      hints: { terminalMarker: { previousMatched: false } },
    });
    // First gate: without a marker request, previousMatched:false is the
    // read handler's default and means nothing.
    expect(integrity).toBe("ok");
  });

  it("returns 'ok' when hints object is missing", () => {
    const integrity = evaluateRunReadIntegrity({
      sinceMarker: "deadbeef",
      // hints absent — no signal to act on.
    });
    expect(integrity).toBe("ok");
  });

  it("returns 'ok' when invalidatedBy is set (separate failure mode, not marker drift)", () => {
    // process_restarted means hwnd was reused / process recycled — that's
    // surfaced via its own path, conflating it with marker drift would
    // hide the real cause.
    const integrity = evaluateRunReadIntegrity({
      sinceMarker: "deadbeef",
      hints: {
        terminalMarker: {
          previousMatched: false,
          invalidatedBy: "process_restarted",
        },
      },
    });
    expect(integrity).toBe("ok");
  });

  it("returns 'baseline_lost' when all 3 conditions fire (marker request, marker not matched, no invalidation)", () => {
    const integrity = evaluateRunReadIntegrity({
      sinceMarker: "deadbeef",
      hints: { terminalMarker: { previousMatched: false } },
    });
    expect(integrity).toBe("baseline_lost");
  });

  it("returns 'ok' when previousMatched is true (marker located normally)", () => {
    const integrity = evaluateRunReadIntegrity({
      sinceMarker: "deadbeef",
      hints: { terminalMarker: { previousMatched: true } },
    });
    expect(integrity).toBe("ok");
  });

  it("returns 'ok' when previousMatched is undefined (read handler did not report)", () => {
    // Defensive: a future read-handler shape that omits previousMatched
    // should not silently fire baseline_lost on the absence of evidence.
    const integrity = evaluateRunReadIntegrity({
      sinceMarker: "deadbeef",
      hints: { terminalMarker: {} },
    });
    expect(integrity).toBe("ok");
  });
});
