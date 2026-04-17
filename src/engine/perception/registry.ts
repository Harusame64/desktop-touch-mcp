/**
 * Perception Registry — central coordinator for the Reactive Perception Graph.
 *
 * Module-global singleton: one FluentStore, one DependencyGraph, one registry Map.
 * Max 16 active lenses (LRU eviction).
 *
 * v0.11.0: Phase 5/6 fully integrated.
 *   - LensEventIndex stays in sync with lens lifecycle (register/forget/evict/reset).
 *   - Lifecycle listeners allow resource registry and notification scheduler to hook in.
 *   - Sensor loop callbacks read lenses dynamically (no stale closure).
 *   - Native WinEvent sidecar pipeline: raw events → dirty journal/store → flush → refresh.
 *   - ReconciliationScheduler for overflow recovery and periodic 5s sweep.
 *   - Perception change listeners drive resource notification debouncing.
 */

import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import { appendEvent, deriveLensTargetKey } from "./target-timeline.js";
import type { TimelineSemantic } from "./target-timeline.js";
import type {
  AttentionState,
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
import {
  createLensEventIndex,
  addLensToIndex,
  removeLensFromIndex,
} from "./lens-event-index.js";
import type { LensEventIndex } from "./lens-event-index.js";
import { RawEventQueue } from "./raw-event-queue.js";
import type { RawEventQueueDiagnostics } from "./raw-event-queue.js";
import { NativeSensorBridge } from "./sensors-native-win32.js";
import { FlushScheduler } from "./flush-scheduler.js";
import { ReconciliationScheduler } from "./reconciliation.js";
import { buildRefreshPlan } from "./refresh-plan.js";
import { WinEventSource } from "../winevent-source.js";
import type { WinEventSourceDiagnostics } from "../winevent-source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LENSES = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Module-global state — perception core
// ─────────────────────────────────────────────────────────────────────────────

const store    = new FluentStore();
const graph    = new DependencyGraph();
const _journal = new DirtyJournal();
const lenses   = new Map<string, PerceptionLens>();
/** Insertion order for FIFO eviction */
const lensOrder: string[] = [];

let _lensEventIndex: LensEventIndex = createLensEventIndex();

let _disposeSensorLoop: (() => void) | null = null;
let _disposeUiaLoop: (() => void) | null = null;
let _disposeCdpLoop: (() => void) | null = null;
const _recentChanges = new Map<string, Set<string>>(); // lensId → changed keys since last read

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle listeners
// ─────────────────────────────────────────────────────────────────────────────

export type LensRemovalReason = "forget" | "evict" | "reset";

export interface LensLifecycleListener {
  onRegistered?(lens: PerceptionLens): void;
  onForgotten?(lensId: string, reason: LensRemovalReason): void;
}

const lifecycleListeners = new Set<LensLifecycleListener>();

/**
 * Subscribe to lens register/forget events.
 * The listener immediately receives onRegistered() for all currently-active lenses.
 * Returns an unsubscribe function.
 */
export function addLensLifecycleListener(listener: LensLifecycleListener): () => void {
  lifecycleListeners.add(listener);
  // Replay existing lenses so listeners don't miss state registered before they subscribed.
  for (const lens of lenses.values()) {
    safeCallLifecycle(() => listener.onRegistered?.(lens));
  }
  return () => lifecycleListeners.delete(listener);
}

function notifyLensRegistered(lens: PerceptionLens): void {
  for (const l of lifecycleListeners) safeCallLifecycle(() => l.onRegistered?.(lens));
}

function notifyLensForgotten(lensId: string, reason: LensRemovalReason): void {
  for (const l of lifecycleListeners) safeCallLifecycle(() => l.onForgotten?.(lensId, reason));
}

function safeCallLifecycle(cb: () => void): void {
  try { cb(); } catch (err) { console.error("[perception] lifecycle listener error", err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Perception change listeners (for resource notification scheduling)
// ─────────────────────────────────────────────────────────────────────────────

export interface PerceptionChangeListener {
  onChanged(lensIds: Set<string>): void;
}

const changeListeners = new Set<PerceptionChangeListener>();

export function addPerceptionChangeListener(listener: PerceptionChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyChangeListeners(lensIds: Set<string>): void {
  if (lensIds.size === 0 || changeListeners.size === 0) return;
  for (const l of changeListeners) {
    try { l.onChanged(lensIds); } catch (err) { console.error("[perception] change listener error", err); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Native WinEvent runtime state
// ─────────────────────────────────────────────────────────────────────────────

let _rawQueue: RawEventQueue | null = null;
let _nativeBridge: NativeSensorBridge | null = null;
let _flushScheduler: FlushScheduler | null = null;
let _reconciler: ReconciliationScheduler | null = null;
let _winEventSource: WinEventSource | null = null;
let _nativeDrainTimer: ReturnType<typeof setInterval> | null = null;

function defaultSidecarPath(): string {
  const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
  return nodePath.join(__dirname, "..", "..", "..", "bin", "dt-winevent-sidecar.exe");
}

function nativeEventsEnabled(): boolean {
  if (process.platform !== "win32") return false;
  if (process.env.DESKTOP_TOUCH_NATIVE_WINEVENTS === "0") return false;
  if (process.env.DESKTOP_TOUCH_NATIVE_WINEVENTS === "1") return true; // explicit opt-in
  // Auto-detect: only enable if the sidecar binary is present to avoid
  // noisy spawn failures and restart-backoff loops when it is not bundled.
  const sidecarPath = process.env.DESKTOP_TOUCH_SIDECAR_PATH ?? defaultSidecarPath();
  return existsSync(sidecarPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal lens removal (single path for forget + evict + reset)
// ─────────────────────────────────────────────────────────────────────────────

function removeLensInternal(lensId: string, reason: LensRemovalReason): boolean {
  const lens = lenses.get(lensId);
  if (!lens) return false;

  graph.removeLens(lensId);
  removeLensFromIndex(_lensEventIndex, lens);
  lenses.delete(lensId);
  _recentChanges.delete(lensId);

  const idx = lensOrder.indexOf(lensId);
  if (idx >= 0) lensOrder.splice(idx, 1);

  // D-3: emit target_closed timeline event
  const targetKey = deriveLensTargetKey(lens);
  appendEvent({
    targetKey,
    identity: lens.boundIdentity,
    source: "manual_lens",
    semantic: "target_closed",
    result: reason === "evict" ? "failed" : "ok",
    summary: `Lens ${reason}: ${targetKey}`,
  });
  // Clean up prev-fluent cache for this lens
  for (const key of [..._prevFluentValues.keys()]) {
    if (key.startsWith(`${lensId}:`)) _prevFluentValues.delete(key);
  }

  notifyLensForgotten(lensId, reason);
  stopSensorLoopIfEmpty();
  stopNativeRuntimeIfIdle();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sensor loop management
// ─────────────────────────────────────────────────────────────────────────────

function ensureSensorLoop(): void {
  // F3: callbacks capture lenses.values() dynamically — no stale closure.
  const hasWindow = [...lenses.values()].some(l => l.spec.target.kind === "window");
  const hasCritical = [...lenses.values()].some(
    l => l.spec.salience === "critical" && l.spec.target.kind === "window"
  );
  const hasBrowserTab = [...lenses.values()].some(l => l.spec.target.kind === "browserTab");

  if (hasWindow && !_disposeSensorLoop) {
    _disposeSensorLoop = startSensorLoop(
      () => [...lenses.values()]
        .filter(l => l.spec.target.kind === "window")
        .map(l => ({
          hwnd: l.binding.hwnd,
          titleKey: l.spec.target.kind === "window" ? l.spec.target.match.titleIncludes : "",
        })),
      (_hwnd, _titleKey, obs) => ingestObservations(obs)
    );
  }

  if (hasCritical && !_disposeUiaLoop) {
    _disposeUiaLoop = startUiaSensorLoop(
      () => [...lenses.values()]
        .filter(l => l.spec.salience === "critical" && l.spec.target.kind === "window")
        .map(l => ({ hwnd: l.binding.hwnd })),
      (_hwnd, obs) => ingestObservations(obs)
    );
  }

  if (hasBrowserTab && !_disposeCdpLoop) {
    _disposeCdpLoop = startCdpSensorLoop(
      () => [...lenses.values()]
        .filter(l => l.spec.target.kind === "browserTab")
        .map(l => ({ tabId: l.binding.hwnd, port: 9222 })),
      (_tabId, obs) => ingestObservations(obs)
    );
  }
}

function stopSensorLoopIfEmpty(): void {
  if (lenses.size === 0) {
    if (_disposeSensorLoop) { _disposeSensorLoop(); _disposeSensorLoop = null; }
    if (_disposeUiaLoop)    { _disposeUiaLoop();    _disposeUiaLoop = null;    }
    if (_disposeCdpLoop)    { _disposeCdpLoop();    _disposeCdpLoop = null;    }
    return;
  }
  const hasWindow   = [...lenses.values()].some(l => l.spec.target.kind === "window");
  const hasCritical = [...lenses.values()].some(
    l => l.spec.salience === "critical" && l.spec.target.kind === "window"
  );
  const hasBrowserTab = [...lenses.values()].some(l => l.spec.target.kind === "browserTab");

  if (!hasWindow   && _disposeSensorLoop) { _disposeSensorLoop(); _disposeSensorLoop = null; }
  if (!hasCritical && _disposeUiaLoop)    { _disposeUiaLoop();    _disposeUiaLoop = null;    }
  if (!hasBrowserTab && _disposeCdpLoop)  { _disposeCdpLoop();    _disposeCdpLoop = null;    }
}

function evictOldestIfNeeded(): void {
  while (lensOrder.length >= MAX_LENSES) {
    const oldest = lensOrder[0]; // peek; removeLensInternal will splice it
    removeLensInternal(oldest, "evict");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Native WinEvent runtime
// ─────────────────────────────────────────────────────────────────────────────

function ensureNativeEventRuntime(): void {
  if (!nativeEventsEnabled()) return;
  if (_winEventSource) return;
  if (![...lenses.values()].some(l => l.spec.target.kind === "window")) return;

  _rawQueue      = new RawEventQueue();
  _flushScheduler = new FlushScheduler({ onFlush: reason => flushDirty(reason) });

  _nativeBridge  = new NativeSensorBridge({
    onDirty:            markDirtyFromNativeEvent,
    onGlobalDirty:      markGlobalDirtyFromNativeEvent,
    onSchedule:         (cls, reason) => _flushScheduler?.schedule(cls, reason),
    onEnumWindowsNeeded: reason => _flushScheduler?.schedule("overflow", reason),
  });

  _reconciler = new ReconciliationScheduler(
    () => [...lenses.values()],
    () => _journal,
    () => _lensEventIndex,
    () => new Set(
      [...lenses.values()]
        .filter(l => l.spec.target.kind === "window")
        .map(l => l.binding.hwnd)
    ),
    { onReconcile: executeRefreshPlan }
  );
  _reconciler.start();

  _winEventSource = new WinEventSource({
    onRawEvent: (ev) => {
      // F1-fix: guard against null after stopNativeRuntime() races with buffered sidecar output.
      if (!_rawQueue || !_nativeBridge) return;
      _rawQueue.enqueue(ev);
      // Overflow is handled exclusively in the drain timer (drainNativeEventQueue).
      // Do NOT call processOverflow here to avoid double processing — the timer fires
      // every 50ms and will pick up the overflow flag on the next drain cycle.
    },
    onMalformedLine: (line) => {
      console.error(`[perception] Malformed sidecar line: ${line.slice(0, 200)}`);
    },
  });
  _winEventSource.start();

  _nativeDrainTimer = setInterval(drainNativeEventQueue, 50);
  if (_nativeDrainTimer.unref) _nativeDrainTimer.unref();
}

function stopNativeRuntimeIfIdle(): void {
  if (!_winEventSource) return;
  const hasWindowLenses = [...lenses.values()].some(l => l.spec.target.kind === "window");
  if (!hasWindowLenses) stopNativeRuntime();
}

/** Stop the native WinEvent runtime (called from server shutdown or when no window lenses remain). */
export function stopNativeRuntime(): void {
  if (_nativeDrainTimer) { clearInterval(_nativeDrainTimer); _nativeDrainTimer = null; }
  if (_reconciler)      { _reconciler.stop();   _reconciler = null;      }
  if (_flushScheduler)  { _flushScheduler.dispose(); _flushScheduler = null; }
  if (_winEventSource)  { _winEventSource.stop(); _winEventSource = null; }
  _nativeBridge = null;
  _rawQueue     = null;
}

function drainNativeEventQueue(): void {
  if (!_rawQueue || !_nativeBridge) return;
  // Read overflow flag BEFORE drain — drain() resets overflowPending to false,
  // so checking post-drain would always see false and skip overflow recovery.
  const overflowWasPending = _rawQueue.overflowPending;
  const batch = _rawQueue.drain();
  if (batch.length > 0) {
    _nativeBridge.processBatch(batch, _lensEventIndex, _journal);
  }
  if (overflowWasPending) {
    _nativeBridge.processOverflow(performance.now());
    _reconciler?.triggerImmediate();
  }
}

function markDirtyFromNativeEvent(
  entityKey: string,
  props: string[],
  cause: string,
  monoMs: number,
  severity?: "hint" | "structural" | "identityRisk"
): void {
  _journal.mark({ entityKey, props, cause, monoMs, severity });
  const fluentKeys = props.map(p => `${entityKey}.${p}`);
  store.markDirtyWithCause(fluentKeys, cause, monoMs);
  const affectedLensIds = graph.lookupAffectedLenses(new Set(fluentKeys));
  notifyChangeListeners(affectedLensIds);
}

function markGlobalDirtyFromNativeEvent(cause: string, monoMs: number): void {
  _journal.markGlobal(cause, monoMs);
  const allLensIds = new Set(lenses.keys());
  for (const lens of lenses.values()) {
    store.markDirtyWithCause(lens.fluentKeys, cause, monoMs);
  }
  notifyChangeListeners(allLensIds);
}

async function flushDirty(reason: string): Promise<void> {
  const allHwnds = new Set(
    [...lenses.values()]
      .filter(l => l.spec.target.kind === "window")
      .map(l => l.binding.hwnd)
  );
  const plan = buildRefreshPlan(_journal, _lensEventIndex, allHwnds);
  // F5-fix: derive trigger from journal global-dirty state so executeRefreshPlan
  // correctly calls _journal.clearGlobal() when the journal is globally dirty.
  const trigger: "sweep" | "overflow" = _journal.isGlobalDirty() ? "overflow" : "sweep";
  executeRefreshPlan({
    ...plan,
    reason: plan.reason.length ? plan.reason : [reason],
    trigger,
  });
}

function executeRefreshPlan(plan: {
  rectHwnds: Set<string>;
  identityHwnds: Set<string>;
  titleHwnds: Set<string>;
  needsEnumWindows: boolean;
  foreground: boolean;
  modalForLensIds: Set<string>;
  reason: string[];
  trigger: "sweep" | "overflow";
}): void {
  const hwnds = new Set<string>();
  for (const h of plan.rectHwnds)     hwnds.add(h);
  for (const h of plan.identityHwnds) hwnds.add(h);
  for (const h of plan.titleHwnds)    hwnds.add(h);

  if (plan.foreground || plan.needsEnumWindows) {
    for (const lens of lenses.values()) {
      if (lens.spec.target.kind === "window") hwnds.add(lens.binding.hwnd);
    }
  }

  for (const lensId of plan.modalForLensIds) {
    const lens = lenses.get(lensId);
    if (lens?.spec.target.kind === "window") hwnds.add(lens.binding.hwnd);
  }

  if (hwnds.size === 0) {
    if (plan.trigger === "overflow") _journal.clearGlobal();
    return;
  }

  const observations: Observation[] = [];
  for (const hwnd of hwnds) {
    const titleKey = findTitleKeyForHwnd(hwnd);
    observations.push(...refreshWin32Fluents(hwnd, titleKey));
  }

  if (observations.length > 0) {
    ingestObservations(observations);
  }

  // Clear dirty journal for refreshed entities — use current mono time (post-refresh)
  const clearMonoMs = performance.now();
  for (const hwnd of hwnds) {
    _journal.clearFor(`window:${hwnd}`, [
      "target.exists", "target.identity", "target.title",
      "target.rect", "target.zOrder", "target.foreground",
      "modal.above", "stable.rect",
    ], clearMonoMs);
  }

  if (plan.needsEnumWindows || plan.trigger === "overflow") {
    _journal.clearGlobal();
  }
}

function findTitleKeyForHwnd(hwnd: string): string {
  for (const lens of lenses.values()) {
    if (lens.binding.hwnd === hwnd && lens.spec.target.kind === "window") {
      return lens.spec.target.match.titleIncludes;
    }
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Core ingest pipeline
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// D-3: Timeline fluent-change emission (sensor-sourced events)
// ─────────────────────────────────────────────────────────────────────────────

/** micro-cache: "${lensId}:${fluentKey}" → last known value (for before/after comparison) */
const _prevFluentValues = new Map<string, unknown>();

function emitFluentChangeEvents(lensId: string, changedKeys: Set<string>): void {
  const lens = lenses.get(lensId);
  if (!lens) return;
  const targetKey = deriveLensTargetKey(lens);
  const identity  = lens.boundIdentity;
  for (const fk of changedKeys) {
    const prevCacheKey = `${lensId}:${fk}`;
    const prev = _prevFluentValues.get(prevCacheKey);
    const cur  = store.read(fk)?.value;
    _prevFluentValues.set(prevCacheKey, cur);

    // Derive timeline semantic from the last segment of the fluent key
    const suffix = fk.split(".").at(-1);
    let semantic: TimelineSemantic | null = null;
    let summary = "";
    switch (suffix) {
      case "title":
        semantic = "title_changed";
        summary  = `title → ${String(cur ?? "")}`;
        break;
      case "rect":
        semantic = "rect_changed";
        summary  = "rect changed";
        break;
      case "foreground":
        semantic = "foreground_changed";
        summary  = `foreground: ${String(prev ?? "")}→${String(cur ?? "")}`;
        break;
      case "identity":
        semantic = "identity_changed";
        summary  = "identity changed";
        break;
      case "url":
        semantic = "navigation";
        summary  = `url → ${String(cur ?? "")}`;
        break;
      case "above":
        if (fk.startsWith("modal.") || fk.includes(".modal.")) {
          if (!prev && cur)      { semantic = "modal_appeared";  summary = "modal appeared"; }
          else if (prev && !cur) { semantic = "modal_dismissed"; summary = "modal dismissed"; }
        }
        break;
    }
    if (semantic) {
      appendEvent({ targetKey, identity, source: "sensor", semantic, summary });
    }
  }
}

function ingestObservations(obs: Observation[]): void {
  if (obs.length === 0) return;
  const { changed } = store.apply(obs);
  if (changed.size === 0) return;

  // Track changes per lens for envelope projection
  const affectedLenses = graph.lookupAffectedLenses(changed);
  for (const lensId of affectedLenses) {
    let lensChanges = _recentChanges.get(lensId);
    if (!lensChanges) { lensChanges = new Set(); _recentChanges.set(lensId, lensChanges); }
    for (const k of changed) {
      if (graph.fluentsForLens(lensId).includes(k)) lensChanges.add(k);
    }
    // D-3: emit timeline events for sensor-detected fluent changes
    emitFluentChangeEvents(lensId, _recentChanges.get(lensId) ?? new Set());
  }

  // Notify resource/notification listeners
  notifyChangeListeners(affectedLenses);
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

  const initialObs = refreshWin32Fluents(binding.hwnd, spec.target.kind === "window" ? spec.target.match.titleIncludes : "");
  ingestObservations(initialObs);

  graph.addLens(lens.lensId, lens.fluentKeys);
  addLensToIndex(_lensEventIndex, lens);
  lenses.set(lens.lensId, lens);
  lensOrder.push(lens.lensId);

  notifyLensRegistered(lens);
  ensureSensorLoop();
  ensureNativeEventRuntime();

  // D-3: emit target_bound for manual lens registration
  appendEvent({ targetKey: deriveLensTargetKey(lens), identity: lens.boundIdentity, source: "manual_lens", semantic: "target_bound", summary: `Manual lens registered: ${lens.spec.name}` });

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

function _registerBrowserTabLens(_spec: LensSpec): { lensId: string; seq: number; digest: string } {
  throw new Error(
    "browserTab lenses require async registration. Use registerLensAsync() instead of registerLens()."
  );
}

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

  const matchedTab = tabs.find(t => t.id === binding.hwnd)!;
  const identity = buildBrowserTabIdentity(matchedTab.id, matchedTab.title, matchedTab.url, 9222);

  const lens = compileLens(spec, binding, identity, store.currentSeq());

  // Await initial CDP refresh so guard evaluation on the very next call sees
  // populated browser.readyState/url/title fluents instead of empty state.
  try {
    const obs = await refreshCdpFluents(binding.hwnd, 9222);
    ingestObservations(obs);
  } catch { /* non-fatal — lens is registered; guards will show stale until next read */ }

  graph.addLens(lens.lensId, lens.fluentKeys);
  addLensToIndex(_lensEventIndex, lens);
  lenses.set(lens.lensId, lens);
  lensOrder.push(lens.lensId);

  notifyLensRegistered(lens);
  ensureSensorLoop();

  // D-3: emit target_bound for manual browser tab lens registration
  appendEvent({ targetKey: deriveLensTargetKey(lens), identity: lens.boundIdentity, source: "manual_lens", semantic: "target_bound", summary: `Manual lens registered: ${lens.spec.name}` });

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
  return removeLensInternal(lensId, "forget");
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

export async function evaluatePreToolGuards(
  lensId: string,
  toolName: string,
  args: unknown
): Promise<GuardEvalResult> {
  const lens = lenses.get(lensId);
  if (!lens) throw new Error(`Lens not found: ${lensId}`);

  if (lens.spec.target.kind === "browserTab") {
    // Refresh CDP state before guard evaluation so browser.readyState/url are current.
    try {
      const obs = await refreshCdpFluents(lens.binding.hwnd, 9222);
      ingestObservations(obs);
    } catch { /* non-fatal — guards evaluate on whatever is in the store */ }
  } else {
    const obs = refreshWin32Fluents(
      lens.binding.hwnd,
      lens.spec.target.match.titleIncludes
    );
    ingestObservations(obs);
  }

  const ctx: GuardContext = { toolName };
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a["x"] === "number") ctx.clickX = a["x"] as number;
    if (typeof a["y"] === "number") ctx.clickY = a["y"] as number;
    if (typeof a["clickAt"] === "object" && a["clickAt"]) {
      const ca = a["clickAt"] as Record<string, unknown>;
      if (typeof ca["x"] === "number") ctx.clickX = ca["x"] as number;
      if (typeof ca["y"] === "number") ctx.clickY = ca["y"] as number;
    }
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
  const entityKey   = `${lens.spec.target.kind}:${lens.binding.hwnd}`;
  const hasJournalDirty = _journal.isGlobalDirty() || _journal.entries().has(entityKey);

  const envelope = projectEnvelope(lens, store, guardResult, {
    maxTokens: lens.spec.maxEnvelopeTokens,
    changedKeys,
    hasJournalDirty,
  });

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
    const cdpObs = await refreshCdpFluents(lens.binding.hwnd, 9222);
    ingestObservations(cdpObs);
  } else {
    const obs = refreshWin32Fluents(
      lens.binding.hwnd,
      lens.spec.target.match.titleIncludes
    );
    ingestObservations(obs);

    if (lens.spec.salience === "critical") {
      const uiaObs = await refreshUiaFluents(lens.binding.hwnd, "critical", true);
      ingestObservations(uiaObs);
    }
  }

  const changedKeys = _recentChanges.get(lensId) ?? new Set<string>();
  const guardResult = evaluateGuards(lens, store, lens.spec.guardPolicy);
  const entityKey   = `${lens.spec.target.kind}:${lens.binding.hwnd}`;
  const hasJournalDirty = _journal.isGlobalDirty() || _journal.entries().has(entityKey);
  const envelope = projectEnvelope(lens, store, guardResult, {
    maxTokens: opts.maxTokens ?? lens.spec.maxEnvelopeTokens,
    changedKeys,
    hasJournalDirty,
  });
  _recentChanges.delete(lensId);
  return envelope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset — tests only
// ─────────────────────────────────────────────────────────────────────────────

export function __resetForTests(): void {
  // Stop native runtime first
  stopNativeRuntime();
  // Notify listeners of all lens removals before clearing
  for (const lensId of [...lenses.keys()]) {
    notifyLensForgotten(lensId, "reset");
  }
  lenses.clear();
  lensOrder.length = 0;
  _recentChanges.clear();
  _lensEventIndex = createLensEventIndex();
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
  // Lifecycle and change listeners are cleared here so tests with addLensLifecycleListener
  // calls don't accumulate stale listeners across test files. Tests that need listeners
  // must re-register them after __resetForTests().
  lifecycleListeners.clear();
  changeListeners.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors — resource model, tests, and diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export function getStore(): FluentStore { return store; }
export function getDirtyJournal(): DirtyJournal { return _journal; }
export function getLens(lensId: string): PerceptionLens | undefined { return lenses.get(lensId); }
export function getAllLenses(): PerceptionLens[] { return [...lenses.values()]; }
export function getLensEventIndex(): LensEventIndex { return _lensEventIndex; }

/**
 * Derive current attention state for a lens without forcing a sensor refresh.
 * Used by ResourceNotificationScheduler to detect attention transitions.
 */
export function getLensAttention(lensId: string): AttentionState | undefined {
  const lens = lenses.get(lensId);
  if (!lens) return undefined;
  const guardResult = evaluateGuards(lens, store, lens.spec.guardPolicy ?? "block");
  if (!guardResult.ok) return "guard_failed";
  let hasDirty = false;
  let hasSettling = false;
  let hasStale = false;
  for (const key of lens.fluentKeys) {
    const f = store.read(key);
    if (!f) continue;
    if (f.status === "dirty")    { hasDirty    = true; break; }
    if (f.status === "settling") hasSettling = true;
    if (f.status === "stale")    hasStale    = true;
  }
  if (hasDirty)    return "dirty";
  if (hasSettling) return "settling";
  if (hasStale)    return "stale";
  return "ok";
}

// ── Native diagnostics ────────────────────────────────────────────────────────

export interface NativePerceptionDiagnostics {
  enabled: boolean;
  source: WinEventSourceDiagnostics | { state: "disabled" };
  queue: RawEventQueueDiagnostics | undefined;
  journalEntryCount: number;
  globalDirty: boolean;
}

export function getNativePerceptionDiagnostics(): NativePerceptionDiagnostics {
  return {
    enabled:          nativeEventsEnabled(),
    source:           _winEventSource?.diagnostics() ?? { state: "disabled" },
    queue:            _rawQueue?.diagnostics(),
    journalEntryCount: _journal.entries().size,
    globalDirty:      _journal.isGlobalDirty(),
  };
}
