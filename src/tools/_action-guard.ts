/**
 * _action-guard.ts — Auto-guard middleware for action tools.
 *
 * Provides two entry points:
 *   - withActionGuard<T>: middleware wrapper (keyboard / UIA / browser tools)
 *   - runActionGuard: direct call for tools that need manual coordinate ordering (mouse)
 *   - isAutoGuardEnabled: env flag check (DESKTOP_TOUCH_AUTO_GUARD !== "0")
 *
 * Does NOT use registerLens() — uses resolveActionTarget() which builds
 * an ephemeral lens from primitives to avoid LRU churn on the global registry.
 */

import { failWith, failCode, getSuggestsForCode } from "./_errors.js";
import { isAutoGuardEnabled } from "../utils/auto-guard-env.js";
import { logDiagnostic } from "../engine/diagnostic-log.js";
import { getWindowProcessId, getProcessIdentityByPid } from "../engine/win32.js";
import type { ToolResult } from "./_types.js";
import { resolveActionTarget, deriveTargetKey } from "../engine/perception/action-target.js";
import type {
  ActionKind,
  ActionTargetDescriptor,
  AutoGuardEnvelope,
} from "../engine/perception/action-target.js";
import { evaluateGuards } from "../engine/perception/guards.js";
import type { GuardEvalResult } from "../engine/perception/types.js";
import type { WindowIdentity } from "../engine/perception/types.js";
import { storeFix } from "../engine/perception/suggested-fix-store.js";
import type { SuggestedFix } from "../engine/perception/suggested-fix-store.js";
import { appendEvent } from "../engine/perception/target-timeline.js";

export type { ActionKind, ActionTargetDescriptor, AutoGuardEnvelope };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionGuardOptions<T> {
  extractTarget: (args: T) => ActionTargetDescriptor | null;
  actionKind: ActionKind;
  coordinateSource?: (args: T) => { x: number; y: number } | undefined;
  forbidBrowserTabForKeyboard?: boolean;
}

export interface RunActionGuardParams {
  toolName: string;
  actionKind: ActionKind;
  descriptor: ActionTargetDescriptor | null;
  clickCoordinates?: { x: number; y: number };
  /**
   * Set by keyboard tools after focusWindowForKeyboard successfully drove the target
   * to the foreground. Passed through to safe.keyboardTarget to bypass the
   * foreground==true fluent check (which can race with foreground-stealing protection
   * between the post-focus EnumWindows and the guard's own snapshot). Other gates
   * (identity, modal, dirty watermark, focused element) still run.
   */
  foregroundVerified?: boolean;
  /** Phase F: browser readiness policy (v3 §4.2, §12.3). Forwarded to evalBrowserReady. */
  browserReadinessPolicy?: "strict" | "selectorInViewport" | "navigationGate";
  /** Phase F: true when target selector was resolved in-viewport (browser_click). */
  browserSelectorInViewport?: boolean;
  /**
   * Phase G: caller-supplied args to carry into SuggestedFix (text, selector, name, automationId…).
   * Merged into fix.args so the LLM can re-approve with the original intent.
   */
  fixCarryingArgs?: Record<string, unknown>;
  /**
   * ADR-023 Phase 1: suppress the on-block SuggestedFix + `fixId=…` hint. Set by
   * callers whose re-invocation path does NOT consume `fixId` and is idempotent,
   * so a fixId promise would be dead. browser_click({by,pattern}) is such a
   * caller — the resolver re-gathers fresh on every call, so the agent simply
   * retries the same semantic request (no fixId re-approval needed).
   */
  suppressSuggestedFix?: boolean;
}

export interface ActionGuardResult {
  summary: AutoGuardEnvelope;
  block: boolean;
  suggestedFix?: SuggestedFix;
}

export type { SuggestedFix };
export { resolveFix, consumeFix } from "../engine/perception/suggested-fix-store.js";
import { resolveFix } from "../engine/perception/suggested-fix-store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase G: fixId fingerprint re-validation
// ─────────────────────────────────────────────────────────────────────────────

export interface FixRevalidationResult {
  ok: boolean;
  errorCode?: "FixNotFoundOrExpired" | "FixToolMismatch" | "FixAlreadyConsumed" | "FixTargetMismatch";
  fix?: SuggestedFix;
}

/**
 * Resolve and validate a fixId for a given tool name.
 * Checks: existence+TTL, tool match, consumed, and targetFingerprint (v3 §7.2 rule 3).
 * The fix is NOT consumed here — callers must call consumeFix() after execution.
 */
export function validateAndPrepareFix(
  fixId: string,
  expectedTool: SuggestedFix["tool"]
): FixRevalidationResult {
  const fix = resolveFix(fixId);
  if (!fix) return { ok: false, errorCode: "FixNotFoundOrExpired" };
  if (fix.tool !== expectedTool) return { ok: false, errorCode: "FixToolMismatch" };
  if (fix.consumed) return { ok: false, errorCode: "FixAlreadyConsumed" };
  // v3 §7.2 rule 3: fingerprint must still match
  if (!revalidateFingerprint(fix)) return { ok: false, errorCode: "FixTargetMismatch" };
  return { ok: true, fix };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint revalidation — v3 §7.2 rule 3
// ─────────────────────────────────────────────────────────────────────────────

function revalidateFingerprint(fix: SuggestedFix): boolean {
  const fp = fix.targetFingerprint;
  try {
    if (fp.kind === "window") {
      // For window fingerprints: check that the stored hwnd still belongs to the
      // same process (pid + processStartTimeMs). This prevents applying a fix to
      // a window that happened to get the same HWND after the original process closed.
      if (!fp.hwnd || (fp.pid === undefined && fp.processStartTimeMs === undefined)) {
        return true;  // no identity info → allow guard to re-check
      }
      const pid = getWindowProcessId(BigInt(fp.hwnd));
      if (pid === 0) return false;  // window gone (GetWindowThreadProcessId leaves pidOut[0]=0 on failure)
      if (fp.pid !== undefined && pid !== fp.pid) return false;  // different PID
      if (fp.processStartTimeMs !== undefined && fp.pid !== undefined) {
        const identity = getProcessIdentityByPid(pid);
        if (identity.processStartTimeMs !== fp.processStartTimeMs) return false;
      }
      return true;
    }
    if (fp.kind === "browserTab") {
      // For browser tab fingerprints: can't synchronously verify without CDP.
      // Allow; the subsequent runActionGuard will catch identity drift via target.identityStable.
      return true;
    }
    return true;
  } catch {
    // If OS calls fail (e.g. process already gone), treat as mismatch
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Env flag
// ─────────────────────────────────────────────────────────────────────────────

// The predicate itself lives in a leaf module so `_resolve-log.ts` can read it
// without importing this file (which would close a cycle through
// `action-target.ts`). Re-exported here so every existing caller is unchanged.
export { isAutoGuardEnabled } from "../utils/auto-guard-env.js";

// Log once at startup (called from index.ts bootstrap)
export function logAutoGuardStartup(): void {
  const enabled = isAutoGuardEnabled();
  process.stderr.write(`[auto-guard] enabled=${enabled}${enabled ? "" : " (set DESKTOP_TOUCH_AUTO_GUARD=0 to disable)"}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Next-step messages per status
// ─────────────────────────────────────────────────────────────────────────────

function nextStepFor(
  status: AutoGuardEnvelope["status"],
  target?: string
): string {
  switch (status) {
    case "ok":
      return "";
    case "unguarded":
      return "Pass windowTitle for guarded action";
    case "ambiguous_target":
      return `Call desktop_discover or pass a more specific windowTitle${target ? ` (matched: ${target})` : ""}`;
    case "target_not_found":
      return "Call desktop_discover to verify the window title, then retry";
    case "identity_changed":
      return "Target window was replaced. Take a new screenshot.";
    case "blocked_by_modal":
      return "A modal is blocking. Close it first.";
    case "unsafe_coordinates":
      return "Click coordinates are outside the target window rect. Take a new screenshot.";
    case "browser_not_ready":
      return "Browser tab is not ready. Wait and retry.";
    case "needs_escalation":
      return "Use browser_click or specify windowTitle for this action.";
    case "destination_required":
      return "Pass windowTitle or hwnd — keyboard input needs an explicit destination window (set DESKTOP_TOUCH_REQUIRE_DESTINATION=0 to downgrade this stop to a warning)";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-038 — DestinationRequired
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a keyboard write has no usable destination. Surfaced as `context.reason`
 * and on the Phase 0 diagnostic event, because the two cases need different
 * recovery: one caller named nothing, the other named a window that keyboard
 * delivery cannot reach yet.
 */
export type DestinationMissReason = "no_destination" | "titleless_hwnd_not_foreground";

/**
 * What `resolveWindowTarget` settled on, when it resolved anything.
 * `isForeground` is LAZY — consulted only for a titleless resolution, so the
 * common path costs no extra syscall.
 */
export interface ResolvedDestination {
  hwnd: bigint;
  title: string;
  isForeground: () => boolean;
}

/**
 * The verdict of {@link keyboardDestinationMiss}. `miss` is the refusal reason,
 * or `null` when the write does have a destination — in which case `note` may
 * still flag that the destination was accepted on weaker grounds than usual.
 */
export type DestinationVerdict =
  | { miss: DestinationMissReason }
  | { miss: null; note?: "titleless_foreground" };

/**
 * Warning pushed onto `hints.warnings` when a titleless window is accepted
 * because it is the foreground one. The delivery is honest — the keys go where
 * the caller pointed — but it is NOT guarded: focus is skipped and the auto-guard
 * descriptor is null, so no identity check runs, and the window could in
 * principle stop being foreground between the check and `SendInput`. The
 * contract for this ADR is "never a silent pass", and that applies to a pass
 * this thin just as much as to the env downgrade (Opus review R3).
 */
export const TITLELESS_FOREGROUND_WARNING =
  "Target window has no title and is addressed by hwnd while in the foreground — " +
  "delivered unguarded (no identity guard; keyboard focus/guard cannot yet target " +
  "titleless windows, see ADR-036)";

/**
 * Does this title actually name a window?
 *
 * Presence is decided on the TRIMMED title, because `focusWindowForKeyboard`
 * matches by case-insensitive SUBSTRING: `windowTitle: " "` is a non-empty
 * string, so it used to pass the check, and then matched the first window whose
 * title happens to contain a space — an arbitrary target, which is the accident
 * this ADR exists to prevent, reached through a value that merely looks like a
 * target (Codex review R4).
 *
 * Only PRESENCE is trimmed. The title itself continues downstream untouched, so
 * `" Notepad "` still matches exactly what it matched before — deciding whether
 * a caller named something is a separate question from what they named.
 */
function namesAWindow(title: string | undefined): boolean {
  return typeof title === "string" && title.trim() !== "";
}

/**
 * The destination predicate, as one function so no caller re-derives it.
 *
 * **A handle is not automatically a destination.** Everything downstream of the
 * check is driven by the resolved TITLE — focus runs under
 * `if (effectiveWindowTitle)`, and the guard descriptor is
 * `effectiveWindowTitle ? {kind:"window",...} : null`. An `hwnd` that resolves
 * to a titleless window is therefore neither focused nor guarded, and the keys
 * still land on the foreground; accepting it on the strength of the parameter
 * alone would have re-opened this ADR's own hole one argument later (Codex
 * review R1). The one case where a titleless resolution is honest is when that
 * window is ALREADY the foreground — then delivery lands exactly where the
 * caller pointed, which is the legitimate `@active` case. That pass is reported
 * back as `note: "titleless_foreground"` so the caller can warn about what it
 * did not get (no focus, no identity guard). Making focus and the guard
 * hwnd-aware, so titled-ness stops mattering, is ADR-036.
 */
export function keyboardDestinationMiss(p: {
  effectiveWindowTitle: string | undefined;
  resolved: ResolvedDestination | undefined;
}): DestinationVerdict {
  const { effectiveWindowTitle, resolved } = p;
  if (namesAWindow(effectiveWindowTitle)) return { miss: null };
  if (resolved === undefined) return { miss: "no_destination" };
  // `namesAWindow(resolved.title)` is redundant with the check above in practice
  // (the handlers adopt the resolved title into `effectiveWindowTitle`); kept so
  // the predicate reads correctly on its own. A whitespace-only resolved title
  // is treated exactly like `""` — it is equally unusable downstream, so it
  // falls into the titleless-foreground rule rather than passing.
  if (namesAWindow(resolved.title)) return { miss: null };
  if (resolved.isForeground()) return { miss: null, note: "titleless_foreground" };
  return { miss: "titleless_hwnd_not_foreground" };
}

/** Warning text pushed onto `hints.warnings` when the stop is downgraded. */
export function destinationDowngradeWarning(reason: DestinationMissReason): string {
  const head = "DestinationRequired downgraded to a warning by DESKTOP_TOUCH_REQUIRE_DESTINATION=0 — ";
  return reason === "no_destination"
    ? head +
      "input will land on the current foreground window; pass windowTitle or hwnd to target explicitly"
    : head +
      "the window addressed by hwnd has no title and is not in the foreground, so input will land " +
      "on the current foreground window instead; bring it to the foreground first or target a titled window";
}

function destinationBlockMessage(toolName: string, reason: DestinationMissReason): string {
  return reason === "no_destination"
    ? `${toolName} requires a destination window: pass windowTitle or hwnd ` +
      "(an empty or whitespace-only windowTitle does not name one)"
    : `${toolName}: the window addressed by hwnd has no title and is not in the foreground — ` +
      "keyboard delivery cannot yet target titleless windows (ADR-036); bring it to the " +
      "foreground first (focus_window) or target a titled window";
}

export type DestinationCheck =
  | { ok: true }
  | { ok: false; errorResult: ToolResult };

/**
 * ADR-038 — refuse a keyboard write that has no destination the input can
 * actually be steered to.
 *
 * Without `windowTitle` / `hwnd` the descriptor handed to `runActionGuard` is
 * `null`, which that function answers with `unguarded` + pass-through: no guard,
 * no focus, and `SendInput` lands on whatever window happens to be foreground at
 * that instant. On 2026-08-18 that put an LLM's keystrokes into the user's own
 * input box.
 *
 * This check must be called BEFORE the `if (lensId) ... else if (isAutoGuardEnabled())`
 * split in each handler, not from inside `evaluateKeyboardGuards`: those arms are
 * EXCLUSIVE, so a call carrying a lensId but no destination never reaches
 * `runActionGuard` at all. One call, before the split, is what closes both arms.
 *
 * The destination rule itself lives in {@link keyboardDestinationMiss} — read
 * that first; the flash branch in `keyboard.ts` shares it.
 *
 * Contract (ADR-038 §2):
 *   - a destination is a non-empty resolved `windowTitle`, or a resolved window
 *     that is titleless but currently in the foreground.
 *   - `DESKTOP_TOUCH_AUTO_GUARD=0` is a complete kill of the guard layer, this
 *     check included.
 *   - `DESKTOP_TOUCH_REQUIRE_DESTINATION=0` downgrades the stop to a warning —
 *     never to a silent pass.
 */
export function assertKeyboardDestination(p: {
  toolName: "keyboard:type" | "keyboard:press" | "keyboard:sequence";
  /** Title after the fixId / resolveWindowTarget prologue has run. */
  effectiveWindowTitle: string | undefined;
  /**
   * The public `hwnd` param exactly as the caller passed it. Recorded on the
   * diagnostic event ONLY — deliberately not part of the pass/fail decision,
   * see {@link keyboardDestinationMiss}.
   */
  hwnd: string | undefined;
  /** What the resolver settled on, when it resolved anything. */
  resolved: ResolvedDestination | undefined;
  lensId: string | undefined;
  /** Downgrade warning is pushed here; the caller surfaces it as `hints.warnings`. */
  warnings: string[];
}): DestinationCheck {
  const { toolName, effectiveWindowTitle, hwnd, resolved, lensId, warnings } = p;

  const verdict = keyboardDestinationMiss({ effectiveWindowTitle, resolved });
  if (verdict.miss === null) {
    // Accepted, but say so when the acceptance was thin. No diagnostic event:
    // this is not a destination MISS, and counting it would blur what the
    // Phase 0 sample measures.
    if (verdict.note === "titleless_foreground") warnings.push(TITLELESS_FOREGROUND_WARNING);
    return { ok: true };
  }
  const reason = verdict.miss;

  const emit = (decision: "block" | "warn" | "unguarded"): void => {
    noteDestinationMissing(toolName, {
      hasLens: lensId !== undefined,
      hadHwndParam: hwnd !== undefined,
      reason,
      decision,
    });
  };

  // Phase 0 counter fires for every destination-less call — including the ones
  // that are then allowed through — so the dogfood sample measures legitimate
  // destination-less usage, not just the refusals.
  if (!isAutoGuardEnabled()) {
    emit("unguarded");
    return { ok: true };
  }

  if (process.env.DESKTOP_TOUCH_REQUIRE_DESTINATION === "0") {
    emit("warn");
    warnings.push(destinationDowngradeWarning(reason));
    return { ok: true };
  }

  emit("block");
  return {
    ok: false,
    errorResult: failCode(
      "DestinationRequired",
      destinationBlockMessage(toolName, reason),
      {
        suggest: getSuggestsForCode("DestinationRequired"),
        context: {
          tool: toolName,
          reason,
          guard: {
            kind: "auto",
            status: "destination_required",
            canContinue: false,
            next: nextStepFor("destination_required"),
          },
        },
      }
    ),
  };
}

export function noteDestinationMissing(
  toolName: "keyboard:type" | "keyboard:press" | "keyboard:sequence",
  opts: {
    hasLens: boolean;
    hadHwndParam: boolean;
    reason: DestinationMissReason;
    decision: "block" | "warn" | "unguarded";
  }
): void {
  logDiagnostic({
    kind: "destination_missing",
    tool: toolName,
    hasLens: opts.hasLens,
    hadHwndParam: opts.hadHwndParam,
    reason: opts.reason,
    decision: opts.decision,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SuggestedFix builder — emits fix for recoverable drift
// ─────────────────────────────────────────────────────────────────────────────

import type { ResolveActionTargetResult } from "../engine/perception/action-target.js";
import type { TargetFingerprint } from "../engine/perception/suggested-fix-store.js";

function buildWindowFingerprint(
  descriptor: ActionTargetDescriptor,
  resolved: ResolveActionTargetResult
): TargetFingerprint | null {
  if (!resolved.lens) return null;
  const hwnd = resolved.lens.binding.hwnd;
  const identity = resolved.identity as WindowIdentity | null;
  const dKey = descriptor.kind === "window"
    ? `window:${descriptor.titleIncludes.toLowerCase()}`
    : descriptor.kind === "coordinate"
      ? `window:${(descriptor.windowTitle ?? "").toLowerCase()}`
      : null;
  if (!dKey) return null;
  return {
    kind: "window",
    descriptorKey: dKey,
    hwnd,
    ...(identity?.pid !== undefined && { pid: identity.pid }),
    ...(identity?.processStartTimeMs !== undefined && { processStartTimeMs: identity.processStartTimeMs }),
  };
}

function buildBrowserTabFingerprint(
  descriptor: ActionTargetDescriptor,
  resolved: ResolveActionTargetResult
): TargetFingerprint | null {
  if (!resolved.lens) return null;
  const tabIdentity = resolved.identity as import("../engine/perception/types.js").BrowserTabIdentity | null;
  const dKey = descriptor.kind === "browserTab"
    ? `browserTab:${descriptor.tabId ?? descriptor.urlIncludes ?? "?"}`
    : null;
  if (!dKey) return null;
  return {
    kind: "browserTab",
    descriptorKey: dKey,
    tabId: tabIdentity?.tabId,
    url:   tabIdentity?.url,
  };
}

function windowTitleOf(descriptor: ActionTargetDescriptor): string | undefined {
  if (descriptor.kind === "window") return descriptor.titleIncludes;
  if (descriptor.kind === "coordinate") return descriptor.windowTitle;
  return undefined;
}

function tryBuildSuggestedFix(
  gr: GuardEvalResult,
  descriptor: ActionTargetDescriptor,
  resolved: ResolveActionTargetResult,
  actionKind: ActionKind,
  clickCoordinates?: { x: number; y: number },
  fixCarryingArgs?: Record<string, unknown>
): Omit<SuggestedFix, "fixId" | "createdAtMs" | "expiresAtMs" | "consumed"> | null {
  const failedKind = gr.failedGuard?.kind;
  if (!resolved.lens) return null;

  switch (actionKind) {
    case "mouseClick":
    case "mouseDrag": {
      if (!clickCoordinates) return null;
      if (descriptor.kind !== "window" && descriptor.kind !== "coordinate") return null;
      const fp = buildWindowFingerprint(descriptor, resolved);
      if (!fp) return null;
      const fixArgs: Record<string, unknown> = {
        x: clickCoordinates.x,
        y: clickCoordinates.y,
        ...(descriptor.kind === "window" && { windowTitle: descriptor.titleIncludes }),
        ...(descriptor.kind === "coordinate" && descriptor.windowTitle && { windowTitle: descriptor.windowTitle }),
        ...(fixCarryingArgs ?? {}),
      };
      if (failedKind === "safe.clickCoordinates") {
        return { tool: "mouse_click", args: fixArgs, targetFingerprint: fp,
          reason: `Click at (${clickCoordinates.x}, ${clickCoordinates.y}) is outside window rect. Guard detected coordinate drift.` };
      }
      if (failedKind === "target.identityStable" && resolved.changed?.includes("identity")) {
        return { tool: "mouse_click", args: fixArgs, targetFingerprint: fp,
          reason: `Target window identity changed (process restarted or HWND replaced). Fix retries with new identity.` };
      }
      return null;
    }

    case "keyboard": {
      const fp = buildWindowFingerprint(descriptor, resolved);
      if (!fp) return null;
      const title = windowTitleOf(descriptor);
      if (!title) return null;
      const fixArgs = { windowTitle: title, ...(fixCarryingArgs ?? {}) };
      if (failedKind === "target.identityStable" && resolved.changed?.includes("identity")) {
        return { tool: "keyboard", args: fixArgs, targetFingerprint: fp,
          reason: `Keyboard target identity changed. Approve to re-type into new identity.` };
      }
      if (failedKind === "safe.keyboardTarget") {
        return { tool: "keyboard", args: fixArgs, targetFingerprint: fp,
          reason: `Keyboard target verification failed (foreground/modal drift). Approve to retry.` };
      }
      return null;
    }

    case "uiaInvoke":
    case "uiaSetValue": {
      const fp = buildWindowFingerprint(descriptor, resolved);
      if (!fp) return null;
      const title = windowTitleOf(descriptor);
      if (!title) return null;
      const fixArgs = { windowTitle: title, ...(fixCarryingArgs ?? {}) };
      if (failedKind === "target.identityStable" && resolved.changed?.includes("identity")) {
        return { tool: "click_element", args: fixArgs, targetFingerprint: fp,
          reason: `UIA target identity changed. Approve to retry with new identity.` };
      }
      return null;
    }

    case "browserCdp": {
      const fp = buildBrowserTabFingerprint(descriptor, resolved);
      if (!fp) return null;
      const fixArgs = { ...(fixCarryingArgs ?? {}) };
      if (failedKind === "target.identityStable" && resolved.changed?.includes("identity")) {
        return { tool: "browser_click", args: fixArgs, targetFingerprint: fp,
          reason: `Browser tab identity changed. Approve to retry.` };
      }
      if (failedKind === "browser.ready") {
        return { tool: "browser_click", args: fixArgs, targetFingerprint: fp,
          reason: `Browser tab not ready. Approve to retry when ready.` };
      }
      return null;
    }

    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard result → AutoGuardEnvelope map
// ─────────────────────────────────────────────────────────────────────────────

function mapGuardResult(
  gr: GuardEvalResult,
  target?: string
): ActionGuardResult {
  if (gr.ok) {
    return {
      summary: {
        kind: "auto",
        status: "ok",
        canContinue: true,
        ...(target && { target }),
        next: "",
      },
      block: false,
    };
  }

  const failedKind = gr.failedGuard?.kind;
  let status: AutoGuardEnvelope["status"] = "unsafe_coordinates";

  if (failedKind === "safe.keyboardTarget") {
    status = "needs_escalation";
  } else if (failedKind === "target.identityStable") {
    status = "identity_changed";
  } else if (failedKind === "browser.ready") {
    status = "browser_not_ready";
  } else if (failedKind === "safe.clickCoordinates") {
    status = "unsafe_coordinates";
  }
  // A guard may know its failure means something the kind alone does not convey
  // — an unreadable rect is a missing window, not a misplaced click.
  if (gr.failedGuard?.statusOverride) {
    status = gr.failedGuard.statusOverride;
  }
  // modal guard is not in GUARD_KINDS, so guard won't fire for it in Phase A

  const shouldBlock = gr.policy === "block";
  return {
    summary: {
      kind: "auto",
      status,
      canContinue: !shouldBlock,
      ...(target && { target }),
      next: nextStepFor(status, target),
    },
    block: shouldBlock,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runActionGuard — called directly by mouse.ts (manual coord ordering)
// ─────────────────────────────────────────────────────────────────────────────

export async function runActionGuard(
  params: RunActionGuardParams
): Promise<ActionGuardResult> {
  const { toolName, actionKind, descriptor, clickCoordinates, foregroundVerified, browserReadinessPolicy, browserSelectorInViewport, fixCarryingArgs, suppressSuggestedFix } = params;

  // Env flag OFF → unguarded pass-through
  if (!isAutoGuardEnabled()) {
    return {
      summary: { kind: "auto", status: "unguarded", canContinue: true, next: "" },
      block: false,
    };
  }

  // No descriptor → unguarded (windowTitle not provided)
  if (!descriptor) {
    return {
      summary: {
        kind: "auto",
        status: "unguarded",
        canContinue: true,
        next: nextStepFor("unguarded"),
      },
      block: false,
    };
  }

  // browserTab + keyboard → needs_escalation
  if (
    descriptor.kind === "browserTab" &&
    (actionKind === "keyboard")
  ) {
    return {
      summary: {
        kind: "auto",
        status: "needs_escalation",
        canContinue: false,
        next: nextStepFor("needs_escalation"),
      },
      block: true,
    };
  }

  // Resolve target
  const resolved = await resolveActionTarget(descriptor, {
    actionKind,
    coordinate: clickCoordinates,
  });

  if (resolved.warnings.length > 0) {
    process.stderr.write(`[auto-guard] ${toolName}: ${resolved.warnings.join("; ")}\n`);
  }

  // No candidates → target not found
  if (resolved.candidates === 0 || !resolved.lens || !resolved.localStore) {
    const status: AutoGuardEnvelope["status"] = "target_not_found";
    // descriptor is non-null at this point (null-checked above)
    const closedKey = deriveTargetKey(descriptor);
    if (closedKey) {
      appendEvent({ targetKey: closedKey, identity: null, source: "action_guard", semantic: "target_closed", tool: toolName, summary: "Target not found after prior resolution" });
    }
    return {
      summary: {
        kind: "auto",
        status,
        canContinue: false,
        next: nextStepFor(status),
      },
      block: true,
    };
  }

  // D-2: Emit target_bound on first resolution for this descriptor
  const targetKey = deriveTargetKey(descriptor);
  if (targetKey) {
    if (resolved.isNewTarget) {
      appendEvent({ targetKey, identity: resolved.identity, source: "action_guard", semantic: "target_bound", tool: toolName, summary: `Bound to ${targetKey}` });
    }
    // Emit change events from HotTargetCache changed flags
    if (resolved.changed) {
      const changeMap: Record<string, Parameters<typeof appendEvent>[0]["semantic"]> = {
        rect:      "rect_changed",
        title:     "title_changed",
        identity:  "identity_changed",
        navigation:"navigation",
        foreground:"foreground_changed",
      };
      for (const c of resolved.changed) {
        const sem = changeMap[c];
        if (sem) appendEvent({ targetKey, identity: resolved.identity, source: "action_guard", semantic: sem, tool: toolName, summary: `${c} changed` });
      }
    }
  }

  // Ambiguous (multiple windows) — v3 §4.1 step 4: keyboard/UIA fail closed, mouse uses coord disambiguation
  if (resolved.candidates > 1) {
    if (
      actionKind === "keyboard" ||
      actionKind === "uiaInvoke" ||
      actionKind === "uiaSetValue"
    ) {
      // Cannot safely pick one for keyboard/UIA → block
      return {
        summary: {
          kind: "auto",
          status: "ambiguous_target",
          canContinue: false,
          next: nextStepFor("ambiguous_target"),
        },
        block: true,
      };
    }
    // For mouseClick with coordinates, the coordinate already disambiguated (resolveCoordinateTarget picks by containment)
    // Warnings already logged above
  }

  // Evaluate guards
  const ctx = {
    toolName,
    clickX: clickCoordinates?.x,
    clickY: clickCoordinates?.y,
    ...(foregroundVerified !== undefined && { foregroundVerified }),
    ...(browserReadinessPolicy !== undefined && { browserReadinessPolicy }),
    ...(browserSelectorInViewport !== undefined && { browserSelectorInViewport }),
  };

  const targetLabel =
    descriptor.kind === "window"
      ? `window:${descriptor.titleIncludes}`
      : descriptor.kind === "browserTab"
        ? `browserTab:${descriptor.urlIncludes ?? descriptor.titleIncludes ?? descriptor.tabId ?? "?"}`
        : `coordinate:${descriptor.x},${descriptor.y}`;

  // D-2: Emit action_attempted before guard evaluation
  if (targetKey) {
    appendEvent({ targetKey, identity: resolved.identity, source: "action_guard", semantic: "action_attempted", tool: toolName, summary: `${toolName} attempted` });
  }

  const gr = evaluateGuards(
    resolved.lens,
    resolved.localStore,
    resolved.lens.spec.guardPolicy,
    ctx
  );

  const result = mapGuardResult(gr, targetLabel);

  // D-2: Emit action_blocked when guard blocks
  if (result.block && targetKey) {
    const reason = gr.failedGuard?.reason ?? gr.failedGuard?.kind ?? "unknown guard";
    appendEvent({ targetKey, identity: resolved.identity, source: "action_guard", semantic: "action_blocked", tool: toolName, result: "blocked", summary: `${toolName} blocked: ${reason}` });
  }
  if (!result.block) {
    result.summary.target = targetLabel;
  }
  // Propagate changed flags from HotTargetCache (Phase B)
  if (resolved.changed && resolved.changed.length > 0) {
    result.summary.changed = resolved.changed;
  }

  // Phase C/G: emit SuggestedFix when a recoverable drift is detected.
  // ADR-023 Phase 1: callers with an idempotent, fixId-less re-invocation path
  // (browser_click by-axis) suppress this — a fixId hint they cannot honor would
  // be a dead promise (Opus PR3 Round 1 P2).
  // A fix is a one-call re-approval of the SAME action. Offering one for a
  // target whose rectangle could not be read invites the caller to re-approve a
  // click into a window that is not there; the recovery is a fresh screenshot,
  // which the status already asks for.
  const targetMissing = gr.failedGuard?.statusOverride === "identity_changed";
  if (result.block && !suppressSuggestedFix && !targetMissing) {
    const fix = tryBuildSuggestedFix(
      gr,
      descriptor,
      resolved,
      actionKind,
      clickCoordinates,
      fixCarryingArgs
    );
    if (fix) {
      const stored = storeFix(fix);
      result.suggestedFix = stored;
      const toolHint = fix.tool === "mouse_click" ? "mouse_click" : `${fix.tool}`;
      result.summary.next += ` fixId="${stored.fixId}" is available — call ${toolHint}({fixId}) to approve.`;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// withActionGuard — middleware for tools that don't need manual coord ordering
// ─────────────────────────────────────────────────────────────────────────────

export function withActionGuard<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<ToolResult>,
  opts: ActionGuardOptions<T>,
): (args: T) => Promise<ToolResult> {
  return async (args: T): Promise<ToolResult> => {
    // lensId present → delegate entirely to handler (manual lens path)
    if (args.lensId) {
      return handler(args);
    }

    const descriptor = opts.extractTarget(args);
    const coords = opts.coordinateSource?.(args);

    const ag = await runActionGuard({
      toolName,
      actionKind: opts.actionKind,
      descriptor,
      clickCoordinates: coords,
    });

    if (ag.block) {
      return failWith(
        new Error(`AutoGuardBlocked: ${ag.summary.next}`),
        toolName,
        { _perceptionForPost: ag.summary }
      );
    }

    // Run the handler, then attach the guard summary to the result
    const result = await handler(args);
    // Attach summary to outgoing payload so _post.ts can pick it up
    if (result.content && result.content.length > 0) {
      try {
        const block = result.content[0];
        if (block && block.type === "text") {
          const parsed = JSON.parse(block.text) as Record<string, unknown>;
          parsed._perceptionForPost = ag.summary;
          block.text = JSON.stringify(parsed, null, 2);
        }
      } catch {
        // Not JSON — cannot attach, ignore
      }
    }
    return result;
  };
}
