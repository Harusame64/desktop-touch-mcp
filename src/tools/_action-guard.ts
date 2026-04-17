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
  guardPolicy?: "block" | "warn";
  forbidBrowserTabForKeyboard?: boolean;
}

export interface RunActionGuardParams {
  toolName: string;
  actionKind: ActionKind;
  descriptor: ActionTargetDescriptor | null;
  clickCoordinates?: { x: number; y: number };
  guardPolicy?: "block" | "warn";
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
}

export interface ActionGuardResult {
  summary: AutoGuardEnvelope;
  block: boolean;
  suggestedFix?: SuggestedFix;
}

export type { SuggestedFix };

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

function tryBuildSuggestedFix(
  gr: GuardEvalResult,
  descriptor: ActionTargetDescriptor,
  clickCoordinates: { x: number; y: number },
  resolved: ResolveActionTargetResult
): Omit<SuggestedFix, "fixId" | "createdAtMs" | "expiresAtMs" | "consumed"> | null {
  const failedKind = gr.failedGuard?.kind;
  if (descriptor.kind !== "window" && descriptor.kind !== "coordinate") return null;
  if (!resolved.lens) return null;

  const hwnd = resolved.lens.binding.hwnd;
  const identity = resolved.identity as WindowIdentity | null;
  const descriptorKey = descriptor.kind === "window"
    ? `window:${descriptor.titleIncludes.toLowerCase()}`
    : `window:${(descriptor.windowTitle ?? "").toLowerCase()}`;

  const fingerprint: TargetFingerprint = {
    kind: "window",
    descriptorKey,
    hwnd,
    ...(identity?.pid !== undefined && { pid: identity.pid }),
    ...(identity?.processStartTimeMs !== undefined && { processStartTimeMs: identity.processStartTimeMs }),
  };

  const fixArgs: Record<string, unknown> = {
    x: clickCoordinates.x,
    y: clickCoordinates.y,
    ...(descriptor.kind === "window" && { windowTitle: descriptor.titleIncludes }),
    ...(descriptor.kind === "coordinate" && descriptor.windowTitle && { windowTitle: descriptor.windowTitle }),
  };

  // safe.clickCoordinates: coordinates are outside rect — emit fix with same coords
  // LLM approval confirms intent; guard will re-evaluate with fresh state
  if (failedKind === "safe.clickCoordinates") {
    return {
      tool: "mouse_click",
      args: fixArgs,
      targetFingerprint: fingerprint,
      reason: `Click at (${clickCoordinates.x}, ${clickCoordinates.y}) is outside window rect. Guard detected coordinate drift.`,
    };
  }

  // target.identityStable: window replaced — emit fix only if HotTargetCache has rect history
  // (indicates the LLM was working with a known window that changed under it)
  if (failedKind === "target.identityStable" && resolved.changed?.includes("identity")) {
    return {
      tool: "mouse_click",
      args: fixArgs,
      targetFingerprint: fingerprint,
      reason: `Target window identity changed (process restarted or HWND replaced). Fix retries with new identity.`,
    };
  }

  return null;
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
  const { toolName, actionKind, descriptor, clickCoordinates, guardPolicy = "block", foregroundVerified, browserReadinessPolicy, browserSelectorInViewport } = params;

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
    // If the cache had a prior slot for this key, it means the target was closed
    const closedKey = descriptor ? deriveTargetKey(descriptor) : null;
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

  // Phase C: emit SuggestedFix when a recoverable drift is detected
  if (result.block && clickCoordinates && descriptor) {
    const fix = tryBuildSuggestedFix(
      gr,
      descriptor,
      clickCoordinates,
      resolved
    );
    if (fix) {
      const stored = storeFix(fix);
      result.suggestedFix = stored;
      result.summary.next += ` fixId="${stored.fixId}" is available — call mouse_click({fixId}) to approve.`;
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
      guardPolicy: opts.guardPolicy ?? "block",
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
