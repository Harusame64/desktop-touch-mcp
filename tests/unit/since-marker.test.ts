/**
 * since-marker.test.ts — shared marker-relocation scan (`_since-marker.ts`).
 *
 * The scan was extracted from byte-identical loops in terminal.ts /
 * keyboard.ts and memoised per (norm, marker) because the terminal
 * until-loop re-runs it every ~200ms poll tick against a usually-unchanged
 * buffer (measured: 51.6ms per full 33k-char miss scan — the until-loop runs
 * exactly one of its exit/pattern relocations per tick, so ~26% of the tick
 * budget — vs ~0.001ms per memo hit).
 *
 * Behavioral SSOT stays with the callers' suites (terminal-marker.test.ts
 * pins the normalise/tail semantics); this file pins the extracted scan
 * against a reference implementation and the memo against regression.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  scanSinceMarkerNormEnd,
  _resetSinceMarkerMemoForTest,
} from "../../src/tools/_since-marker.js";

const WINDOW = 256;

/** The pre-extraction loop, verbatim (terminal.ts / keyboard.ts). */
function referenceScan(norm: string, marker: string): number | null {
  if (norm.length >= WINDOW) {
    const maxScan = Math.min(norm.length, WINDOW + 32_000);
    for (let end = norm.length; end >= norm.length - maxScan && end >= WINDOW; end--) {
      const slice = norm.slice(end - WINDOW, end);
      if (createHash("sha256").update(slice).digest("hex").slice(0, 16) === marker) return end;
    }
    return null;
  }
  for (let end = norm.length; end >= 0; end--) {
    if (createHash("sha256").update(norm.slice(0, end)).digest("hex").slice(0, 16) === marker) return end;
  }
  return null;
}

const markerOfTail = (norm: string): string =>
  createHash("sha256").update(norm.slice(-WINDOW)).digest("hex").slice(0, 16);

describe("scanSinceMarkerNormEnd — reference equivalence", () => {
  beforeEach(() => _resetSinceMarkerMemoForTest());

  it("window path: marker taken mid-history relocates to the same end as the reference", () => {
    const before = "prompt> ls\n" + "file-line\n".repeat(60); // > 256 chars
    const marker = markerOfTail(before);
    const after = before + "new output line\nprompt> ";
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(referenceScan(after, marker));
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(before.length);
  });

  it("window path: CJK content (UTF-16 slicing must match hashing units)", () => {
    const before = "コマンド実行結果：".repeat(40);
    const marker = markerOfTail(before);
    const after = before + "追加の出力🎉\n";
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(referenceScan(after, marker));
  });

  it("window path: miss returns null, same as reference", () => {
    const buf = "z".repeat(1000);
    expect(scanSinceMarkerNormEnd(buf, "0123456789abcdef")).toBeNull();
    expect(referenceScan(buf, "0123456789abcdef")).toBeNull();
  });

  it("prefix path (< 256 chars): relocates the old snapshot end", () => {
    const before = "C:\\> dir";
    const marker = createHash("sha256").update(before).digest("hex").slice(0, 16);
    const after = before + "\n Volume in drive C";
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(referenceScan(after, marker));
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(before.length);
  });

  it("scan-cap: a marker pushed beyond the 32k lookback misses (documented contract)", () => {
    const before = "a".repeat(300);
    const marker = markerOfTail(before);
    const after = before + "b".repeat(40_000); // marker window now > 32k from tail
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(referenceScan(after, marker));
    expect(scanSinceMarkerNormEnd(after, marker)).toBeNull();
  });
});

describe("scanSinceMarkerNormEnd — memo", () => {
  beforeEach(() => _resetSinceMarkerMemoForTest());

  it("caches per (norm, marker): same pair returns the same result, different marker re-scans", () => {
    const before = "x".repeat(300);
    const marker = markerOfTail(before);
    const after = before + "tail";
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(300);
    expect(scanSinceMarkerNormEnd(after, marker)).toBe(300); // memo hit
    // Same norm, different marker must NOT reuse the cached end.
    expect(scanSinceMarkerNormEnd(after, "0123456789abcdef")).toBeNull();
  });

  it("repeated identical calls are memo-fast (regression pin for the 200ms-poll amplifier)", () => {
    // Worst case: a 33k buffer where the marker never matches — the real scan
    // costs ~50ms (measured). A memo probe pays one SHA-256 of the buffer, so
    // 100 repeated calls cost ~2.4ms; without the memo they'd cost ~5,000ms.
    // 500ms keeps a ~200x margin over the memoised cost while failing by an
    // order of magnitude if the memo regresses.
    const buf = "q".repeat(33_000);
    const marker = "0123456789abcdef";
    scanSinceMarkerNormEnd(buf, marker); // first call pays the real scan
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) scanSinceMarkerNormEnd(buf, marker);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
