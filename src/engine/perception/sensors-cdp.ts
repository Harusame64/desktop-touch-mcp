/**
 * CDP sensor for the Reactive Perception Graph.
 *
 * Refreshes browser.url / browser.title / browser.readyState for browserTab lenses.
 * Errors are swallowed and emit low-confidence null observations so guards degrade
 * gracefully when Chrome closes or the tab is navigated away.
 *
 * This is the ONLY file in src/engine/perception/ that imports cdp-bridge.
 */

import type { Observation } from "./types.js";
import { makeEvidence } from "./evidence.js";
import { getTabContext } from "../cdp-bridge.js";
import { subscribe, poll, unsubscribe } from "../event-bus.js";

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

let _seq = 0;
function nextSeq(): number { return ++_seq; }

let _subscriptionId: string | null = null;
let _drainTimer: ReturnType<typeof setInterval> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Public: refresh CDP fluents for one tab
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh browser.url / browser.title / browser.readyState for the given CDP tab.
 * Returns [] on error (tab closed, CDP unreachable) — never throws.
 */
export async function refreshCdpFluents(
  tabId: string,
  port = 9222
): Promise<Observation[]> {
  const seq = nextSeq();
  const nowMs = Date.now();
  const entity = { kind: "browserTab" as const, id: tabId };

  try {
    const ctx = await getTabContext(tabId, port);

    // getTabContext may return { id: null } when CDP fails — treat as error
    if (!ctx.id) {
      return _nullObservations(entity, seq, nowMs);
    }

    const evidence = makeEvidence("cdp", seq, nowMs);
    const conf = 0.95;
    return [
      { seq, tsMs: nowMs, source: "cdp", entity, property: "browser.url",        value: ctx.url,        confidence: conf, evidence },
      { seq, tsMs: nowMs, source: "cdp", entity, property: "browser.title",       value: ctx.title,      confidence: conf, evidence },
      { seq, tsMs: nowMs, source: "cdp", entity, property: "browser.readyState",  value: ctx.readyState, confidence: conf, evidence },
    ];
  } catch {
    return _nullObservations(entity, seq, nowMs);
  }
}

function _nullObservations(
  entity: { kind: "browserTab"; id: string },
  seq: number,
  nowMs: number
): Observation[] {
  const evidence = makeEvidence("cdp", seq, nowMs);
  const conf = 0.30; // low-confidence null — tab closed / CDP unreachable
  return [
    { seq, tsMs: nowMs, source: "cdp", entity, property: "browser.url",        value: null, confidence: conf, evidence },
    { seq, tsMs: nowMs, source: "cdp", entity, property: "browser.title",       value: null, confidence: conf, evidence },
    { seq, tsMs: nowMs, source: "cdp", entity, property: "browser.readyState",  value: null, confidence: conf, evidence },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: background sensor loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start a 250 ms background sensor loop for all active browser-tab lenses.
 * CDP state changes happen independently of foreground events, so we poll
 * unconditionally on each tick (not just on foreground_changed).
 *
 * @param getBrowserTabs  Returns `{ tabId, port }` pairs for currently tracked tabs
 * @param onObservations  Called with batched observations after each refresh
 * @returns               Disposer function — call to stop the loop
 */
export function startCdpSensorLoop(
  getBrowserTabs: () => Array<{ tabId: string; port: number }>,
  onObservations: (tabId: string, obs: Observation[]) => void
): () => void {
  if (_subscriptionId) return () => { /* already running */ };

  _subscriptionId = subscribe(["foreground_changed"]);

  _drainTimer = setInterval(() => {
    if (!_subscriptionId) return;
    // Drain event bus (keep buffer from growing unboundedly)
    poll(_subscriptionId, undefined, true);

    const tabs = getBrowserTabs();
    if (tabs.length === 0) return;

    // Refresh all tracked tabs unconditionally — readyState changes are not foreground events
    for (const { tabId, port } of tabs) {
      refreshCdpFluents(tabId, port)
        .then(obs => { if (obs.length > 0) onObservations(tabId, obs); })
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
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Reset all CDP sensor state. Only for use in unit tests. */
export function __resetCdpSensorForTests(): void {
  _seq = 0;
  if (_subscriptionId) { try { unsubscribe(_subscriptionId); } catch {} _subscriptionId = null; }
  if (_drainTimer) { clearInterval(_drainTimer); _drainTimer = null; }
}
