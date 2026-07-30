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
 * results are cached per exact (normalised text, marker) pair — keyed by the
 * buffer's own SHA-256 fingerprint rather than the buffer itself, so entries
 * stay O(1)-sized and an idle poll tick costs one linear hash of the buffer
 * instead of up to ~32k windowed SHA-256 digests. A changed buffer misses the
 * memo and pays the real scan, which is exactly when the work is needed.
 * Entries are a tiny FIFO — the working set is one or two (buffer, marker)
 * pairs per live poll loop.
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
  /** UTF-16 length of the normalised buffer — cheap pre-filter before digest compare. */
  len: number;
  /** Full SHA-256 (base64) of the normalised buffer. The entry stores this
   *  FINGERPRINT instead of the buffer itself, so retention is O(1) per entry
   *  regardless of how large a terminal scrollback gets — a resident server
   *  never pins a multi-MB buffer in the memo. A memo probe therefore costs
   *  one linear hash of the incoming buffer (~30µs per 33k chars, vs ~50ms
   *  for the scan it replaces); full-width SHA-256 makes an accidental
   *  collision (which would return a stale result) cryptographically
   *  negligible. */
  digest: string;
  marker: string;
  end: number | null;
}

const MEMO_MAX = 4;
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
  const digest = createHash("sha256").update(norm).digest("base64");
  for (const m of memo) {
    // Cheap fields first (marker 16 chars, len number); digest compare is a
    // fixed 44-char string either way.
    if (m.marker === marker && m.len === norm.length && m.digest === digest) return m.end;
  }
  const end = scan(norm, marker);
  memo.push({ len: norm.length, digest, marker, end });
  if (memo.length > MEMO_MAX) memo.shift();
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
