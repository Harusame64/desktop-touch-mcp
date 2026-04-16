/**
 * resource-model.ts
 *
 * Projection functions for per-lens MCP resources.
 * Pure functions — no OS imports. All inputs injected.
 *
 * Views:
 *   summary  — attention, watermark, canAct, guards summary, target/browser state
 *   guards   — full GuardResult list
 *   debug    — all fluents, dirty journal, diagnostics (gated behind DEBUG_RESOURCES)
 */

import type {
  AttentionState,
  Fluent,
  GuardEvalResult,
  GuardResult,
  PerceptionLens,
} from "./types.js";
import type { FluentStore } from "./fluent-store.js";
import type { DirtyJournal } from "./dirty-journal.js";
import { evaluateGuards } from "./guards.js";
import { confidenceFor } from "./evidence.js";

// ── canAct helper ─────────────────────────────────────────────────────────────

export interface CanAct {
  keyboard: boolean;
  mouse: boolean;
}

export function computeCanAct(guardResult: GuardEvalResult): CanAct {
  if (!guardResult.ok) {
    return { keyboard: false, mouse: false };
  }
  return { keyboard: true, mouse: true };
}

// ── formatGuardSummary ────────────────────────────────────────────────────────

/** Shared guard failure message template for envelope and resources. */
export function formatGuardSummary(r: GuardResult): string {
  if (r.ok) return `${r.kind}: ok (confidence=${r.confidence.toFixed(2)})`;
  const parts = [`${r.kind}: FAILED`];
  if (r.reason) parts.push(`reason="${r.reason}"`);
  if (r.suggestedAction) parts.push(`action="${r.suggestedAction}"`);
  return parts.join(" | ");
}

// ── LensSnapshot ─────────────────────────────────────────────────────────────

export interface LensSnapshot {
  lens: PerceptionLens;
  guardResult: GuardEvalResult;
  canAct: CanAct;
  attention: AttentionState;
  fluents: Map<string, Fluent>;
  hasDirty: boolean;
  hasSettling: boolean;
  hasStale: boolean;
  nowMs: number;
  seq: number;
}

export function buildLensSnapshot(
  lens: PerceptionLens,
  store: FluentStore,
  _journal: DirtyJournal,
): LensSnapshot {
  const nowMs = Date.now();
  const guardResult = evaluateGuards(lens, store, lens.spec.guardPolicy ?? "block");
  const canAct = computeCanAct(guardResult);

  const fluents = new Map<string, Fluent>();
  for (const key of lens.fluentKeys) {
    const f = store.read(key);
    if (f) fluents.set(key, f);
  }

  const hasDirty    = [...fluents.values()].some(f => f.status === "dirty");
  const hasSettling = [...fluents.values()].some(f => f.status === "settling");
  const hasStale    = [...fluents.values()].some(f => f.status === "stale");

  // Derive attention with full priority chain (mirrors envelope.ts deriveAttention)
  let attention: AttentionState;
  if (!guardResult.ok) {
    attention = "guard_failed";
  } else if (hasDirty) {
    attention = "dirty";
  } else if (hasSettling) {
    attention = "settling";
  } else if (hasStale) {
    attention = "stale";
  } else {
    attention = "ok";
  }

  return {
    lens,
    guardResult,
    canAct,
    attention,
    fluents,
    hasDirty,
    hasSettling,
    hasStale,
    nowMs,
    seq: store.currentSeq(),
  };
}

// ── Resource projections ──────────────────────────────────────────────────────

export interface SummaryResource {
  lensId: string;
  seq: number;
  attention: AttentionState;
  watermark: {
    hasDirty: boolean;
    hasSettling: boolean;
    hasStale: boolean;
  };
  target?: Record<string, unknown>;
  browser?: Record<string, unknown>;
  guards: Record<string, { ok: boolean; confidence: number }>;
  changed: string[];
  canAct: CanAct;
  suggestedNext?: string;
}

export function projectResourceSummary(snapshot: LensSnapshot): SummaryResource {
  const { lens, guardResult, canAct, attention, fluents, hasDirty, hasSettling, hasStale, nowMs, seq } = snapshot;
  const entityKind = lens.spec.target.kind;
  const entityId   = lens.binding.hwnd;

  function read(property: string): Fluent | undefined {
    return fluents.get(`${entityKind}:${entityId}.${property}`);
  }

  const guardsOut: Record<string, { ok: boolean; confidence: number }> = {};
  for (const r of guardResult.results) {
    guardsOut[r.kind] = { ok: r.ok, confidence: Math.round(r.confidence * 100) / 100 };
  }

  const summary: SummaryResource = {
    lensId: lens.lensId,
    seq,
    attention,
    watermark: { hasDirty, hasSettling, hasStale },
    guards: guardsOut,
    changed: [],
    canAct,
  };

  // Suggest next action based on attention
  if (!guardResult.ok && guardResult.failedGuard) {
    summary.suggestedNext = guardResult.failedGuard.suggestedAction;
  } else if (hasDirty || hasSettling) {
    summary.suggestedNext = "Call perception_read to get fresh observations";
  } else if (attention === "ok") {
    summary.suggestedNext = "Ready to act";
  }

  if (entityKind === "browserTab") {
    const url       = read("browser.url");
    const title     = read("browser.title");
    const readyState = read("browser.readyState");
    summary.browser = {
      ...(url        && { url: url.value }),
      ...(title      && { title: title.value }),
      ...(readyState && { readyState: readyState.value }),
      confidence: computeAvgConf([url, title, readyState], nowMs),
    };
  } else {
    const exists  = read("target.exists");
    const titleF  = read("target.title");
    const rect    = read("target.rect");
    const fg      = read("target.foreground");
    const modal   = read("modal.above");
    summary.target = {
      ...(exists  && { exists: exists.value }),
      ...(titleF  && { title: titleF.value }),
      ...(rect    && { rect: rect.value }),
      ...(fg      && { foreground: fg.value }),
      ...(modal   && { modalAbove: modal.value }),
      confidence: computeAvgConf([exists, titleF, rect, fg, modal], nowMs),
    };
  }

  return summary;
}

export interface GuardsResource {
  lensId: string;
  seq: number;
  policy: string;
  ok: boolean;
  guards: Array<GuardResult & { summary: string }>;
}

export function projectResourceGuards(snapshot: LensSnapshot): GuardsResource {
  const { lens, guardResult, seq } = snapshot;
  return {
    lensId: lens.lensId,
    seq,
    policy: lens.spec.guardPolicy ?? "block",
    ok: guardResult.ok,
    guards: guardResult.results.map(r => ({
      ...r,
      summary: formatGuardSummary(r),
    })),
  };
}

export interface DebugResource {
  lensId: string;
  seq: number;
  fluents: Array<{
    key: string;
    value: unknown;
    status: string;
    confidence: number;
    validFromMonoMs: number;
    lastDirtyAtMonoMs: number | undefined;
    lastDirtyCause: string | undefined;
  }>;
  diagnostics: {
    hasDirty: boolean;
    hasSettling: boolean;
    hasStale: boolean;
    guardOk: boolean;
    attention: AttentionState;
  };
  warnings: string[];
}

export function projectResourceDebug(snapshot: LensSnapshot): DebugResource {
  const { lens, guardResult, fluents, hasDirty, hasSettling, hasStale, attention, seq, nowMs } = snapshot;

  const warnings: string[] = [];
  if (hasDirty)    warnings.push("has_dirty_fluents");
  if (hasSettling) warnings.push("has_settling_fluents");
  if (hasStale)    warnings.push("has_stale_fluents");
  if (!guardResult.ok) warnings.push(`guard_failed:${guardResult.failedGuard?.kind}`);

  return {
    lensId: lens.lensId,
    seq,
    fluents: [...fluents.entries()].map(([key, f]) => ({
      key,
      value: f.value,
      status: f.status,
      confidence: Math.round((f.support[0] ? confidenceFor(f.support[0], nowMs) : f.confidence) * 100) / 100,
      validFromMonoMs: f.validFromMonoMs,
      lastDirtyAtMonoMs: f.lastDirtyAtMonoMs,
      lastDirtyCause: f.lastDirtyCause,
    })),
    diagnostics: {
      hasDirty,
      hasSettling,
      hasStale,
      guardOk: guardResult.ok,
      attention,
    },
    warnings,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeAvgConf(fluents: (Fluent | undefined)[], nowMs: number): number {
  const valid = fluents.filter(Boolean) as Fluent[];
  if (valid.length === 0) return 0;
  const total = valid.reduce((s, f) => s + (f.support[0] ? confidenceFor(f.support[0], nowMs) : f.confidence), 0);
  return Math.round((total / valid.length) * 100) / 100;
}
