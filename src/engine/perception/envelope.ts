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
  hasDirty: boolean,
  hasSettling: boolean,
  hasStale: boolean
): AttentionState {
  if (!guardResult.ok) return "guard_failed";
  if (hasDirty) return "dirty";
  if (hasSettling) return "settling";
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
  const entityId = lens.binding.hwnd;
  const entityKind = lens.spec.target.kind;

  function read(property: string) {
    return store.read(`${entityKind}:${entityId}.${property}`);
  }

  // Build changed summaries (coalesced)
  const changedSummaries: string[] = [];
  for (const key of changedKeys) {
    const prop = key.split(".").slice(1).join(".");
    if (prop === "target.identity") continue; // verbose, skip
    const fluent = store.read(key);
    changedSummaries.push(describeChange(key, fluent));
  }

  // Guards summary
  const guardsMap: Record<string, boolean> = {};
  for (const r of guardResult.results) {
    guardsMap[r.kind] = r.ok;
  }

  const envelope: PerceptionEnvelope = {
    seq: store.currentSeq(),
    lens: lens.lensId,
    attention: "ok",
    changed: changedSummaries,
    guards: guardsMap,
    latest: {},
  };

  if (entityKind === "browserTab") {
    // ── browserTab block ──────────────────────────────────────────────────────
    const urlFluent       = read("browser.url");
    const bTitleFluent    = read("browser.title");
    const readyStateFluent = read("browser.readyState");

    const bFluentsAll = [urlFluent, bTitleFluent, readyStateFluent];
    const hasDirty    = bFluentsAll.some(f => f?.status === "dirty");
    const hasSettling = bFluentsAll.some(f => f?.status === "settling");
    const hasStale    = bFluentsAll.some(f => f?.status === "stale");
    envelope.attention = deriveAttention(guardResult, changedKeys, hasDirty, hasSettling, hasStale);

    const bFluents = bFluentsAll.filter(Boolean);
    const avgConf = bFluents.length > 0
      ? bFluents.reduce((s, f) => s + (f?.support[0] ? confidenceFor(f.support[0], nowMs) : f?.confidence ?? 0), 0) / bFluents.length
      : 0;

    envelope.latest.browser = {
      ...(urlFluent       && { url:        urlFluent.value as string }),
      ...(bTitleFluent    && { title:      bTitleFluent.value as string }),
      ...(readyStateFluent && { readyState: readyStateFluent.value as string }),
      confidence: Math.round(avgConf * 100) / 100,
    };
  } else {
    // ── window block ──────────────────────────────────────────────────────────
    const existsFluent  = read("target.exists");
    const titleFluent   = read("target.title");
    const rectFluent    = read("target.rect");
    const fgFluent      = read("target.foreground");
    const zOrderFluent  = read("target.zOrder");
    const modalFluent   = read("modal.above");
    const feFluent      = read("target.focusedElement");

    const windowFluentsAll = [existsFluent, titleFluent, rectFluent, fgFluent, modalFluent];
    const hasDirty    = windowFluentsAll.some(f => f?.status === "dirty");
    const hasSettling = windowFluentsAll.some(f => f?.status === "settling");
    const hasStale    = windowFluentsAll.some(f => f?.status === "stale");
    envelope.attention = deriveAttention(guardResult, changedKeys, hasDirty, hasSettling, hasStale);

    const fluents = [existsFluent, titleFluent, rectFluent, fgFluent, zOrderFluent, modalFluent, feFluent].filter(Boolean);
    const avgConf = fluents.length > 0
      ? fluents.reduce((s, f) => s + (f?.support[0] ? confidenceFor(f.support[0], nowMs) : f?.confidence ?? 0), 0) / fluents.length
      : 0;

    type RectType = NonNullable<NonNullable<PerceptionEnvelope["latest"]["target"]>["rect"]>;
    envelope.latest.target = {
      ...(existsFluent && { exists: existsFluent.value as boolean }),
      ...(titleFluent && { title: titleFluent.value as string }),
      ...(rectFluent && { rect: rectFluent.value as RectType }),
      ...(fgFluent && { foreground: fgFluent.value as boolean }),
      ...(zOrderFluent && { zOrder: zOrderFluent.value as number }),
      ...(modalFluent && { modalAbove: modalFluent.value as boolean }),
      ...(feFluent && { focusedElement: feFluent.value as { name: string; controlType: string; automationId?: string; value?: string } | null }),
      confidence: Math.round(avgConf * 100) / 100,
    };

    // Token-budget trimming: drop optional window fields in ascending importance order
    if (estimateTokens(envelope) > maxTokens) {
      while (changedSummaries.length > 1 && estimateTokens(envelope) > maxTokens) {
        changedSummaries.shift();
      }
      if (estimateTokens(envelope) > maxTokens && envelope.latest.target) {
        delete envelope.latest.target.zOrder;
      }
      if (estimateTokens(envelope) > maxTokens && envelope.latest.target) {
        delete envelope.latest.target.focusedElement;
      }
      if (estimateTokens(envelope) > maxTokens && envelope.latest.target) {
        delete envelope.latest.target.modalAbove;
      }
      if (estimateTokens(envelope) > maxTokens && envelope.latest.target) {
        delete envelope.latest.target.rect;
      }
    }
  }

  return envelope;
}
