/**
 * uia-diff.ts — Compute before/after diff of a UIA element tree snapshot.
 *
 * Used by withRichNarration (3.2) to populate post.rich without a
 * confirmation screenshot.  Pure functions — no I/O.
 */

import type { UiElement } from "./uia-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AppearedItem {
  name: string;
  type: string;
  automationId?: string;
}

export interface DisappearedItem {
  name: string;
  type: string;
}

export interface ValueDeltaItem {
  name: string;
  type: string;
  before: string;
  after: string;
}

export type DiffSource = "uia" | "cdp" | "none";
export type DiffDegraded = "chromium_sparse" | "timeout" | "window_closed" | "process_restarted" | "no_target";

export interface UiaDiffResult {
  appeared: AppearedItem[];
  disappeared: DisappearedItem[];
  valueDeltas: ValueDeltaItem[];
  truncated?: {
    appeared?: number;
    disappeared?: number;
    valueDeltas?: number;
  };
}

export interface RichBlock extends UiaDiffResult {
  diffSource: DiffSource;
  diffDegraded?: DiffDegraded;
  navigation?: { fromUrl: string; toUrl: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CAP_APPEARED    = 5;
const CAP_DISAPPEARED = 5;
const CAP_VALUE_DELTAS = 3;
/** Number of characters kept before appending the ellipsis "…". Total output length is VALUE_TRIM_PREFIX + 1. */
const VALUE_TRIM_PREFIX = 80;

function elementKey(el: UiElement): string {
  if (el.automationId) return `aid:${el.automationId}`;
  // NOTE: siblings with the same controlType, name, and depth collapse to one key.
  // This is a known limitation: duplicate-named siblings (e.g., repeated "Tab" items)
  // may cause phantom appeared/disappeared when sibling order changes.
  return `ct:${el.controlType}|n:${el.name}|d:${el.depth}`;
}

function trimValue(s: string): string {
  return s.length > VALUE_TRIM_PREFIX ? s.slice(0, VALUE_TRIM_PREFIX) + "…" : s;
}

function hasVisibleBounds(el: UiElement): boolean {
  const r = el.boundingRect;
  return !!r && r.width > 0 && r.height > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Diff two UIA element snapshots.
 *
 * Identity key: automationId (preferred) → controlType|name|depth (fallback).
 * Filters out elements with empty names or invisible bounding rects.
 * Applies size caps and reports overflow in `truncated`.
 */
export function computeUiaDiff(
  before: UiElement[],
  after: UiElement[]
): UiaDiffResult {
  const beforeMap = new Map<string, UiElement>();
  const afterMap  = new Map<string, UiElement>();

  for (const el of before) {
    if (el.name) beforeMap.set(elementKey(el), el);
  }
  for (const el of after) {
    if (el.name) afterMap.set(elementKey(el), el);
  }

  // ── Appeared ──────────────────────────────────────────────────────────────
  // Covers: (a) new element that is visible, (b) element that was hidden and became visible.
  const appearedAll: AppearedItem[] = [];
  for (const [key, el] of afterMap) {
    if (!hasVisibleBounds(el)) continue;            // still/newly invisible — skip
    const beforeEl = beforeMap.get(key);
    if (!beforeEl || !hasVisibleBounds(beforeEl)) {
      // New or was hidden before
      const item: AppearedItem = { name: el.name, type: el.controlType };
      if (el.automationId) item.automationId = el.automationId;
      appearedAll.push(item);
    }
  }

  // ── Disappeared ───────────────────────────────────────────────────────────
  // Covers: (a) element fully removed, (b) element that was visible and became hidden.
  const disappearedAll: DisappearedItem[] = [];
  for (const [key, el] of beforeMap) {
    if (!hasVisibleBounds(el)) continue;            // was already hidden — skip
    const afterEl = afterMap.get(key);
    if (!afterEl || !hasVisibleBounds(afterEl)) {
      // Removed or became hidden
      disappearedAll.push({ name: el.name, type: el.controlType });
    }
  }

  // ── Value deltas ──────────────────────────────────────────────────────────
  // Only produced when the element snapshot includes `value` (fetchValues:true).
  const valueDeltasAll: ValueDeltaItem[] = [];
  for (const [key, beforeEl] of beforeMap) {
    const afterEl = afterMap.get(key);
    if (
      afterEl &&
      beforeEl.value !== undefined &&
      afterEl.value  !== undefined &&
      beforeEl.value !== afterEl.value
    ) {
      valueDeltasAll.push({
        name:   beforeEl.name,
        type:   beforeEl.controlType,
        before: trimValue(beforeEl.value),
        after:  trimValue(afterEl.value),
      });
    }
  }

  // ── Apply caps ────────────────────────────────────────────────────────────
  const truncated: UiaDiffResult["truncated"] = {};

  const appeared = appearedAll.slice(0, CAP_APPEARED);
  if (appearedAll.length > CAP_APPEARED) {
    truncated.appeared = appearedAll.length - CAP_APPEARED;
  }

  const disappeared = disappearedAll.slice(0, CAP_DISAPPEARED);
  if (disappearedAll.length > CAP_DISAPPEARED) {
    truncated.disappeared = disappearedAll.length - CAP_DISAPPEARED;
  }

  const valueDeltas = valueDeltasAll.slice(0, CAP_VALUE_DELTAS);
  if (valueDeltasAll.length > CAP_VALUE_DELTAS) {
    truncated.valueDeltas = valueDeltasAll.length - CAP_VALUE_DELTAS;
  }

  const result: UiaDiffResult = { appeared, disappeared, valueDeltas };
  if (Object.keys(truncated).length > 0) result.truncated = truncated;
  return result;
}

/** Build a degraded RichBlock (no diff available). */
export function degradedRichBlock(reason: DiffDegraded): RichBlock {
  return {
    appeared: [],
    disappeared: [],
    valueDeltas: [],
    diffSource: "none",
    diffDegraded: reason,
  };
}
