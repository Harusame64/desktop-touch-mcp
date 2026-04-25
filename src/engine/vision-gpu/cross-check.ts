/**
 * cross-check.ts — Phase 4b-6 multi-engine OCR voting.
 *
 * Arbitrates between two OCR engines (PaddleOCR-v4-server as primary,
 * PaddleOCR-v4-mobile as secondary) using Levenshtein distance. Falls through
 * to win-ocr.exe (Tier ∞) when both engines produce empty / mismatched output
 * beyond the acceptable threshold.
 *
 * ADR-005 §3 D3': distance < 0.2 ratio → primary wins, else both provisional.
 */

import type { NativeRawCandidate } from "../native-types.js";

/** Max normalized Levenshtein distance for primary to win unconditionally. */
export const CROSS_CHECK_AGREEMENT_THRESHOLD = 0.2;

/** Optional Tier ∞ fallback function. Invoked per-candidate when both engines
 *  produce empty labels. Receives the original frameBuffer + dims so the
 *  fallback can crop the rect to a PNG and feed win-ocr.exe.
 *  Should return a label string (or empty on failure). */
export type WinOcrFallbackFn = (
  targetKey: string,
  rect: { x: number; y: number; width: number; height: number },
  frameBuffer: Buffer,
  frameWidth: number,
  frameHeight: number,
) => Promise<string>;

/**
 * Compute normalized Levenshtein distance (0 = identical, 1 = totally different).
 * Pure TS implementation, no dependencies. O(m*n) DP.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,       // insert
        prev[j]! + 1,           // delete
        prev[j - 1]! + cost,    // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  const raw = prev[n]!;
  return raw / Math.max(m, n);
}

/**
 * Arbitrate between primary (server) and secondary (mobile) outputs.
 * Returns the merged candidate list keyed by trackId.
 *
 * Rules:
 *   - If both labels non-empty AND distance < threshold → use primary label,
 *     confidence = max(primary, secondary), provisional = false (agreed)
 *   - If both labels non-empty AND distance >= threshold → use primary label,
 *     provisional = true (disagreement), confidence slightly penalised
 *   - If only primary has label → use primary as-is (provisional from primary)
 *   - If only secondary has label → use secondary
 *   - If both empty → call winOcrFallback if provided, else return primary unchanged
 */
export async function crossCheckLabels(
  primary: NativeRawCandidate[],
  secondary: NativeRawCandidate[],
  options?: {
    threshold?: number;
    winOcrFallback?: WinOcrFallbackFn;
    targetKey?: string;
    frameBuffer?: Buffer;
    frameWidth?: number;
    frameHeight?: number;
  },
): Promise<NativeRawCandidate[]> {
  const threshold = options?.threshold ?? CROSS_CHECK_AGREEMENT_THRESHOLD;
  const byTrackId = new Map(secondary.map((c) => [c.trackId, c]));
  const out: NativeRawCandidate[] = [];

  for (const p of primary) {
    const s = byTrackId.get(p.trackId);
    if (!s) {
      // No secondary counterpart — use primary as-is.
      out.push(p);
      continue;
    }
    const pLabel = p.label || "";
    const sLabel = s.label || "";

    if (pLabel !== "" && sLabel !== "") {
      const dist = levenshteinDistance(pLabel, sLabel);
      if (dist < threshold) {
        // Agreement — promote confidence, mark non-provisional.
        out.push({
          ...p,
          label: pLabel,
          confidence: Math.max(p.confidence, s.confidence),
          provisional: false,
        });
      } else {
        // Disagreement — keep primary label but mark provisional.
        out.push({
          ...p,
          label: pLabel,
          confidence: Math.min(p.confidence, 0.6),
          provisional: true,
        });
      }
      continue;
    }

    if (pLabel !== "") { out.push(p); continue; }
    if (sLabel !== "") { out.push({ ...p, label: sLabel, confidence: s.confidence }); continue; }

    // Both empty → Tier ∞ fallback if provided.
    if (options?.winOcrFallback && options.frameBuffer && options.frameWidth && options.frameHeight) {
      try {
        const fallback = await options.winOcrFallback(
          options.targetKey ?? "",
          p.rect,
          options.frameBuffer,
          options.frameWidth,
          options.frameHeight,
        );
        out.push({ ...p, label: fallback, confidence: fallback ? 0.5 : 0.3, provisional: true });
      } catch (err) {
        // Post-review R4: log Tier ∞ failures so operations can detect win-ocr breakage.
        console.warn("[cross-check] winOcrFallback threw:", err);
        out.push(p);
      }
    } else {
      out.push(p);
    }
  }
  return out;
}
