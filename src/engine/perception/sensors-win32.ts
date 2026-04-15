/**
 * Win32 sensor for the Reactive Perception Graph.
 *
 * This is the ONLY file in src/engine/perception/ that imports Win32,
 * event-bus, or identity-tracker. All other perception modules are pure.
 */

import type { Observation, WindowIdentity } from "./types.js";
import { makeEvidence } from "./evidence.js";
import {
  enumWindowsInZOrder,
  getWindowRectByHwnd,
  getWindowIdentity,
  isWindowTopmost,
  getWindowClassName,
} from "../win32.js";
import { subscribe, poll, unsubscribe } from "../event-bus.js";
import { observeTarget } from "../identity-tracker.js";

// Modal detection patterns (title heuristic, MVP)
const MODAL_TITLE_RE = /dialog|confirm|prompt|alert|error|警告|エラー|確認|通知|ダイアログ/i;

let _seq = 0;
function nextSeq(): number { return ++_seq; }

// ─────────────────────────────────────────────────────────────────────────────
// Public: build observations for a single tracked window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh all Win32-backed fluents for a lens's target window.
 * Returns an array of observations to be ingested into the FluentStore.
 *
 * @param hwnd      The target window HWND (decimal string)
 * @param titleKey  The lens's titleIncludes search string (for identity-tracker)
 */
export function refreshWin32Fluents(hwnd: string, titleKey: string): Observation[] {
  const nowMs = Date.now();
  const obs: Observation[] = [];
  const hwndBig = BigInt(hwnd);

  const makeObs = (property: string, value: unknown, confidence: number): Observation => ({
    seq: nextSeq(),
    tsMs: nowMs,
    source: "win32",
    entity: { kind: "window", id: hwnd },
    property,
    value,
    confidence,
    evidence: makeEvidence("win32", nextSeq(), nowMs),
  });

  // Enumerate all visible windows to check existence, foreground, z-order, modal
  // Compare by string to avoid number vs bigint mismatch (koffi returns intptr as JS number)
  const windows = enumWindowsInZOrder();
  const target = windows.find(w => String(w.hwnd) === hwnd);

  // target.exists
  obs.push(makeObs("target.exists", target != null, 0.98));

  if (!target) {
    // Window gone — identity fluent marks it null
    obs.push(makeObs("target.identity", null, 0.98));
    return obs;
  }

  // target.title
  obs.push(makeObs("target.title", target.title, 0.98));

  // target.foreground
  obs.push(makeObs("target.foreground", target.isActive, 0.98));

  // target.zOrder
  obs.push(makeObs("target.zOrder", target.zOrder, 0.98));

  // target.rect (fresh from Win32, not from enumWindowsInZOrder's snapshot)
  const rect = getWindowRectByHwnd(hwndBig);
  obs.push(makeObs("target.rect", rect, rect ? 0.98 : 0.40));

  // target.identity (via identity-tracker for processStartTimeMs)
  const { identity, invalidatedBy } = observeTarget(titleKey, hwndBig, target.title);
  const identValue: WindowIdentity | null = identity
    ? {
        hwnd,
        pid: identity.pid,
        processName: identity.processName,
        processStartTimeMs: identity.processStartTimeMs,
        titleResolved: identity.titleResolved,
      }
    : null;
  obs.push(makeObs("target.identity", identValue, identValue ? 0.98 : 0.0));

  // modal.above — check if any window above the target (lower zOrder) is topmost or dialog-like
  const topmostOrDialog = windows.filter(w => {
    if (String(w.hwnd) === hwnd) return false;      // skip the target itself
    if (w.zOrder >= target.zOrder) return false;    // must be above target in z-order
    const topmost = isWindowTopmost(w.hwnd);
    const dialogTitle = MODAL_TITLE_RE.test(w.title);
    const className = getWindowClassName(w.hwnd);
    const isDialogClass = className === "#32770";   // standard Win32 dialog class
    return topmost || dialogTitle || isDialogClass;
  });
  obs.push(makeObs("modal.above", topmostOrDialog.length > 0, 0.90));

  return obs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: build a WindowIdentity from live Win32 data (used at lens registration)
// ─────────────────────────────────────────────────────────────────────────────

export function buildWindowIdentity(hwnd: string): WindowIdentity | null {
  try {
    const hwndBig = BigInt(hwnd);
    const ident = getWindowIdentity(hwndBig);
    if (!ident) return null;
    return {
      hwnd,
      pid: ident.pid,
      processName: ident.processName,
      processStartTimeMs: ident.processStartTimeMs,
      titleResolved: "",  // filled by caller from window snapshot
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: sensor loop (piggybacks on event-bus, no second timer)
// ─────────────────────────────────────────────────────────────────────────────

let _subscriptionId: string | null = null;
let _drainTimer: ReturnType<typeof setInterval> | null = null;

type OnObservations = (hwnd: string, titleKey: string, obs: Observation[]) => void;

/**
 * Start listening to the event-bus for window/foreground changes.
 * Does NOT start a new EnumWindows timer — piggybacks on event-bus's 500ms tick.
 *
 * The callback receives raw observations and the hwnd+titleKey that triggered them.
 * The caller (registry.ts) maps those to registered lenses.
 *
 * Returns a dispose function.
 */
export function startSensorLoop(
  getTrackedWindows: () => Array<{ hwnd: string; titleKey: string }>,
  onObservations: OnObservations
): () => void {
  if (_subscriptionId) return () => {};  // already running

  _subscriptionId = subscribe(["window_appeared", "window_disappeared", "foreground_changed"]);

  // Drain event-bus every 250ms (faster than the 500ms tick; no extra EnumWindows calls)
  _drainTimer = setInterval(() => {
    if (!_subscriptionId) return;
    const events = poll(_subscriptionId, undefined, false); // drain=false to keep other subscribers' events
    if (events.length === 0) return;

    // For each affected HWND, refresh all tracked windows that might be relevant
    for (const { hwnd, titleKey } of getTrackedWindows()) {
      const obs = refreshWin32Fluents(hwnd, titleKey);
      onObservations(hwnd, titleKey, obs);
    }
  }, 250);
  _drainTimer.unref();

  return () => {
    if (_subscriptionId) { unsubscribe(_subscriptionId); _subscriptionId = null; }
    if (_drainTimer) { clearInterval(_drainTimer); _drainTimer = null; }
  };
}

/** Reset sensor state. Only for tests. */
export function __resetSensorForTests(): void {
  if (_subscriptionId) { try { unsubscribe(_subscriptionId); } catch {} _subscriptionId = null; }
  if (_drainTimer) { clearInterval(_drainTimer); _drainTimer = null; }
  _seq = 0;
}
