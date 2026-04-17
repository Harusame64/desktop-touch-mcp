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

import { failWith } from "./_errors.js";
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
  /** Phase F: true when target selector was resolved in-viewport (browser_click_element). */
  browserSelectorInViewport?: boolean;
  /**
   * Phase G: caller-supplied args to carry into SuggestedFix (text, selector, name, automationId…).
   * Merged into fix.args so the LLM can re-approve with the original intent.
   */
  fixCarryingArgs?: Record<string, unknown>;
}

export interface ActionGuardResult {
  summary: AutoGuardEnvelope;
  block: boolean;
  suggestedFix?: SuggestedFix;
}

export type { SuggestedFix };
export { resolveFix, consumeFix } from "../engine/perception/suggested-fix-store.js";
import { resolveFix, consumeFix } from "../engine/perception/suggested-fix-store.js";

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
      const { getWindowProcessId, getProcessIdentityByPid } = require("../engine/win32.js") as typeof import("../engine/win32.js");
      const pid = getWindowProcessId(BigInt(fp.hwnd));
      if (pid === null || pid === undefined) return false;  // window gone
      if (fp.pid !== undefined && pid !== fp.pid) return false;  // different PID
      if (fp.processStartTimeMs !== undefined && fp.pid !== undefined) {
        const identity = getProcessIdentityByPid(pid);
        if (!identity || identity.processStartTimeMs !== fp.processStartTimeMs) return false;
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

export function isAutoGuardEnabled(): boolean {
  return process.env.DESKTOP_TOUCH_AUTO_GUARD !== "0";
}

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
      return `Call get_windows or pass a more specific windowTitle${target ? ` (matched: ${target})` : ""}`;
    case "target_not_found":
      return "Call get_windows to verify the window title, then retry";
    case "identity_changed":
      return "Target window was replaced. Take a new screenshot.";
    case "blocked_by_modal":
      return "A modal is blocking. Close it first.";
    case "unsafe_coordinates":
      return "Click coordinates are outside the target window rect. Take a new screenshot.";
    case "browser_not_ready":
      return "Browser tab is not ready. Wait and retry.";
    case "needs_escalation":
      return "Use browser_click_element or specify windowTitle for this action.";
  }
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
        return { tool: "keyboard_type", args: fixArgs, targetFingerprint: fp,
          reason: `Keyboard target identity changed. Approve to re-type into new identity.` };
      }
      if (failedKind === "safe.keyboardTarget") {
        return { tool: "keyboard_type", args: fixArgs, targetFingerprint: fp,
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
        return { tool: "browser_click_element", args: fixArgs, targetFingerprint: fp,
          reason: `Browser tab identity changed. Approve to retry.` };
      }
      if (failedKind === "browser.ready") {
        return { tool: "browser_click_element", args: fixArgs, targetFingerprint: fp,
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
  const { toolName, actionKind, descriptor, clickCoordinates, foregroundVerified, browserReadinessPolicy, browserSelectorInViewport, fixCarryingArgs } = params;

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

  // Phase C/G: emit SuggestedFix when a recoverable drift is detected
  if (result.block) {
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
