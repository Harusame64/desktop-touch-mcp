/**
 * UIA sensor for the Reactive Perception Graph.
 *
 * Maintains a 500ms cache of the system-global focused element.
 * Only fires PowerShell for lenses with salience="critical".
 *
 * This is the ONLY file in src/engine/perception/ that imports uia-bridge.
 * All other perception modules remain pure.
 */

import type { Observation } from "./types.js";
import type { UiaFocusInfo } from "../uia-bridge.js";
import { makeEvidence } from "./evidence.js";
import { getFocusedElement } from "../uia-bridge.js";
import { subscribe, poll, unsubscribe } from "../event-bus.js";

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

/** 500ms cache for the most recent UIA focused-element result (global, not per-hwnd). */
interface UiaCacheEntry { value: UiaFocusInfo | null; tsMs: number; }
let _cache: UiaCacheEntry | null = null;
const UIA_CACHE_MS = 500;

/** Deduplicates concurrent PowerShell invocations within a single tick. */
let _inFlight: Promise<void> | null = null;

let _seq = 0;
function nextSeq(): number { return ++_seq; }

// ─────────────────────────────────────────────────────────────────────────────
// Core: single observation builder
// ─────────────────────────────────────────────────────────────────────────────

function buildObs(hwnd: string, value: UiaFocusInfo | null, nowMs: number, notes?: string[]): Observation {
  const seq = nextSeq();
  return {
    seq,
    tsMs: nowMs,
    source: "uia",
    entity: { kind: "window", id: hwnd },
    property: "target.focusedElement",
    value,
    // Higher confidence when a concrete element was found; lower when null because
    // it could mean "no focus" OR "UIA call failed" — indistinguishable without more work.
    confidence: value ? 0.92 : 0.40,
    evidence: makeEvidence("uia", seq, nowMs, {
      ttlMs: UIA_CACHE_MS,
      ...(notes && notes.length > 0 && { notes }),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: refresh UIA fluents for a lens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the currently focused UI element and return it as an Observation.
 *
 * Gate: returns [] immediately when salience is not "critical" (unless force=true),
 * so default/background lenses never pay the ~200-500ms PowerShell cost.
 *
 * Cache: returns a cached result (with notes:["cached"]) within UIA_CACHE_MS.
 *
 * Dedupe: if a PowerShell call is already in-flight, awaits it and returns the
 * freshly cached result rather than spawning a second process.
 *
 * @param hwnd      The binding hwnd for this lens — used as the observation entity id.
 * @param salience  Lens salience; anything other than "critical" is a no-op.
 * @param force     Skip the salience gate (used for explicit perception_read calls).
 */
export async function refreshUiaFluents(
  hwnd: string,
  salience: "critical" | "normal" | "background",
  force = false
): Promise<Observation[]> {
  if (salience !== "critical" && !force) return [];

  const nowMs = Date.now();

  // Cache hit
  if (!force && _cache && (nowMs - _cache.tsMs) < UIA_CACHE_MS) {
    return [buildObs(hwnd, _cache.value, nowMs, ["cached"])];
  }

  // Deduplication: join an in-flight call instead of spawning another
  if (_inFlight) {
    await _inFlight;
    if (_cache) {
      return [buildObs(hwnd, _cache.value, Date.now(), ["deduped"])];
    }
    return [];
  }

  // Fresh read
  let focusedValue: UiaFocusInfo | null = null;
  _inFlight = getFocusedElement(undefined, UIA_CACHE_MS)
    .then(f  => { focusedValue = f; })
    .catch(() => { focusedValue = null; })
    .finally(() => {
      _cache = { value: focusedValue, tsMs: Date.now() };
      _inFlight = null;
    });
  await _inFlight;

  return [buildObs(hwnd, focusedValue, Date.now())];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: sensor loop
// ─────────────────────────────────────────────────────────────────────────────

let _subscriptionId: string | null = null;
let _drainTimer: ReturnType<typeof setInterval> | null = null;

type OnObservations = (hwnd: string, obs: Observation[]) => void;

/**
 * Start listening to the event-bus for foreground changes and refreshing
 * focused-element fluents for critical lenses on each tick.
 *
 * Piggybacks on the 250ms event-bus drain interval (no new timer is added if
 * the Win32 loop is already running, but both loops are kept independent to
 * avoid coupling their lifecycle).
 *
 * Returns a dispose function.
 */
export function startUiaSensorLoop(
  getCriticalWindows: () => Array<{ hwnd: string }>,
  onObservations: OnObservations
): () => void {
  if (_subscriptionId) return () => {};  // already running

  _subscriptionId = subscribe(["foreground_changed"]);

  _drainTimer = setInterval(() => {
    if (!_subscriptionId) return;
    const events = poll(_subscriptionId, undefined, true);
    if (events.length === 0) return;

    // On any foreground change, kick off a UIA refresh for each critical lens.
    // Firing is async fire-and-forget; the cache prevents redundant PS calls.
    for (const { hwnd } of getCriticalWindows()) {
      refreshUiaFluents(hwnd, "critical")
        .then(obs => { if (obs.length > 0) onObservations(hwnd, obs); })
        .catch(() => { /* sensor loop must never throw */ });
    }
  }, 250);
  _drainTimer.unref();

  return () => {
    if (_subscriptionId) { unsubscribe(_subscriptionId); _subscriptionId = null; }
    if (_drainTimer) { clearInterval(_drainTimer); _drainTimer = null; }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset — tests only
// ─────────────────────────────────────────────────────────────────────────────

/** Reset all UIA sensor state. Only for use in unit tests. */
export function __resetUiaSensorForTests(): void {
  _cache = null;
  _inFlight = null;
  _seq = 0;
  if (_subscriptionId) { try { unsubscribe(_subscriptionId); } catch { /* already torn down */ } _subscriptionId = null; }
  if (_drainTimer) { clearInterval(_drainTimer); _drainTimer = null; }
}
