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
import { evaluateScrollDelivery, type ScrollSnapshot } from "../../src/tools/mouse.js";

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
