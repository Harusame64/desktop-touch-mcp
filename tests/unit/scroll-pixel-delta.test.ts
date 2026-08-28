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
 *   - length differs           → true (window resized ⇒ observable motion)
 */

import { describe, it, expect } from "vitest";
import { scrollPixelsChanged } from "../../src/tools/mouse.js";

const frame = (...bytes: number[]): Buffer => Buffer.from(bytes);

describe("scrollPixelsChanged — evidence present", () => {
  it("byte-identical frames → false (cannot claim motion)", () => {
    expect(scrollPixelsChanged(frame(1, 2, 3, 4), frame(1, 2, 3, 4))).toBe(false);
  });

  it("a single differing byte → true", () => {
    expect(scrollPixelsChanged(frame(1, 2, 3, 4), frame(1, 2, 3, 5))).toBe(true);
  });

  it("first byte differing → true (no prefix-only comparison)", () => {
    expect(scrollPixelsChanged(frame(9, 2, 3, 4), frame(1, 2, 3, 4))).toBe(true);
  });

  it("length change (window resized mid-dispatch) → true", () => {
    expect(scrollPixelsChanged(frame(1, 2, 3, 4), frame(1, 2, 3))).toBe(true);
    expect(scrollPixelsChanged(frame(1, 2, 3), frame(1, 2, 3, 4))).toBe(true);
  });

  it("two empty frames → false (degenerate capture is not motion)", () => {
    expect(scrollPixelsChanged(Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe("scrollPixelsChanged — evidence missing", () => {
  it("pre capture missing → false", () => {
    expect(scrollPixelsChanged(null, frame(1, 2, 3, 4))).toBe(false);
  });

  it("post capture missing → false", () => {
    expect(scrollPixelsChanged(frame(1, 2, 3, 4), null)).toBe(false);
  });

  it("both missing → false", () => {
    expect(scrollPixelsChanged(null, null)).toBe(false);
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
    expect(scrollPixelsChanged(pre, post)).toBe(true);
  });

  it("an untouched large frame reports no motion", () => {
    const size = 1280 * 840 * 3;
    expect(
      scrollPixelsChanged(Buffer.alloc(size, 0x20), Buffer.alloc(size, 0x20)),
    ).toBe(false);
  });
});
