/**
 * resource-model.ts
 *
 * Projection functions for per-lens MCP resources.
 * Pure functions — no OS imports. All inputs injected.
 *
 * Views:
 *   summary  — attention, watermark, canAct, guards summary, target/browser state
 *   guards   — full GuardResult list
 *   debug    — all fluents, dirty journal, native diagnostics (gated behind DEBUG_RESOURCES)
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

// ── RebindSuggestion ──────────────────────────────────────────────────────────

export interface RebindSuggestion {
  action: "forget_and_register_again";
  reason: "identity_changed" | "target_missing";
  lensId: string;
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
  /** Whether the DirtyJournal has any entries for this lens's entity. */
  hasJournalDirty: boolean;
  nowMs: number;
  seq: number;
}

export function buildLensSnapshot(
  lens: PerceptionLens,
  store: FluentStore,
  journal: DirtyJournal,
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

  // Check journal for event-driven dirty marks on this entity.
  const entityKey   = `${lens.spec.target.kind}:${lens.binding.hwnd}`;
  const hasJournalDirty = journal.isGlobalDirty() || journal.entries().has(entityKey);

  // Derive attention with full priority chain (mirrors envelope.ts deriveAttention)
  let attention: AttentionState;
  if (!guardResult.ok) {
    // identity_changed guard failure gets specific attention state
    const failedKind = guardResult.failedGuard?.kind ?? "";
    attention = failedKind === "target.identityStable" ? "identity_changed" : "guard_failed";
  } else if (hasDirty || hasJournalDirty) {
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
    hasJournalDirty,
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
    hasJournalDirty: boolean;
  };
  target?: Record<string, unknown>;
  browser?: Record<string, unknown>;
  guards: Record<string, { ok: boolean; confidence: number }>;
  changed: string[];
  canAct: CanAct;
  suggestedNext?: string;
  rebindSuggestion?: RebindSuggestion;
}

export function projectResourceSummary(snapshot: LensSnapshot): SummaryResource {
  const { lens, guardResult, canAct, attention, fluents, hasDirty, hasSettling, hasStale, hasJournalDirty, nowMs, seq } = snapshot;
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
    watermark: { hasDirty, hasSettling, hasStale, hasJournalDirty },
    guards: guardsOut,
    changed: [],
    canAct,
  };

  // Suggest next action based on attention
  if (attention === "identity_changed") {
    summary.suggestedNext = "Window identity changed. Forget and re-register the lens.";
    summary.rebindSuggestion = {
      action: "forget_and_register_again",
      reason: "identity_changed",
      lensId: lens.lensId,
    };
  } else if (!guardResult.ok && guardResult.failedGuard) {
    summary.suggestedNext = guardResult.failedGuard.suggestedAction;
  } else if (attention === "dirty" || attention === "settling") {
    summary.suggestedNext = "Call perception_read to get fresh observations before acting";
  } else if (attention === "stale") {
    summary.suggestedNext = "Call perception_read to refresh stale state";
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
  rebindSuggestion?: RebindSuggestion;
}

export function projectResourceGuards(snapshot: LensSnapshot): GuardsResource {
  const { lens, guardResult, seq, attention } = snapshot;
  const result: GuardsResource = {
    lensId: lens.lensId,
    seq,
    policy: lens.spec.guardPolicy ?? "block",
    ok: guardResult.ok,
    guards: guardResult.results.map(r => ({
      ...r,
      summary: formatGuardSummary(r),
    })),
  };
  if (attention === "identity_changed") {
    result.rebindSuggestion = {
      action: "forget_and_register_again",
      reason: "identity_changed",
      lensId: lens.lensId,
    };
  }
  return result;
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
  dirtyJournal: {
    hasEntityDirty: boolean;
    globalDirty: boolean;
    entryCount: number;
    dirtyEntityKeys: string[];
  };
  diagnostics: {
    hasDirty: boolean;
    hasSettling: boolean;
    hasStale: boolean;
    hasJournalDirty: boolean;
    guardOk: boolean;
    attention: AttentionState;
  };
  native?: unknown;
  warnings: string[];
}

export function projectResourceDebug(
  snapshot: LensSnapshot,
  nativeDiagnostics?: unknown,
): DebugResource {
  const { lens, guardResult, fluents, hasDirty, hasSettling, hasStale, hasJournalDirty, attention, seq, nowMs } = snapshot;

  const warnings: string[] = [];
  if (hasDirty)        warnings.push("has_dirty_fluents");
  if (hasSettling)     warnings.push("has_settling_fluents");
  if (hasStale)        warnings.push("has_stale_fluents");
  if (hasJournalDirty) warnings.push("has_journal_dirty");
  if (!guardResult.ok) warnings.push(`guard_failed:${guardResult.failedGuard?.kind}`);

  // Journal info: lens-specific entity key
  const entityKey = `${lens.spec.target.kind}:${lens.binding.hwnd}`;

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
    dirtyJournal: {
      hasEntityDirty: snapshot.hasJournalDirty,
      globalDirty:    false, // resolved at snapshot time
      entryCount:     0,     // not exposed per-lens to avoid leaking other lens data
      dirtyEntityKeys: snapshot.hasJournalDirty ? [entityKey] : [],
    },
    diagnostics: {
      hasDirty,
      hasSettling,
      hasStale,
      hasJournalDirty,
      guardOk: guardResult.ok,
      attention,
    },
    ...(nativeDiagnostics !== undefined && { native: nativeDiagnostics }),
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
