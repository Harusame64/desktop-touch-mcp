/**
 * Perception Registry — central coordinator for the Reactive Perception Graph.
 *
 * Module-global singleton: one FluentStore, one DependencyGraph, one registry Map.
 * Max 16 active lenses (LRU eviction).
 */

import type {
  GuardEvalResult,
  LensSummary,
  LensSpec,
  Observation,
  PerceptionEnvelope,
} from "./types.js";
import { FluentStore } from "./fluent-store.js";
import { DependencyGraph } from "./dependency-graph.js";
import {
  compileLens,
  resolveBindingFromSnapshot,
  resetLensCounter,
} from "./lens.js";
import type { PerceptionLens } from "./types.js";
import { evaluateGuards } from "./guards.js";
import type { GuardContext } from "./guards.js";
import { projectEnvelope } from "./envelope.js";
import {
  refreshWin32Fluents,
  buildWindowIdentity,
  startSensorLoop,
  __resetSensorForTests,
} from "./sensors-win32.js";
import { enumWindowsInZOrder } from "../win32.js";

const MAX_LENSES = 16;

const store = new FluentStore();
const graph = new DependencyGraph();
const lenses = new Map<string, PerceptionLens>();
/** Insertion order for LRU eviction */
const lensOrder: string[] = [];

let _disposeSensorLoop: (() => void) | null = null;
const _recentChanges = new Map<string, Set<string>>(); // lensId → changed keys since last read

function ensureSensorLoop(): void {
  if (_disposeSensorLoop) return;
  _disposeSensorLoop = startSensorLoop(
    () => [...lenses.values()].map(l => ({ hwnd: l.binding.hwnd, titleKey: l.spec.target.match.titleIncludes })),
    (_hwnd, _titleKey, obs) => ingestObservations(obs)
  );
}

function stopSensorLoopIfEmpty(): void {
  if (lenses.size === 0 && _disposeSensorLoop) {
    _disposeSensorLoop();
    _disposeSensorLoop = null;
  }
}

function evictOldestIfNeeded(): void {
  while (lensOrder.length >= MAX_LENSES) {
    const oldest = lensOrder.shift()!;
    graph.removeLens(oldest);
    lenses.delete(oldest);
    _recentChanges.delete(oldest);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core ingest pipeline
// ─────────────────────────────────────────────────────────────────────────────

function ingestObservations(obs: Observation[]): void {
  if (obs.length === 0) return;
  const { changed } = store.apply(obs);
  if (changed.size === 0) return;

  // Mark-dirty propagation
  store.markDirty([...changed]);

  // Track changes per lens for envelope projection
  const affectedLenses = graph.lookupAffectedLenses(changed);
  for (const lensId of affectedLenses) {
    let lensChanges = _recentChanges.get(lensId);
    if (!lensChanges) { lensChanges = new Set(); _recentChanges.set(lensId, lensChanges); }
    for (const k of changed) { if (graph.fluentsForLens(lensId).includes(k)) lensChanges.add(k); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: register a lens
// ─────────────────────────────────────────────────────────────────────────────

export function registerLens(spec: LensSpec): { lensId: string; seq: number; digest: string } {
  evictOldestIfNeeded();

  // Resolve binding from live window list
  const windows = enumWindowsInZOrder().map(w => ({
    hwnd: String(w.hwnd),
    title: w.title,
    zOrder: w.zOrder,
    isActive: w.isActive,
  }));
  const binding = resolveBindingFromSnapshot(spec, windows);
  if (!binding) {
    throw new Error(`Window not found matching titleIncludes: "${spec.target.match.titleIncludes}"`);
  }

  const identity = buildWindowIdentity(binding.hwnd);
  if (!identity) {
    throw new Error(`Could not read identity for window "${binding.windowTitle}" (hwnd ${binding.hwnd})`);
  }
  identity.titleResolved = binding.windowTitle;

  const lens = compileLens(spec, binding, identity, store.currentSeq());

  // Initial eager refresh
  const initialObs = refreshWin32Fluents(binding.hwnd, spec.target.match.titleIncludes);
  ingestObservations(initialObs);

  // Wire dep graph
  graph.addLens(lens.lensId, lens.fluentKeys);
  lenses.set(lens.lensId, lens);
  lensOrder.push(lens.lensId);

  ensureSensorLoop();

  return {
    lensId: lens.lensId,
    seq: store.currentSeq(),
    digest: `${lens.lensId}@${store.currentSeq()}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: forget a lens
// ─────────────────────────────────────────────────────────────────────────────

export function forgetLens(lensId: string): boolean {
  if (!lenses.has(lensId)) return false;
  graph.removeLens(lensId);
  lenses.delete(lensId);
  _recentChanges.delete(lensId);
  const idx = lensOrder.indexOf(lensId);
  if (idx >= 0) lensOrder.splice(idx, 1);
  stopSensorLoopIfEmpty();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: list active lenses
// ─────────────────────────────────────────────────────────────────────────────

export function listLenses(): LensSummary[] {
  return [...lenses.values()].map(l => ({
    lensId: l.lensId,
    name: l.spec.name,
    target: `window:${l.binding.hwnd} (${l.binding.windowTitle})`,
    guardPolicy: l.spec.guardPolicy,
    salience: l.spec.salience,
    fluentCount: l.fluentKeys.length,
    registeredAtMs: l.registeredAtMs,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: evaluate guards before a tool action
// ─────────────────────────────────────────────────────────────────────────────

export function evaluatePreToolGuards(
  lensId: string,
  toolName: string,
  args: unknown
): GuardEvalResult {
  const lens = lenses.get(lensId);
  if (!lens) throw new Error(`Lens not found: ${lensId}`);

  // Force a quick Win32 refresh for critical fluents before guard eval
  const obs = refreshWin32Fluents(lens.binding.hwnd, lens.spec.target.match.titleIncludes);
  ingestObservations(obs);

  const ctx: GuardContext = {};
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a["x"] === "number") ctx.clickX = a["x"] as number;
    if (typeof a["y"] === "number") ctx.clickY = a["y"] as number;
    if (typeof a["clickAt"] === "object" && a["clickAt"]) {
      const ca = a["clickAt"] as Record<string, unknown>;
      if (typeof ca["x"] === "number") ctx.clickX = ca["x"] as number;
      if (typeof ca["y"] === "number") ctx.clickY = ca["y"] as number;
    }
    ctx.toolName = toolName;
  }

  return evaluateGuards(lens, store, lens.spec.guardPolicy, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: build a perception envelope for a tool response
// ─────────────────────────────────────────────────────────────────────────────

export function buildEnvelopeFor(
  lensId: string,
  opts: { toolName?: string; args?: unknown } = {}
): PerceptionEnvelope | null {
  const lens = lenses.get(lensId);
  if (!lens) return null;

  const ctx: GuardContext = {};
  if (opts.args && typeof opts.args === "object") {
    const a = opts.args as Record<string, unknown>;
    if (typeof a["x"] === "number") ctx.clickX = a["x"] as number;
    if (typeof a["y"] === "number") ctx.clickY = a["y"] as number;
  }

  const guardResult = evaluateGuards(lens, store, lens.spec.guardPolicy, ctx);
  const changedKeys = _recentChanges.get(lensId) ?? new Set<string>();

  const envelope = projectEnvelope(lens, store, guardResult, {
    maxTokens: lens.spec.maxEnvelopeTokens,
    changedKeys,
  });

  // Consume the change set (next call starts fresh)
  _recentChanges.delete(lensId);

  return envelope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: explicit read (refresh then return envelope)
// ─────────────────────────────────────────────────────────────────────────────

export function readLens(
  lensId: string,
  opts: { maxTokens?: number } = {}
): PerceptionEnvelope {
  const lens = lenses.get(lensId);
  if (!lens) throw new Error(`Lens not found: ${lensId}`);

  const obs = refreshWin32Fluents(lens.binding.hwnd, lens.spec.target.match.titleIncludes);
  ingestObservations(obs);

  const changedKeys = _recentChanges.get(lensId) ?? new Set<string>();
  const guardResult = evaluateGuards(lens, store, lens.spec.guardPolicy);
  const envelope = projectEnvelope(lens, store, guardResult, {
    maxTokens: opts.maxTokens ?? lens.spec.maxEnvelopeTokens,
    changedKeys,
  });
  _recentChanges.delete(lensId);
  return envelope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset — tests only
// ─────────────────────────────────────────────────────────────────────────────

export function __resetForTests(): void {
  lenses.clear();
  lensOrder.length = 0;
  _recentChanges.clear();
  if (_disposeSensorLoop) { _disposeSensorLoop(); _disposeSensorLoop = null; }
  store.__resetForTests();
  graph.__resetForTests();
  __resetSensorForTests();
  resetLensCounter();
}
