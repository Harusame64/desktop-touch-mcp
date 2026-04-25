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
  /**
   * Set by the caller (e.g. keyboard tools after a successful focusWindowForKeyboard)
   * to indicate that the target window was just brought to the foreground by a
   * verified transition. When true, safe.keyboardTarget skips the foreground==true
   * fluent check because the caller already verified it via post-focus EnumWindows.
   * Other gates (identity, modal, dirty watermark, focused element) still run.
   */
  foregroundVerified?: boolean;
  /**
   * Phase F: browser readiness policy for browser tools (v3 §4.2, §12.3).
   *   "strict"             — block on readyState !== "complete" (default, browser_eval)
   *   "selectorInViewport" — pass-with-note when readyState !== "complete" but
   *                          browserSelectorInViewport is true (browser_click)
   *   "navigationGate"     — pass-with-note when readyState === "interactive"
   *                          (browser_navigate: navigation in progress is acceptable)
   */
  browserReadinessPolicy?: "strict" | "selectorInViewport" | "navigationGate";
  /** True when the target selector was resolved in-viewport (browser_click). */
  browserSelectorInViewport?: boolean;
}

/** Build a fluent-store key from the lens's target kind + binding id. */
function entityKey(lens: PerceptionLens, property: string): string {
  return `${lens.spec.target.kind}:${lens.binding.hwnd}.${property}`;
}

function readValue(store: FluentStore, lens: PerceptionLens, property: string): {
  value: unknown;
  confidence: number;
  status: string;
  validFromMonoMs: number;
  lastDirtyAtMonoMs: number | undefined;
} | null {
  const key = entityKey(lens, property);
  const fluent = store.read(key);
  if (!fluent) return null;
  const nowMs = Date.now();
  const conf = fluent.support[0] ? confidenceFor(fluent.support[0], nowMs) : fluent.confidence;
  return {
    value: fluent.value,
    confidence: conf,
    status: fluent.status,
    validFromMonoMs: fluent.validFromMonoMs,
    lastDirtyAtMonoMs: fluent.lastDirtyAtMonoMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function evalIdentityStable(lens: PerceptionLens, store: FluentStore, nowMs: number): GuardResult {
  // target.identity is not tracked for browserTab lenses — vacuously pass
  if (lens.spec.target.kind !== "window") {
    return { kind: "target.identityStable", ok: true, confidence: 1 };
  }
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

function evalKeyboardTarget(lens: PerceptionLens, store: FluentStore, nowMs: number, ctx?: GuardContext): GuardResult {
  if (lens.spec.target.kind === "browserTab") {
    // OS keyboard tools send keys to the focused OS window, not to a browser tab.
    // If the caller is keyboard_type or keyboard_press, fail-closed: the correct tool
    // for browser content input is browser_fill.
    const kbTools = ["keyboard_type", "keyboard_press"];
    if (ctx?.toolName && kbTools.includes(ctx.toolName)) {
      return {
        kind: "safe.keyboardTarget",
        ok: false,
        confidence: 1,
        reason: `${ctx.toolName} sends OS-level keystrokes to the focused window, not to a browser tab. Chrome must be in the foreground and the correct tab must be active.`,
        suggestedAction: "Use browser_fill to type into browser fields, or call focus_window(Chrome) first",
      };
    }
    // For non-keyboard browser tools, readyState check is sufficient.
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
  // foregroundVerified: caller (keyboard tool) already drove the window to the
  // foreground and confirmed the transition via post-focus EnumWindows. The fluent
  // store reads are taken a few ms later and can race with foreground-stealing
  // protection, so we trust the caller's verification for this single check.
  // All other gates (identity, modal, dirty watermark, focused element) still run.
  if (!ctx?.foregroundVerified) {
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

  // Dirty/settling watermark gate: block if foreground evidence is stale w.r.t. dirty mark.
  // Skipped when foregroundVerified (caller already confirmed transition), and when the
  // fluent is absent (the non-verified branch above would already have returned failure).
  if (foreground) {
    if (foreground.status === "dirty" || foreground.status === "settling") {
      return {
        kind: "safe.keyboardTarget",
        ok: false,
        confidence: foreground.confidence * 0.5,
        reason: `Foreground state is ${foreground.status} — cannot confirm safe keyboard target`,
        suggestedAction: "Call perception_read to get a fresh foreground observation",
      };
    }
    if (
      foreground.lastDirtyAtMonoMs != null &&
      foreground.validFromMonoMs <= foreground.lastDirtyAtMonoMs
    ) {
      return {
        kind: "safe.keyboardTarget",
        ok: false,
        confidence: foreground.confidence * 0.5,
        reason: "Foreground evidence predates last dirty mark — window focus may have changed",
        suggestedAction: "Call perception_read to refresh foreground state",
      };
    }
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

  return {
    kind: "safe.keyboardTarget",
    ok: true,
    confidence: foreground?.confidence ?? 1,
  };
}

function evalClickCoordinates(
  lens: PerceptionLens,
  store: FluentStore,
  nowMs: number,
  ctx: GuardContext
): GuardResult {
  // Click coordinate safety is not applicable for browserTab lenses — vacuously pass
  if (lens.spec.target.kind !== "window") {
    return { kind: "safe.clickCoordinates", ok: true, confidence: 1 };
  }

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

  // Dirty/settling watermark gate: block if rect is in motion or evidence is pre-dirty.
  if (rectFluent.status === "dirty" || rectFluent.status === "settling") {
    return {
      kind: "safe.clickCoordinates",
      ok: false,
      confidence: rectFluent.confidence * 0.5,
      reason: `Rect is ${rectFluent.status} — window may be moving or animating`,
      suggestedAction: "Wait for the window to settle, then call perception_read",
    };
  }
  if (
    rectFluent.lastDirtyAtMonoMs != null &&
    rectFluent.validFromMonoMs <= rectFluent.lastDirtyAtMonoMs
  ) {
    return {
      kind: "safe.clickCoordinates",
      ok: false,
      confidence: rectFluent.confidence * 0.5,
      reason: "Rect evidence predates last dirty mark — window may have moved since last observation",
      suggestedAction: "Take a new screenshot and call perception_read to get updated coordinates",
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
  // Rect stability is not applicable for browserTab lenses — vacuously pass
  if (lens.spec.target.kind !== "window") {
    return { kind: "stable.rect", ok: true, confidence: 1 };
  }

  /**
   * Quiet-window rule (watermark-based):
   * 1. Block if status is dirty/settling/stale/invalidated — window in motion.
   * 2. Block if validFromMonoMs <= lastDirtyAtMonoMs — evidence predates the last invalidation.
   * 3. Wait (pass with low confidence) if evidence is very fresh (< 250ms) and there's no
   *    prior dirty mark to anchor against.
   * 4. Pass once we have post-dirty evidence that is >=250ms old.
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

  // Rule 1: dirty/settling/stale/invalidated — rect is in motion or evidence is unreliable.
  if (
    rectFluent.status === "dirty" ||
    rectFluent.status === "settling" ||
    rectFluent.status === "stale" ||
    rectFluent.status === "invalidated"
  ) {
    return {
      kind: "stable.rect",
      ok: false,
      confidence: 0.3,
      reason: `Rect is ${rectFluent.status} — window may be animating`,
      suggestedAction: "Wait briefly, then retry",
    };
  }

  // Rule 2: evidence predates the dirty mark — stale observation snuck through before watermark.
  if (
    rectFluent.lastDirtyAtMonoMs != null &&
    rectFluent.validFromMonoMs <= rectFluent.lastDirtyAtMonoMs
  ) {
    return {
      kind: "stable.rect",
      ok: false,
      confidence: 0.3,
      reason: "Rect evidence predates last move/resize event — window position may have changed",
      suggestedAction: "Call perception_read to capture post-move rect",
    };
  }

  const ev = rectFluent.support[0];
  if (!ev) {
    // No evidence support record yet — first sample, treat as marginally stable.
    return { kind: "stable.rect", ok: true, confidence: 0.6 };
  }

  // Rule 3/4: quiet-window check using monoMs-relative age.
  // If we have a dirty mark, measure age from that mark (post-dirty observation).
  // Otherwise fall back to evidence observation age.
  const anchorMs = rectFluent.lastDirtyAtMonoMs ?? ev.observedAtMs;
  const quietMs = rectFluent.validFromMonoMs - anchorMs;
  if (quietMs < STABLE_MS) {
    // Very fresh post-dirty observation — pass with lower confidence (guard alone won't block).
    return { kind: "stable.rect", ok: true, confidence: 0.6 };
  }

  return { kind: "stable.rect", ok: true, confidence: confidenceFor(ev, nowMs) };
}

function evalBrowserReady(
  lens: PerceptionLens,
  store: FluentStore,
  _nowMs: number,
  kind: "browser.ready" | "safe.keyboardTarget" = "browser.ready",
  ctx?: GuardContext
): GuardResult {
  // browser.ready is not applicable for window lenses — vacuously pass
  if (lens.spec.target.kind !== "browserTab") {
    return { kind, ok: true, confidence: 1 };
  }

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
    const policy = ctx?.browserReadinessPolicy ?? "strict";

    // selectorInViewport: pass with warn-note when selector is already in view (F-3)
    if (policy === "selectorInViewport" && ctx?.browserSelectorInViewport === true) {
      return {
        kind,
        ok: true,
        confidence: readyState.confidence,
        note: `warn: readyState="${readyState.value}" but selector in viewport — continuing`,
      };
    }

    // navigationGate: treat "interactive" as acceptable (F-3, browser_navigate)
    if (policy === "navigationGate" && readyState.value === "interactive") {
      return {
        kind,
        ok: true,
        confidence: readyState.confidence,
        note: `warn: readyState=interactive (navigation in progress)`,
      };
    }

    // strict (default) or loading with other policies → block
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
    case "safe.keyboardTarget":    return evalKeyboardTarget(lens, store, nowMs, ctx);
    case "safe.clickCoordinates":  return evalClickCoordinates(lens, store, nowMs, ctx);
    case "stable.rect":            return evalStableRect(lens, store, nowMs);
    case "browser.ready":          return evalBrowserReady(lens, store, nowMs, "browser.ready", ctx);
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
