/**
 * Evidence helpers for the Reactive Perception Graph.
 * Pure functions — no OS imports.
 */

import type { Evidence, EvidenceCost, SensorSource } from "./types.js";

// Confidence table from the RPG design doc
const BASE_CONFIDENCE: Record<SensorSource, number> = {
  win32:    0.98,
  cdp:      0.96,
  uia:      0.90,
  image:    0.60,
  ocr:      0.65,
  inferred: 0.50,
};

// Default TTL per source (ms)
const DEFAULT_TTL: Record<SensorSource, number> = {
  win32:    5_000,
  cdp:      8_000,
  uia:      10_000,
  image:    15_000,
  ocr:      20_000,
  inferred: 30_000,
};

const COST: Record<SensorSource, EvidenceCost> = {
  win32:    "cheap",
  cdp:      "medium",
  uia:      "expensive",
  image:    "expensive",
  ocr:      "expensive",
  inferred: "cheap",
};

export function makeEvidence(
  source: SensorSource,
  seq: number,
  nowMs: number,
  overrides?: { ttlMs?: number; notes?: string[] }
): Evidence {
  return {
    source,
    observedAtSeq: seq,
    observedAtMs: nowMs,
    cost: COST[source],
    ttlMs: overrides?.ttlMs ?? DEFAULT_TTL[source],
    ...(overrides?.notes && { notes: overrides.notes }),
  };
}

export function isStale(ev: Evidence, nowMs: number): boolean {
  if (ev.ttlMs == null) return false;
  return nowMs - ev.observedAtMs > ev.ttlMs;
}

/**
 * Compute confidence for a fluent given its primary evidence and current age.
 * Confidence decays linearly to 0.40 once the TTL is exceeded.
 */
export function confidenceFor(ev: Evidence, nowMs: number): number {
  const base = BASE_CONFIDENCE[ev.source] ?? 0.50;
  if (!ev.ttlMs) return base;
  const age = nowMs - ev.observedAtMs;
  if (age <= 0) return base;
  if (age >= ev.ttlMs) return 0.40; // stale floor
  // Linear decay from base to 0.40 over ttlMs
  const fraction = age / ev.ttlMs;
  return base - fraction * (base - 0.40);
}
