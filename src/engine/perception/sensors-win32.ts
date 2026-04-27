/**
 * Win32 sensor for the Reactive Perception Graph.
 *
 * This is the ONLY file in src/engine/perception/ that imports Win32,
 * event-bus, or identity-tracker. All other perception modules are pure.
 */

import type { Observation, WindowIdentity } from "./types.js";
import type { WindowZInfo } from "../win32.js";
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

// Modal detection — title heuristic used as confidence booster only (not primary trigger)
const MODAL_TITLE_RE = /dialog|confirm|prompt|alert|error|警告|エラー|確認|通知|ダイアログ/i;

// Minimum pixel area for a candidate modal window — filters out tooltips
const MODAL_MIN_AREA = 10_000;

// System-resident UWP/shell window classes that are never modal blockers.
// These windows are always-on-top (WS_EX_TOPMOST) by design but do not block input.
// Add entries here when new system window classes cause false positives.
const SYSTEM_RESIDENT_CLASSES = new Set([
  "Windows.UI.Core.CoreWindow",         // UWP core (IME, 入力エクスペリエンス, etc.)
  "ApplicationFrameWindow",             // UWP app host frame
  "Windows.UI.Input.InputSite.WindowClass", // IME on-screen keyboard / handwriting
  "Shell_TrayWnd",                      // taskbar
  "Shell_SecondaryTrayWnd",             // secondary monitor taskbar
  "NotifyIconOverflowWindow",           // system tray overflow
  "TaskListThumbnailWnd",               // alt-tab thumbnail
  "MultitaskingViewFrame",              // task view
]);

let _seq = 0;
function nextSeq(): number { return ++_seq; }

const WS_EX_TOPMOST_FLAG = 0x00000008;

// ─────────────────────────────────────────────────────────────────────────────
// Modal detection — exported for unit tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether any window above `target` in z-order qualifies as a modal.
 *
 * Rules (ordered by confidence):
 *   1. Target is disabled (isEnabled===false) — classic Win32 modal pattern. (0.93)
 *   2. Candidate is directly owned by target (ownerHwnd === target.hwnd). (0.88)
 *   3. Candidate has Win32 dialog class "#32770". (0.80)
 *
 * Boosters (only raise conf, never trigger alone):
 *   - Candidate has WS_EX_TOPMOST extended style: +0.03
 *   - Candidate title matches MODAL_TITLE_RE: +0.02
 *
 * Candidates must pass pre-filters:
 *   - Not the target window itself
 *   - Above target in z-order (lower zOrder value)
 *   - Enabled and not cloaked by DWM
 *   - Area > MODAL_MIN_AREA (filters out tooltips)
 *   - Not a known system-resident UWP/shell class (SYSTEM_RESIDENT_CLASSES)
 *   - When target is foreground: only Rule 1/2 are eligible (Rule 3 skipped)
 *
 * Returns { isModal: false } when no window qualifies.
 * When multiple windows qualify, returns the highest-confidence result.
 *
 * Exported for unit testing.
 */
export function evaluateModalAbove(
  target: WindowZInfo,
  windows: WindowZInfo[]
): { isModal: boolean; confidence: number } {
  let bestConf = 0;

  for (const w of windows) {
    // Pre-filters
    if (w.hwnd === target.hwnd) continue;
    if (w.zOrder >= target.zOrder) continue;           // must be above target
    if (w.isEnabled === false) continue;               // disabled candidate → not a modal blocker
    if (w.isCloaked === true) continue;                // cloaked = not visible to user
    const area = (w.region.width * w.region.height);
    if (area > 0 && area < MODAL_MIN_AREA) continue;  // tooltip-sized popup

    // Skip known system-resident windows — always-on-top but never block input
    const cls = w.className ?? (w.hwnd ? getWindowClassName(w.hwnd) : "");
    if (SYSTEM_RESIDENT_CLASSES.has(cls)) continue;

    let conf = 0;

    // Rule 1: target is disabled — strongest signal (owner blocked by dialog)
    if (target.isEnabled === false) {
      conf = Math.max(conf, 0.93);
    }

    // Rule 2: candidate directly owned by target
    if (w.ownerHwnd != null && w.ownerHwnd === target.hwnd) {
      conf = Math.max(conf, 0.88);
    }

    // Rule 3: standard Win32 dialog class
    if (cls === "#32770") {
      conf = Math.max(conf, 0.80);
    }

    if (conf === 0) continue;

    // Boosters — raise confidence but never trigger modal detection alone
    const exStyle = w.exStyle ?? (isWindowTopmost(w.hwnd) ? WS_EX_TOPMOST_FLAG : 0);
    if ((exStyle & WS_EX_TOPMOST_FLAG) !== 0) conf = Math.min(1, conf + 0.03);
    if (MODAL_TITLE_RE.test(w.title))          conf = Math.min(1, conf + 0.02);

    if (conf > bestConf) bestConf = conf;
  }

  return bestConf > 0
    ? { isModal: true, confidence: bestConf }
    : { isModal: false, confidence: 0 };
}

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

  const makeObs = (property: string, value: unknown, confidence: number): Observation => {
    const seq = nextSeq();
    return {
      seq,
      tsMs: nowMs,
      source: "win32",
      entity: { kind: "window", id: hwnd },
      property,
      value,
      confidence,
      evidence: makeEvidence("win32", seq, nowMs),
    };
  };

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
  const { identity } = observeTarget(titleKey, hwndBig, target.title);
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

  // modal.above — owner-chain + disabled-owner predicate
  const { isModal, confidence: modalConf } = evaluateModalAbove(target, windows);
  obs.push(makeObs("modal.above", isModal, isModal ? modalConf : 0.95));

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
    const events = poll(_subscriptionId, undefined, true); // drain our own buffer (each subscription has its own buffer; draining does not affect other subscribers)
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
  if (_subscriptionId) { try { unsubscribe(_subscriptionId); } catch { /* already torn down */ } _subscriptionId = null; }
  if (_drainTimer) { clearInterval(_drainTimer); _drainTimer = null; }
  _seq = 0;
}
