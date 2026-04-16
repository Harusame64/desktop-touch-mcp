/**
 * Guard evaluators for the Reactive Perception Graph.
 * Pure functions — no OS imports. All inputs are injected.
 */

import type {
  GuardEvalResult,
  GuardKind,
  GuardPolicy,
  GuardResult,
  PerceptionLens,
} from "./types.js";
import type { FluentStore } from "./fluent-store.js";
import { confidenceFor } from "./evidence.js";

// Confidence thresholds per guard class (from design doc)
const THRESHOLD_ORDINARY_KB  = 0.90;
const THRESHOLD_CLICK        = 0.90;

/** Context for guards that need action-call arguments. */
export interface GuardContext {
  clickX?: number;
  clickY?: number;
  toolName?: string;
}

/** Build a fluent-store key from the lens's target kind + binding id. */
function entityKey(lens: PerceptionLens, property: string): string {
  return `${lens.spec.target.kind}:${lens.binding.hwnd}.${property}`;
}

function readValue(store: FluentStore, lens: PerceptionLens, property: string): {
  value: unknown;
  confidence: number;
  status: string;
} | null {
  const key = entityKey(lens, property);
  const fluent = store.read(key);
  if (!fluent) return null;
  const nowMs = Date.now();
  const conf = fluent.support[0] ? confidenceFor(fluent.support[0], nowMs) : fluent.confidence;
  return { value: fluent.value, confidence: conf, status: fluent.status };
}

// ─────────────────────────────────────────────────────────────────────────────

function evalIdentityStable(lens: PerceptionLens, store: FluentStore, nowMs: number): GuardResult {
  const identityFluent = readValue(store, lens, "target.identity");

  if (!identityFluent) {
    return {
      kind: "target.identityStable",
      ok: false,
      confidence: 0,
      reason: "target.identity fluent not found — lens may not be refreshed yet",
      suggestedAction: "Call perception_read to force a refresh",
    };
  }

  const identity = identityFluent.value as { pid?: number; processStartTimeMs?: number } | null;
  const bound = lens.boundIdentity as { pid?: number; processStartTimeMs?: number };

  if (!identity) {
    return {
      kind: "target.identityStable",
      ok: false,
      confidence: identityFluent.confidence,
      reason: "Target window no longer exists",
      suggestedAction: "Re-register lens after reopening the application",
    };
  }

  if (identity.pid !== bound.pid || identity.processStartTimeMs !== bound.processStartTimeMs) {
    return {
      kind: "target.identityStable",
      ok: false,
      confidence: identityFluent.confidence,
      reason: `Identity changed: expected pid=${bound.pid} startTime=${bound.processStartTimeMs}, got pid=${identity.pid} startTime=${identity.processStartTimeMs}`,
      suggestedAction: "Re-register lens for the new process instance",
    };
  }

  return { kind: "target.identityStable", ok: true, confidence: identityFluent.confidence };
}

function evalKeyboardTarget(lens: PerceptionLens, store: FluentStore, nowMs: number): GuardResult {
  // For browserTab lenses, keyboard safety is determined by browser.readyState, not Win32 foreground
  if (lens.spec.target.kind === "browserTab") {
    return evalBrowserReady(lens, store, nowMs, "safe.keyboardTarget");
  }

  const identityGuard = evalIdentityStable(lens, store, nowMs);
  if (!identityGuard.ok) {
    return {
      kind: "safe.keyboardTarget",
      ok: false,
      confidence: identityGuard.confidence,
      reason: `Identity unstable: ${identityGuard.reason}`,
      suggestedAction: identityGuard.suggestedAction,
    };
  }

  const foreground = readValue(store, lens, "target.foreground");
  if (!foreground || foreground.value !== true) {
    return {
      kind: "safe.keyboardTarget",
      ok: false,
      confidence: foreground?.confidence ?? 0,
      reason: "Target window is not in the foreground — keyboard input may go to wrong window",
      suggestedAction: "Call focus_window to bring target to foreground first",
    };
  }
  if (foreground.confidence < THRESHOLD_ORDINARY_KB) {
    return {
      kind: "safe.keyboardTarget",
      ok: false,
      confidence: foreground.confidence,
      reason: "Target foreground confidence too low (stale evidence)",
      suggestedAction: "Call perception_read to force a foreground refresh",
    };
  }

  const modal = readValue(store, lens, "modal.above");
  if (modal && modal.value === true) {
    return {
      kind: "safe.keyboardTarget",
      ok: false,
      confidence: modal.confidence,
      reason: "A modal dialog is blocking the target window",
      suggestedAction: "Dismiss the modal first, then retry",
    };
  }

  // Additive focused-element gate (only when fluent is present — requires salience:"critical").
  // Absent fluent: passes silently, preserving backward compat for normal/background lenses.
  const fe = readValue(store, lens, "target.focusedElement");
  if (fe && fe.value) {
    const info = fe.value as { controlType: string };
    const READONLY_TYPES = new Set(["Text", "Image", "StatusBar", "TitleBar", "ToolBar"]);
    if (READONLY_TYPES.has(info.controlType)) {
      return {
        kind: "safe.keyboardTarget",
        ok: false,
        confidence: fe.confidence,
        reason: `Focused element is a read-only ${info.controlType} — keys would be dropped`,
        suggestedAction: "Click an editable control (Edit, ComboBox, RichEdit) before typing",
      };
    }
  }

  return { kind: "safe.keyboardTarget", ok: true, confidence: foreground.confidence };
}

function evalClickCoordinates(
  lens: PerceptionLens,
  store: FluentStore,
  nowMs: number,
  ctx: GuardContext
): GuardResult {
  const { clickX, clickY } = ctx;

  const identityGuard = evalIdentityStable(lens, store, nowMs);
  if (!identityGuard.ok) {
    return {
      kind: "safe.clickCoordinates",
      ok: false,
      confidence: identityGuard.confidence,
      reason: `Identity unstable: ${identityGuard.reason}`,
      suggestedAction: identityGuard.suggestedAction,
    };
  }

  const rectFluent = readValue(store, lens, "target.rect");
  if (!rectFluent) {
    return {
      kind: "safe.clickCoordinates",
      ok: false,
      confidence: 0,
      reason: "target.rect fluent not found",
      suggestedAction: "Call perception_read to populate rect before clicking",
    };
  }

  if (rectFluent.confidence < THRESHOLD_CLICK) {
    return {
      kind: "safe.clickCoordinates",
      ok: false,
      confidence: rectFluent.confidence,
      reason: "Rect evidence confidence too low (stale or conflicting)",
      suggestedAction: "Call perception_read to refresh window rect before clicking",
    };
  }

  // Point-in-rect check (if coords provided)
  if (clickX != null && clickY != null) {
    const rect = rectFluent.value as { x: number; y: number; width: number; height: number } | null;
    if (rect) {
      const inside = clickX >= rect.x && clickX <= rect.x + rect.width
        && clickY >= rect.y && clickY <= rect.y + rect.height;
      if (!inside) {
        return {
          kind: "safe.clickCoordinates",
          ok: false,
          confidence: rectFluent.confidence,
          reason: `Click (${clickX},${clickY}) is outside target rect (${rect.x},${rect.y},${rect.width}×${rect.height}) — window may have moved`,
          suggestedAction: "Take a new screenshot to get fresh coordinates",
        };
      }
    }
  }

  return { kind: "safe.clickCoordinates", ok: true, confidence: rectFluent.confidence };
}

function evalStableRect(lens: PerceptionLens, store: FluentStore, nowMs: number): GuardResult {
  /**
   * MVP: fixed 250ms stability window.
   * Pass when the rect evidence age >= 250ms AND status is "observed" (not dirty/stale).
   * First-sample case (only one observation, <250ms old): pass with confidence 0.6.
   * Note: confidence 0.6 is below the click/keyboard threshold (0.90), so this guard alone
   * won't block — other guards (foreground, identity) will catch problems first.
   */
  const STABLE_MS = 250;
  const rectFluent = store.read(entityKey(lens, "target.rect"));

  if (!rectFluent) {
    return {
      kind: "stable.rect",
      ok: false,
      confidence: 0,
      reason: "target.rect fluent not present — no measurement taken yet",
      suggestedAction: "Wait for perception refresh before acting",
    };
  }

  if (rectFluent.status === "dirty" || rectFluent.status === "stale" || rectFluent.status === "invalidated") {
    return {
      kind: "stable.rect",
      ok: false,
      confidence: 0.3,
      reason: `Rect is ${rectFluent.status} — window may be animating`,
      suggestedAction: "Wait briefly, then retry",
    };
  }

  const ev = rectFluent.support[0];
  if (!ev) {
    return { kind: "stable.rect", ok: true, confidence: 0.6 }; // first sample
  }

  const age = nowMs - ev.observedAtMs;
  if (age < STABLE_MS) {
    // First measurement or very fresh — pass with lower confidence
    return { kind: "stable.rect", ok: true, confidence: 0.6 };
  }

  return { kind: "stable.rect", ok: true, confidence: confidenceFor(ev, nowMs) };
}

function evalBrowserReady(
  lens: PerceptionLens,
  store: FluentStore,
  _nowMs: number,
  kind: "browser.ready" | "safe.keyboardTarget" = "browser.ready"
): GuardResult {
  const readyState = readValue(store, lens, "browser.readyState");
  if (!readyState) {
    return {
      kind,
      ok: false,
      confidence: 0,
      reason: "browser.readyState fluent not present — tab may not have been refreshed yet",
      suggestedAction: "Call perception_read to force a CDP refresh",
    };
  }
  if (readyState.value !== "complete") {
    return {
      kind,
      ok: false,
      confidence: readyState.confidence,
      reason: `Browser is not ready (readyState: "${readyState.value}") — page still loading`,
      suggestedAction: `Wait for browser_navigate to complete, or poll browser_eval("document.readyState")`,
    };
  }
  return { kind, ok: true, confidence: readyState.confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateGuard(
  kind: GuardKind,
  lens: PerceptionLens,
  store: FluentStore,
  nowMs: number,
  ctx: GuardContext = {}
): GuardResult {
  switch (kind) {
    case "target.identityStable":  return evalIdentityStable(lens, store, nowMs);
    case "safe.keyboardTarget":    return evalKeyboardTarget(lens, store, nowMs);
    case "safe.clickCoordinates":  return evalClickCoordinates(lens, store, nowMs, ctx);
    case "stable.rect":            return evalStableRect(lens, store, nowMs);
    case "browser.ready":          return evalBrowserReady(lens, store, nowMs);
  }
}

export function evaluateGuards(
  lens: PerceptionLens,
  store: FluentStore,
  policy: GuardPolicy,
  ctx: GuardContext = {}
): GuardEvalResult {
  const nowMs = Date.now();
  const results: GuardResult[] = [];
  let firstFailure: GuardResult | undefined;

  for (const kind of lens.spec.guards) {
    const r = evaluateGuard(kind, lens, store, nowMs, ctx);
    results.push(r);
    if (!r.ok && !firstFailure) firstFailure = r;
  }

  const allOk = results.every(r => r.ok);

  let attention: import("./types.js").AttentionState;
  if (allOk) {
    attention = "ok";
  } else {
    attention = "guard_failed";
  }

  return {
    ok: allOk,
    policy,
    attention,
    results,
    ...(firstFailure && { failedGuard: firstFailure }),
  };
}
