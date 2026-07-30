/**
 * _since-marker.ts — shared marker-relocation scan for `sinceMarker` diffs.
 *
 * `terminal` and `keyboard` both relocate a previously-taken baseline marker
 * (SHA-256 of the last 256 normalised chars, hex-truncated to 16 — a PUBLIC
 * wire token via `terminal`'s `sinceMarker` param, so the hash scheme cannot
 * change) by hashing every candidate window position. The scan itself is
 * O(scanRange × WINDOW) with a fresh hash object per position — ~10-30ms on a
 * saturated 32k buffer — and the `terminal(action='run')` until-loop repeats
 * it every ~200ms poll tick against a buffer that is usually UNCHANGED while
 * a command runs quietly.
 *
 * The memo below removes that amplifier without touching the hash scheme:
 * results are cached per exact (normalised text, marker) pair, so an idle
 * poll tick costs one native string compare instead of up to ~32k SHA-256
 * digests. A changed buffer misses the memo and pays the real scan, which is
 * exactly when the work is needed. Entries are a tiny FIFO — the working set
 * is one or two (buffer, marker) pairs per live poll loop.
 *
 * Callers keep their own `normalizeForMarker` (terminal additionally strips
 * per-line trailing whitespace against Windows Terminal padding churn;
 * keyboard does not) and their own tail/fall-through handling — this module
 * owns only the scan.
 */

import { createHash } from "node:crypto";

const WINDOW = 256;
const MAX_SCAN = 32_000;

interface MemoEntry {
  norm: string;
  marker: string;
  end: number | null;
}

const MEMO_MAX = 4;
// Retention bound: entries hold the full normalised buffer (a well-scrolled
// terminal can be hundreds of KB), and a module-level FIFO on a resident
// server would otherwise keep the last 4 indefinitely. 2M chars (~4MB as
// UTF-16) caps the worst case while never evicting the typical working set
// (one or two ≤100k buffers per live poll loop).
const MEMO_MAX_TOTAL_CHARS = 2_000_000;
let memo: MemoEntry[] = [];

/** Test hook: clear the memo so perf pins measure the real scan. */
export function _resetSinceMarkerMemoForTest(): void {
  memo = [];
}

/**
 * Locate the (normalised) end index of the marker window inside `norm`.
 * Returns `null` when the marker cannot be relocated (caller decides the
 * fall-through: full text + matched:false).
 *
 * Semantics are byte-identical to the previous per-caller loops: the
 * sliding-window path runs when `norm.length >= 256` (window = marker of the
 * last 256 normalised chars, scanned tail-first, capped at 32k positions);
 * otherwise the prefix path runs (marker of the entire previous text,
 * scanned longest-first).
 */
export function scanSinceMarkerNormEnd(norm: string, marker: string): number | null {
  for (const m of memo) {
    // Marker first: 16 chars, rejects cheaply. The `norm` compare is a native
    // O(n) memcmp only on marker match — still ~1000x cheaper than the scan.
    if (m.marker === marker && m.norm === norm) return m.end;
  }
  const end = scan(norm, marker);
  memo.push({ norm, marker, end });
  if (memo.length > MEMO_MAX) memo.shift();
  let totalChars = memo.reduce((s, m) => s + m.norm.length, 0);
  while (totalChars > MEMO_MAX_TOTAL_CHARS && memo.length > 1) {
    totalChars -= memo.shift()!.norm.length;
  }
  return end;
}

function scan(norm: string, marker: string): number | null {
  if (norm.length >= WINDOW) {
    const maxScan = Math.min(norm.length, WINDOW + MAX_SCAN);
    for (let end = norm.length; end >= norm.length - maxScan && end >= WINDOW; end--) {
      const slice = norm.slice(end - WINDOW, end);
      if (createHash("sha256").update(slice).digest("hex").slice(0, 16) === marker) {
        return end;
      }
    }
    return null;
  }
  for (let end = norm.length; end >= 0; end--) {
    if (createHash("sha256").update(norm.slice(0, end)).digest("hex").slice(0, 16) === marker) {
      return end;
    }
  }
  return null;
}
