/**
 * Perception envelope projection.
 * Pure function — no OS imports.
 */

import type {
  AttentionState,
  Fluent,
  GuardEvalResult,
  PerceptionEnvelope,
  PerceptionLens,
} from "./types.js";
import type { FluentStore } from "./fluent-store.js";
import { confidenceFor } from "./evidence.js";

export interface ProjectEnvelopeOptions {
  maxTokens?: number;
  changedKeys?: Set<string>;
}

function deriveAttention(
  guardResult: GuardEvalResult,
  changedKeys: Set<string>,
  hasStale: boolean
): AttentionState {
  if (!guardResult.ok) return "guard_failed";
  if (changedKeys.size > 0) return "changed";
  if (hasStale) return "stale";
  return "ok";
}

function describeChange(key: string, fluent: Fluent | undefined): string {
  if (!fluent) return `${key} updated`;
  const prop = key.split(".").slice(1).join(".");
  const val = fluent.value;
  if (prop === "target.rect" && val && typeof val === "object") {
    const r = val as { x: number; y: number; width: number; height: number };
    return `target moved to (${r.x},${r.y}) size ${r.width}×${r.height}`;
  }
  if (prop === "target.foreground") return val ? "target gained foreground" : "target lost foreground";
  if (prop === "target.title") return `title changed to "${val}"`;
  if (prop === "target.exists" && val === false) return "target window closed";
  if (prop === "modal.above") return val ? "modal appeared above target" : "modal dismissed";
  return `${prop} changed`;
}

function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

export function projectEnvelope(
  lens: PerceptionLens,
  store: FluentStore,
  guardResult: GuardEvalResult,
  opts: ProjectEnvelopeOptions = {}
): PerceptionEnvelope {
  const { changedKeys = new Set<string>(), maxTokens = lens.spec.maxEnvelopeTokens } = opts;
  const nowMs = Date.now();
  const hwnd = lens.binding.hwnd;

  // Read current fluent values
  const existsFluent  = store.read(`window:${hwnd}.target.exists`);
  const titleFluent   = store.read(`window:${hwnd}.target.title`);
  const rectFluent    = store.read(`window:${hwnd}.target.rect`);
  const fgFluent      = store.read(`window:${hwnd}.target.foreground`);
  const zOrderFluent  = store.read(`window:${hwnd}.target.zOrder`);
  const modalFluent   = store.read(`window:${hwnd}.modal.above`);

  const hasStale = [existsFluent, titleFluent, rectFluent, fgFluent, modalFluent]
    .some(f => f?.status === "stale" || f?.status === "dirty");

  const attention = deriveAttention(guardResult, changedKeys, hasStale);

  // Build changed summaries (coalesced)
  const changedSummaries: string[] = [];
  for (const key of changedKeys) {
    const prop = key.split(".").slice(1).join(".");
    // Skip identity details from summary (verbose)
    if (prop === "target.identity") continue;
    const fluent = store.read(key);
    changedSummaries.push(describeChange(key, fluent));
  }

  // Guards summary
  const guardsMap: Record<string, boolean> = {};
  for (const r of guardResult.results) {
    guardsMap[r.kind] = r.ok;
  }

  // Compute latest target block confidence
  const fluents = [existsFluent, titleFluent, rectFluent, fgFluent, zOrderFluent, modalFluent].filter(Boolean);
  const avgConf = fluents.length > 0
    ? fluents.reduce((s, f) => s + (f ? confidenceFor(f.support[0]!, nowMs) : 0), 0) / fluents.length
    : 0;

  const envelope: PerceptionEnvelope = {
    seq: store.currentSeq(),
    lens: lens.lensId,
    attention,
    changed: changedSummaries,
    guards: guardsMap,
    latest: {
      target: {
        ...(existsFluent && { exists: existsFluent.value as boolean }),
        ...(titleFluent && { title: titleFluent.value as string }),
        ...(rectFluent && { rect: rectFluent.value as PerceptionEnvelope["latest"]["target"] extends undefined ? never : NonNullable<PerceptionEnvelope["latest"]["target"]>["rect"] }),
        ...(fgFluent && { foreground: fgFluent.value as boolean }),
        ...(zOrderFluent && { zOrder: zOrderFluent.value as number }),
        ...(modalFluent && { modalAbove: modalFluent.value as boolean }),
        confidence: Math.round(avgConf * 100) / 100,
      },
    },
  };

  // Token-budget trimming: drop fields in priority order until within budget
  if (estimateTokens(envelope) > maxTokens) {
    // 1. Drop evidence from support arrays (already not in envelope)
    // 2. Trim changed summaries to most recent
    while (changedSummaries.length > 1 && estimateTokens(envelope) > maxTokens) {
      changedSummaries.shift();
    }
    // 3. Drop optional latest fields
    if (estimateTokens(envelope) > maxTokens && envelope.latest.target) {
      delete envelope.latest.target.zOrder;
    }
    if (estimateTokens(envelope) > maxTokens && envelope.latest.target) {
      delete envelope.latest.target.modalAbove;
    }
    if (estimateTokens(envelope) > maxTokens && envelope.latest.target) {
      delete envelope.latest.target.rect;
    }
  }

  return envelope;
}
