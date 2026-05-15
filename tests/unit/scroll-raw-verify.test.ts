/**
 * scroll-raw-verify.test.ts — unit tests for evaluateScrollDelivery
 * (issue #179, matrix doc §3.1).
 *
 * Pins the page-end disambiguation rule:
 *   - pre at boundary AND post equal     → delivered (page-end success)
 *   - pre off-boundary AND post equal    → not_delivered (silent drop)
 *   - pre and post differ                → delivered
 *   - no Win32 axis + image hash diff    → delivered (fallback)
 *   - no Win32 axis + image hash equal   → unverifiable (cannot disambiguate)
 *   - no observation channel             → unverifiable (no_target_window / scrollbar_unavailable)
 */

import { describe, it, expect } from "vitest";
import {
  collapseScrollObserved,
  evaluateScrollDelivery,
  type ScrollSnapshot,
} from "../../src/tools/mouse.js";

const snap = (
  v: number | null,
  h: number | null,
  d: bigint | null = null,
): ScrollSnapshot => ({ vertical: v, horizontal: h, dHash: d });

describe("evaluateScrollDelivery — Win32 axis present", () => {
  it("vertical movement → delivered", () => {
    const r = evaluateScrollDelivery(snap(0.10, 0.0), snap(0.25, 0.0), "down");
    expect(r.status).toBe("delivered");
    expect(r.delta).not.toBe("unverifiable");
    if (r.delta !== "unverifiable") {
      expect(r.delta.y).toBeGreaterThan(0);
    }
  });

  it("horizontal movement → delivered", () => {
    const r = evaluateScrollDelivery(snap(0.0, 0.30), snap(0.0, 0.10), "left");
    expect(r.status).toBe("delivered");
    if (r.delta !== "unverifiable") {
      expect(r.delta.x).toBeLessThan(0);
    }
  });

  it("page-end: scroll up at vertical=0% → delivered (no fail)", () => {
    const r = evaluateScrollDelivery(snap(0.0, 0.0), snap(0.0, 0.0), "up");
    expect(r.status).toBe("delivered");
  });

  it("page-end: scroll down at vertical=100% → delivered (no fail)", () => {
    const r = evaluateScrollDelivery(snap(1.0, 0.0), snap(1.0, 0.0), "down");
    expect(r.status).toBe("delivered");
  });

  it("page-end: scroll left at horizontal=0% → delivered", () => {
    const r = evaluateScrollDelivery(snap(0.5, 0.0), snap(0.5, 0.0), "left");
    expect(r.status).toBe("delivered");
  });

  it("page-end: scroll right at horizontal=100% → delivered", () => {
    const r = evaluateScrollDelivery(snap(0.5, 1.0), snap(0.5, 1.0), "right");
    expect(r.status).toBe("delivered");
  });

  it("silent drop: pre off-boundary, post equal, scroll down → not_delivered", () => {
    const r = evaluateScrollDelivery(snap(0.5, 0.0), snap(0.5, 0.0), "down");
    expect(r.status).toBe("not_delivered");
    expect(r.axis).toBe("vertical");
  });

  it("silent drop: pre off-boundary, post equal, scroll up → not_delivered", () => {
    const r = evaluateScrollDelivery(snap(0.5, 0.0), snap(0.5, 0.0), "up");
    expect(r.status).toBe("not_delivered");
    expect(r.axis).toBe("vertical");
  });

  it("silent drop: pre off-boundary horizontal, post equal → not_delivered", () => {
    const r = evaluateScrollDelivery(snap(0.0, 0.5), snap(0.0, 0.5), "right");
    expect(r.status).toBe("not_delivered");
    expect(r.axis).toBe("horizontal");
  });

  it("scrolling DOWN at 0% (off boundary for that direction) and post equal → not_delivered", () => {
    // Scrolling DOWN should move OFF 0% (toward 100%); 0% is the page-start
    // boundary, NOT the page-end for direction="down". So pre=0%, post=0%
    // with direction=down is a silent drop unless content is exactly one screen.
    // Per matrix doc §3.1, our rule is: "atDirectionalBoundary" requires pre at
    // the END boundary of the scroll direction. 0% is NOT the end boundary for
    // "down", so this must surface as not_delivered.
    const r = evaluateScrollDelivery(snap(0.0, 0.0), snap(0.0, 0.0), "down");
    expect(r.status).toBe("not_delivered");
  });

  it("scrolling UP at 100% (off boundary for direction=up) and post equal → not_delivered", () => {
    const r = evaluateScrollDelivery(snap(1.0, 0.0), snap(1.0, 0.0), "up");
    expect(r.status).toBe("not_delivered");
  });

  it("epsilon-level noise (rounding) → not_delivered when below epsilon", () => {
    // SCROLL_PERCENT_EPSILON in mouse.ts is 1e-6 (intentionally low so single-step
    // scrolls in ~1M-position ranges register as movement — see Codex P1 fix in
    // PR #191). Any jitter below 1e-6 must be eaten by the epsilon. Use 1e-7
    // here so the test stays valid for the current threshold.
    const r = evaluateScrollDelivery(snap(0.5, 0.0), snap(0.5 + 1e-7, 0.0), "down");
    expect(r.status).toBe("not_delivered");
  });
});

describe("evaluateScrollDelivery — image hash fallback", () => {
  it("hash diff exceeds threshold → delivered", () => {
    // A bigint with all 64 bits flipped relative to 0n → Hamming distance 64.
    const pre = snap(null, null, 0n);
    const post = snap(null, null, 0xFFFFFFFFFFFFFFFFn);
    const r = evaluateScrollDelivery(pre, post, "down");
    expect(r.status).toBe("delivered");
  });

  it("hash equal → unverifiable with reason='page_end_inferred'", () => {
    const pre = snap(null, null, 0xDEADBEEFn);
    const post = snap(null, null, 0xDEADBEEFn);
    const r = evaluateScrollDelivery(pre, post, "down");
    expect(r.status).toBe("unverifiable");
    expect(r.reason).toBe("page_end_inferred");
    expect(r.axis).toBe("vertical");
  });

  it("no Win32 axis + no hash → unverifiable with reason='scrollbar_unavailable'", () => {
    const pre = snap(null, null, null);
    const post = snap(null, null, null);
    const r = evaluateScrollDelivery(pre, post, "down");
    expect(r.status).toBe("unverifiable");
    expect(r.reason).toBe("scrollbar_unavailable");
  });
});

// ADR-018 Phase 1a contract lock: pin that the new 5-value reason enum is
// type-assignable to ScrollVerifyOutcome.reason. This is the trunk-stage
// guarantee that Phase 1b / 3 / 4 can emit these values without further
// type changes. The 4 legacy reasons (read_back_unsupported /
// page_end_inferred / scrollbar_unavailable / no_target_window) are still
// emittable by the current dispatcher; Phase 1b will remove them once the
// 3-tier pipeline lands.
describe("evaluateScrollDelivery — ADR-018 §2.6.2 5-value reason enum (type-level lock)", () => {
  it("ScrollVerifyOutcome.reason accepts all 5 ADR-018 reason values", () => {
    // The cast-and-assign pattern below fails to compile if any member is
    // missing from the union, which is the trunk contract.
    const reasons = [
      "delivered_via_uia",
      "delivered_via_cdp",
      "delivered_via_postmessage",
      "wheel_overlay_intercepted",
      "target_unreachable",
    ] as const;
    type ReasonField = NonNullable<
      import("../../src/tools/mouse.js").ScrollVerifyOutcome["reason"]
    >;
    // Per-member type assignment forces TS to verify each literal is in the union.
    const _u1: ReasonField = "delivered_via_uia";
    const _u2: ReasonField = "delivered_via_cdp";
    const _u3: ReasonField = "delivered_via_postmessage";
    const _u4: ReasonField = "wheel_overlay_intercepted";
    const _u5: ReasonField = "target_unreachable";
    expect(reasons).toHaveLength(5);
    expect([_u1, _u2, _u3, _u4, _u5].sort()).toEqual([...reasons].sort());
  });

  it("ScrollVerifyOutcome.reason still accepts all 4 legacy reason values (Phase 1b will remove)", () => {
    type ReasonField = NonNullable<
      import("../../src/tools/mouse.js").ScrollVerifyOutcome["reason"]
    >;
    const _l1: ReasonField = "read_back_unsupported";
    const _l2: ReasonField = "page_end_inferred";
    const _l3: ReasonField = "scrollbar_unavailable";
    const _l4: ReasonField = "no_target_window";
    expect([_l1, _l2, _l3, _l4]).toHaveLength(4);
  });
});

describe("evaluateScrollDelivery — delta shape", () => {
  it("delta exposes both axes when both Win32 axes are present", () => {
    const r = evaluateScrollDelivery(snap(0.10, 0.20), snap(0.25, 0.30), "down");
    expect(r.delta).not.toBe("unverifiable");
    if (r.delta !== "unverifiable") {
      expect(r.delta.y).toBeCloseTo(0.15, 5);
      expect(r.delta.x).toBeCloseTo(0.10, 5);
    }
  });

  it("delta.x is null when horizontal axis is absent (vertical-only window)", () => {
    const r = evaluateScrollDelivery(snap(0.10, null), snap(0.25, null), "down");
    if (r.delta !== "unverifiable") {
      expect(r.delta.x).toBeNull();
      expect(r.delta.y).toBeCloseTo(0.15, 5);
    }
    expect(r.status).toBe("delivered");
  });
});

// ADR-018 Phase 3 — issue #294 envelope normalisation. `evaluateScrollDelivery`
// keeps its internal `{x:null,y:null}` shape (Win32 percent observations) so
// that the existing internal contract above is preserved; the public envelope
// served at `hints.scrollObserved.delta` is normalised one level above by
// `collapseScrollObserved` so callers see ONE shape for "observation channel
// exhausted" — not the ambiguous `{x:null, y:null}` object reported in #294.
describe("collapseScrollObserved — ADR-018 Phase 3 / issue #294 envelope normalisation", () => {
  it("'unverifiable' string passes through unchanged", () => {
    const r = collapseScrollObserved({ delta: "unverifiable" });
    expect(r.delta).toBe("unverifiable");
  });

  it("both axes null collapses to 'unverifiable' (issue #294 — silent-drop ambiguity)", () => {
    // The exact silent-drop shape reported in #294: Avalonia /
    // DirectComposition / custom scrollbars cause GetScrollInfo to fail on
    // BOTH axes, so the internal evaluateScrollDelivery emits
    // {x:null, y:null}. The envelope collapse normalises to the dedicated
    // 'unverifiable' string so the LLM sees one shape, not two, for
    // "observation channel exhausted".
    const r = collapseScrollObserved({ delta: { x: null, y: null } });
    expect(r.delta).toBe("unverifiable");
  });

  it("vertical-only window (horizontal axis null) preserves the structured object", () => {
    // Single-axis null carries real signal — that axis genuinely has no
    // scrollbar. Issue #294's silent-drop ambiguity does NOT apply here, so
    // the object is preserved (callers can detect "this axis has no observation
    // channel" without losing the working axis's numeric value).
    const r = collapseScrollObserved({ delta: { x: null, y: 0.15 } });
    expect(r.delta).toEqual({ x: null, y: 0.15 });
  });

  it("horizontal-only window (vertical axis null) preserves the structured object", () => {
    const r = collapseScrollObserved({ delta: { x: 0.10, y: null } });
    expect(r.delta).toEqual({ x: 0.10, y: null });
  });

  it("both axes numeric pass through unchanged", () => {
    const r = collapseScrollObserved({ delta: { x: 0.10, y: 0.20 } });
    expect(r.delta).toEqual({ x: 0.10, y: 0.20 });
  });

  it("both axes zero (rounding noise / no movement) pass through unchanged — NOT collapsed", () => {
    // Zero is an observable value (Win32 reported, scrollbar present, no
    // movement); collapse is reserved for null-null. The `not_delivered`
    // status comes from `evaluateScrollDelivery`'s page-end disambiguation,
    // not from the envelope shape.
    const r = collapseScrollObserved({ delta: { x: 0, y: 0 } });
    expect(r.delta).toEqual({ x: 0, y: 0 });
  });
});
