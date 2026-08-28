/**
 * scroll-pixel-delta.test.ts — unit tests for `scrollPixelsChanged`
 * (ADR-018 Phase 6 §2.3).
 *
 * Context: on a destination with no Win32 scrollbar on either axis (WebView2 /
 * Tauri / Electron / custom-paint hosts) `scroll(action='raw')` used to return
 * a constant `unverifiable`, so a 0-px scroll and a correct scroll were
 * indistinguishable in the response. That is how a WebView2 wheel mis-routing
 * survived an entire dogfood session on 2026-08-28. The raw-byte comparison
 * pinned here is the last-resort observation for that case.
 *
 * The rule it must encode:
 *   - either capture missing   → false (no evidence ⇒ caller stays unverifiable)
 *   - byte-identical           → false (page-end no-op and silent drop both land here)
 *   - any byte differs         → true
 *   - shape or length differs  → false (the two captures are not comparable, so
 *                                there is no evidence either way — the capture
 *                                stack re-picks PrintWindow / WGC / BitBlt per
 *                                call and the stages report different geometry)
 */

import { describe, it, expect } from "vitest";
import { scrollPixelsChanged } from "../../src/tools/mouse.js";

const frame = (...bytes: number[]): Buffer => Buffer.from(bytes);
/** Same shape for both sides unless a test is specifically about shape. */
const shape = (width: number, height: number, channels: 3 | 4 = 4) => ({
  width,
  height,
  channels,
});
const S = shape(2, 2);
const changed = (
  pre: Buffer | null,
  post: Buffer | null,
  preShape: ReturnType<typeof shape> | null = S,
  postShape: ReturnType<typeof shape> | null = S,
): boolean => scrollPixelsChanged(pre, post, preShape, postShape);

describe("scrollPixelsChanged — evidence present", () => {
  it("byte-identical frames → false (cannot claim motion)", () => {
    expect(changed(frame(1, 2, 3, 4), frame(1, 2, 3, 4))).toBe(false);
  });

  it("a single differing byte → true", () => {
    expect(changed(frame(1, 2, 3, 4), frame(1, 2, 3, 5))).toBe(true);
  });

  it("first byte differing → true (no prefix-only comparison)", () => {
    expect(changed(frame(9, 2, 3, 4), frame(1, 2, 3, 4))).toBe(true);
  });

  it("length change → false (not comparable, so no evidence of motion)", () => {
    expect(changed(frame(1, 2, 3, 4), frame(1, 2, 3))).toBe(false);
    expect(changed(frame(1, 2, 3), frame(1, 2, 3, 4))).toBe(false);
  });

  it("two empty frames → false (degenerate capture is not motion)", () => {
    expect(changed(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe("scrollPixelsChanged — evidence missing", () => {
  it("pre capture missing → false", () => {
    expect(changed(null, frame(1, 2, 3, 4))).toBe(false);
  });

  it("post capture missing → false", () => {
    expect(changed(frame(1, 2, 3, 4), null)).toBe(false);
  });

  it("both missing → false", () => {
    expect(changed(null, null)).toBe(false);
  });
});

describe("scrollPixelsChanged — realistic frame sizes", () => {
  it("a one-pixel difference deep inside a large frame is still detected", () => {
    // 1280x840 RGB — the shape of a real WebView capture. A perceptual hash
    // can quantise this difference away; exact bytes cannot.
    const size = 1280 * 840 * 3;
    const pre = Buffer.alloc(size, 0x20);
    const post = Buffer.alloc(size, 0x20);
    post[size - 1] = 0x21;
    expect(changed(pre, post)).toBe(true);
  });

  it("an untouched large frame reports no motion", () => {
    const size = 1280 * 840 * 3;
    expect(
      changed(Buffer.alloc(size, 0x20), Buffer.alloc(size, 0x20)),
    ).toBe(false);
  });
});

describe("scrollPixelsChanged — capture shape changed between the two frames", () => {
  // The capture stack re-picks PrintWindow → WGC → BitBlt per call and the
  // stages report different geometry, so two frames of a window that never
  // moved can differ in shape. Reading that as motion would claim `delivered`
  // for a wheel that never arrived.
  it("different width → false", () => {
    expect(changed(frame(1, 2, 3, 4), frame(9, 9, 9, 9), shape(2, 2), shape(4, 1))).toBe(false);
  });

  it("different channel count → false, even with identical byte length", () => {
    expect(
      changed(frame(1, 2, 3, 4), frame(1, 2, 3, 9), shape(1, 1, 4), shape(2, 2, 3)),
    ).toBe(false);
  });

  it("missing shape on either side → false", () => {
    expect(changed(frame(1, 2, 3, 4), frame(1, 2, 3, 9), null, S)).toBe(false);
    expect(changed(frame(1, 2, 3, 4), frame(1, 2, 3, 9), S, null)).toBe(false);
  });

  it("same shape still detects a real change", () => {
    expect(changed(frame(1, 2, 3, 4), frame(1, 2, 3, 9), S, S)).toBe(true);
  });
});
