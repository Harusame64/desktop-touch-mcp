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
  PerceptionLens,
} from "./types.js";
import { DirtyJournal } from "./dirty-journal.js";
import { FluentStore } from "./fluent-store.js";
import { DependencyGraph } from "./dependency-graph.js";
import {
  compileLens,
  resolveBindingFromSnapshot,
  resolveBrowserTabBindingFromTabs,
  buildBrowserTabIdentity,
  resetLensCounter,
} from "./lens.js";
import { evaluateGuards } from "./guards.js";
import type { GuardContext } from "./guards.js";
import { projectEnvelope } from "./envelope.js";
import {
  refreshWin32Fluents,
  buildWindowIdentity,
  startSensorLoop,
  __resetSensorForTests,
} from "./sensors-win32.js";
import {
  refreshUiaFluents,
  startUiaSensorLoop,
  __resetUiaSensorForTests,
} from "./sensors-uia.js";
import {
  refreshCdpFluents,
  startCdpSensorLoop,
  __resetCdpSensorForTests,
} from "./sensors-cdp.js";
import { listTabsLight } from "../cdp-bridge.js";
import { enumWindowsInZOrder } from "../win32.js";

const MAX_LENSES = 16;

const store  = new FluentStore();
const graph  = new DependencyGraph();
const _journal = new DirtyJournal();
const lenses = new Map<string, PerceptionLens>();
/** Insertion order for FIFO eviction */
const lensOrder: string[] = [];

let _disposeSensorLoop: (() => void) | null = null;
let _disposeUiaLoop: (() => void) | null = null;
let _disposeCdpLoop: (() => void) | null = null;
const _recentChanges = new Map<string, Set<string>>(); // lensId → changed keys since last read

function ensureSensorLoop(): void {
  const allLenses = [...lenses.values()];
  const windowLenses = allLenses.filter(l => l.spec.target.kind === "window");
  const browserTabLenses = allLenses.filter(l => l.spec.target.kind === "browserTab");

  if (windowLenses.length > 0 && !_disposeSensorLoop) {
    _disposeSensorLoop = startSensorLoop(
      () => windowLenses.map(l => ({
        hwnd: l.binding.hwnd,
        titleKey: l.spec.target.kind === "window" ? l.spec.target.match.titleIncludes : "",
      })),
      (_hwnd, _titleKey, obs) => ingestObservations(obs)
    );
  }

  const hasCritical = allLenses.some(l => l.spec.salience === "critical" && l.spec.target.kind === "window");
  if (hasCritical && !_disposeUiaLoop) {
    _disposeUiaLoop = startUiaSensorLoop(
      () => allLenses
        .filter(l => l.spec.salience === "critical" && l.spec.target.kind === "window")
        .map(l => ({ hwnd: l.binding.hwnd })),
      (_hwnd, obs) => ingestObservations(obs)
    );
  }

  if (browserTabLenses.length > 0 && !_disposeCdpLoop) {
    _disposeCdpLoop = startCdpSensorLoop(
      () => browserTabLenses.map(l => ({ tabId: l.binding.hwnd, port: 9222 })),
      (_tabId, obs) => ingestObservations(obs)
    );
  }
}

function stopSensorLoopIfEmpty(): void {
  const allLenses = [...lenses.values()];
  if (lenses.size === 0) {
    if (_disposeSensorLoop) { _disposeSensorLoop(); _disposeSensorLoop = null; }
    if (_disposeUiaLoop)    { _disposeUiaLoop();    _disposeUiaLoop = null;    }
    if (_disposeCdpLoop)    { _disposeCdpLoop();    _disposeCdpLoop = null;    }
    return;
  }
  // Stop Win32 loop if no window lenses remain
  const hasWindow = allLenses.some(l => l.spec.target.kind === "window");
  if (!hasWindow && _disposeSensorLoop) { _disposeSensorLoop(); _disposeSensorLoop = null; }

  // Stop UIA loop if no critical window lenses remain
  const hasCritical = allLenses.some(l => l.spec.salience === "critical" && l.spec.target.kind === "window");
  if (!hasCritical && _disposeUiaLoop) { _disposeUiaLoop(); _disposeUiaLoop = null; }

  // Stop CDP loop if no browserTab lenses remain
  const hasBrowserTab = allLenses.some(l => l.spec.target.kind === "browserTab");
  if (!hasBrowserTab && _disposeCdpLoop) { _disposeCdpLoop(); _disposeCdpLoop = null; }
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

  if (spec.target.kind === "browserTab") {
    return _registerBrowserTabLens(spec);
  }
  return _registerWindowLens(spec);
}

function _registerWindowLens(spec: LensSpec): { lensId: string; seq: number; digest: string } {
  // Resolve binding from live window list
  const windows = enumWindowsInZOrder().map(w => ({
    hwnd: String(w.hwnd),
    title: w.title,
    zOrder: w.zOrder,
    isActive: w.isActive,
  }));
  const binding = resolveBindingFromSnapshot(spec, windows);
  if (!binding) {
    const needle = spec.target.kind === "window" ? spec.target.match.titleIncludes : "";
    throw new Error(`Window not found matching titleIncludes: "${needle}"`);
  }

  const identity = buildWindowIdentity(binding.hwnd);
  if (!identity) {
    throw new Error(`Could not read identity for window "${binding.windowTitle}" (hwnd ${binding.hwnd})`);
  }
  identity.titleResolved = binding.windowTitle;

  const lens = compileLens(spec, binding, identity, store.currentSeq());

  // Initial eager refresh (Win32)
  const initialObs = refreshWin32Fluents(binding.hwnd, spec.target.kind === "window" ? spec.target.match.titleIncludes : "");
  ingestObservations(initialObs);

  graph.addLens(lens.lensId, lens.fluentKeys);
  lenses.set(lens.lensId, lens);
  lensOrder.push(lens.lensId);

  ensureSensorLoop();

  // Fire-and-forget UIA refresh for critical lenses
  if (spec.salience === "critical") {
    refreshUiaFluents(binding.hwnd, "critical", true)
      .then(obs => ingestObservations(obs))
      .catch(() => { /* non-fatal */ });
  }

  return {
    lensId: lens.lensId,
    seq: store.currentSeq(),
    digest: `${lens.lensId}@${store.currentSeq()}`,
  };
}

function _registerBrowserTabLens(spec: LensSpec): { lensId: string; seq: number; digest: string } {
  // Note: registerLens is sync; we throw synchronously if tabs can't be listed.
  // Callers that need async registration should await listTabsLight separately.
  throw new Error(
    "browserTab lenses require async registration. Use registerLensAsync() instead of registerLens()."
  );
}

/**
 * Async variant of registerLens — required for browserTab lenses (CDP is async).
 * Falls through to sync path for window lenses.
 */
export async function registerLensAsync(spec: LensSpec): Promise<{ lensId: string; seq: number; digest: string }> {
  if (spec.target.kind !== "browserTab") {
    return registerLens(spec);
  }

  evictOldestIfNeeded();

  const tabs = await listTabsLight();
  const binding = resolveBrowserTabBindingFromTabs(spec, tabs);
  if (!binding) {
    const m = spec.target.match;
    const desc = m.urlIncludes ? `urlIncludes:"${m.urlIncludes}"` : `titleIncludes:"${m.titleIncludes}"`;
    throw new Error(`Browser tab not found matching ${desc}. Is Chrome running with --remote-debugging-port=9222?`);
  }

  // Find the matched tab data for identity building
  const matchedTab = tabs.find(t => t.id === binding.hwnd)!;
  const identity = buildBrowserTabIdentity(matchedTab.id, matchedTab.title, matchedTab.url, 9222);

  const lens = compileLens(spec, binding, identity, store.currentSeq());

  // Initial eager refresh (CDP)
  refreshCdpFluents(binding.hwnd, 9222)
    .then(obs => ingestObservations(obs))
    .catch(() => { /* non-fatal */ });

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
    target: `${l.spec.target.kind}:${l.binding.hwnd} (${l.binding.windowTitle})`,
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

  // Force a quick sensor refresh before guard eval
  if (lens.spec.target.kind === "window") {
    const obs = refreshWin32Fluents(
      lens.binding.hwnd,
      lens.spec.target.match.titleIncludes
    );
    ingestObservations(obs);
  }
  // For browserTab: guard uses the last cached fluents (CDP is async; pre-tool refresh not done here)

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

export async function readLens(
  lensId: string,
  opts: { maxTokens?: number } = {}
): Promise<PerceptionEnvelope> {
  const lens = lenses.get(lensId);
  if (!lens) throw new Error(`Lens not found: ${lensId}`);

  if (lens.spec.target.kind === "browserTab") {
    // CDP refresh — force fetch latest state
    const cdpObs = await refreshCdpFluents(lens.binding.hwnd, 9222);
    ingestObservations(cdpObs);
  } else {
    // Win32 refresh
    const obs = refreshWin32Fluents(
      lens.binding.hwnd,
      lens.spec.target.match.titleIncludes
    );
    ingestObservations(obs);

    // For critical window lenses, force-refresh UIA focused-element
    if (lens.spec.salience === "critical") {
      const uiaObs = await refreshUiaFluents(lens.binding.hwnd, "critical", true);
      ingestObservations(uiaObs);
    }
  }

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
  if (_disposeUiaLoop)    { _disposeUiaLoop();    _disposeUiaLoop = null;    }
  if (_disposeCdpLoop)    { _disposeCdpLoop();    _disposeCdpLoop = null;    }
  store.__resetForTests();
  graph.__resetForTests();
  _journal.__resetForTests();
  __resetSensorForTests();
  __resetUiaSensorForTests();
  __resetCdpSensorForTests();
  resetLensCounter();
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors for resource model and tests
// ─────────────────────────────────────────────────────────────────────────────

export function getStore(): FluentStore { return store; }
export function getDirtyJournal(): DirtyJournal { return _journal; }
export function getLens(lensId: string): PerceptionLens | undefined { return lenses.get(lensId); }
export function getAllLenses(): PerceptionLens[] { return [...lenses.values()]; }
