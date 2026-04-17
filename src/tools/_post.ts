/**
 * _post.ts — Post-state narration helper + action history ring buffer.
 *
 * Phase 2.1 of anti-fukuwarai-ideals-plan.md.
 * Adds a small `post` block to action tool responses so the LLM can decide
 * its next move without taking a confirmation screenshot.
 *
 * Phase 3.1 extension: focusedElement is now populated from UIA
 * (getFocusedAndPointInfo) instead of being hard-coded to null.
 * A short timeout (800 ms) prevents this from blocking fast actions.
 *
 * Also maintains a ring buffer of recent action posts for get_history().
 */

import { enumWindowsInZOrder, getWindowProcessId, getProcessIdentityByPid } from "../engine/win32.js";
import { getFocusedAndPointInfo } from "../engine/uia-bridge.js";
import type { ToolResult } from "./_types.js";
import type { RichBlock } from "../engine/uia-diff.js";
import type { PerceptionEnvelope, PostPerception } from "../engine/perception/types.js";
import { appendEvent } from "../engine/perception/target-timeline.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PostElementInfo {
  name: string;
  type: string;
  value?: string;
  automationId?: string;
}

export interface PostState {
  focusedWindow: string | null;
  /** UIA-derived focused element info. Null when UIA is unavailable or timed out. */
  focusedElement: PostElementInfo | null;
  windowChanged: boolean;
  elapsedMs: number;
  /** UIA diff block injected by withRichNarration. Stripped before history storage. */
  rich?: RichBlock;
  /** RPG perception envelope injected via _perceptionForPost. Stripped before history storage. */
  perception?: PostPerception;
}

export interface HistoryEntry {
  tool: string;
  argsDigest: string;
  ok: boolean;
  errorCode?: string;
  post: Omit<PostState, "rich" | "perception">;
  tsMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// History ring buffer
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_MAX = 20;
const history: HistoryEntry[] = [];

export function recordHistory(entry: HistoryEntry): void {
  history.push(entry);
  while (history.length > HISTORY_MAX) history.shift();
}

export function getHistorySnapshot(n = 5): HistoryEntry[] {
  return history.slice(-Math.max(1, Math.min(n, HISTORY_MAX)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Capture the current foreground window. Cheap (~1 EnumWindows call). */
function snapshotFocus(): { title: string | null; hwnd: string | null; processName: string } {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    if (!fg) return { title: null, hwnd: null, processName: "" };
    const pid = getWindowProcessId(fg.hwnd);
    const ident = getProcessIdentityByPid(pid);
    return { title: fg.title, hwnd: String(fg.hwnd), processName: ident.processName };
  } catch {
    return { title: null, hwnd: null, processName: "" };
  }
}

/**
 * Best-effort: call getFocusedAndPointInfo with a tight timeout.
 * Returns null on timeout or error — never throws.
 */
async function snapshotFocusedElement(): Promise<PostElementInfo | null> {
  try {
    const { focused } = await getFocusedAndPointInfo(0, 0, false, 800);
    if (!focused?.name) return null;
    const info: PostElementInfo = { name: focused.name, type: focused.controlType };
    if (focused.automationId) info.automationId = focused.automationId;
    if (focused.value != null) info.value = focused.value;
    return info;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// withPostState
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an action handler so its response is augmented with a `post` block.
 * Records a history entry as a side effect.
 *
 * windowChanged compares the foreground BEFORE the handler ran with AFTER —
 * so it reflects whether the action itself moved focus, not background drift.
 */
export function withPostState<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<ToolResult>
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    const startedAt = Date.now();
    const before = snapshotFocus();
    const result = await handler(args);
    try {
      const after = snapshotFocus();
      const focusedElement = await snapshotFocusedElement();
      const windowChanged = !!after.hwnd && !!before.hwnd && after.hwnd !== before.hwnd;
      const post: PostState = {
        focusedWindow: after.title,
        focusedElement,
        windowChanged,
        elapsedMs: Date.now() - startedAt,
      };

      // Splice post into the JSON text block of the result — but ONLY for success
      // shapes. Failures keep their { ok:false, code, suggest } shape pristine.
      let okFlag = true;
      let errorCode: string | undefined;
      const block = result.content[0];
      if (block && block.type === "text") {
        let parsed: unknown;
        try { parsed = JSON.parse(block.text); } catch { /* not JSON, skip */ }
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          if (obj.ok === false) {
            okFlag = false;
            errorCode = typeof obj.code === "string" ? obj.code : undefined;
            // Attach post.perception on failure if handler set _perceptionForPost.
            // This lets LLMs recover from guard blocks using post.perception.next.
            if (obj._perceptionForPost !== null && typeof obj._perceptionForPost === "object") {
              const failurePost: PostState = {
                focusedWindow: after.title,
                focusedElement: null,
                windowChanged: !!after.hwnd && !!before.hwnd && after.hwnd !== before.hwnd,
                elapsedMs: Date.now() - startedAt,
                perception: obj._perceptionForPost as PostPerception,
              };
              obj.post = failurePost;
              delete obj._perceptionForPost;
              block.text = JSON.stringify(obj, null, 2);
            }
          } else {
            obj.post = post;
            // If the handler injected a CDP-sourced rich block via _richForPost,
            // move it into post.rich and remove the temporary key.
            // Convention: browser handlers set result._richForPost = RichBlock before returning.
            if (
              obj._richForPost !== null &&
              typeof obj._richForPost === "object" &&
              Array.isArray((obj._richForPost as Record<string, unknown>).appeared)
            ) {
              post.rich = obj._richForPost as RichBlock;
              delete obj._richForPost;
            }
            // RPG perception envelope — handlers set _perceptionForPost on success.
            if (obj._perceptionForPost !== null && typeof obj._perceptionForPost === "object") {
              post.perception = obj._perceptionForPost as PerceptionEnvelope;
              delete obj._perceptionForPost;

              // D-4: Emit action_succeeded and optionally foreground_changed timeline events
              const percAny = post.perception as unknown as Record<string, unknown>;
              const targetStr = typeof percAny.target === "string" ? percAny.target : null;
              if (targetStr) {
                appendEvent({ targetKey: targetStr, identity: null, source: "post_check", semantic: "action_succeeded", tool: toolName, result: "ok", summary: `${toolName} succeeded` });
              }
            }
            // D-4: foreground_changed when window focus moved between actions
            if (windowChanged && before.hwnd && after.hwnd) {
              // Use the after-window title as the target key approximation
              const afterKey = after.title ? `window:${after.title.toLowerCase().trim()}` : null;
              if (afterKey) {
                appendEvent({ targetKey: afterKey, identity: null, source: "post_check", semantic: "foreground_changed", tool: toolName, summary: `Focus moved to ${after.title}` });
              }
            }
            block.text = JSON.stringify(obj, null, 2);
          }
        }
      }

      // Strip rich and perception blocks from history to avoid bloating the ring buffer.
      const { rich: _rich, perception: _perception, ...postForHistory } = post;
      recordHistory({
        tool: toolName,
        argsDigest: digest(args),
        ok: okFlag,
        ...(errorCode ? { errorCode } : {}),
        post: postForHistory,
        tsMs: Date.now(),
      });
    } catch {
      // Don't let post-narration failure leak.
    }
    return result;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function digest(args: Record<string, unknown>): string {
  try {
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string" && v.length > 60) trimmed[k] = v.slice(0, 60) + "…";
      else if (v !== null && typeof v === "object") trimmed[k] = "<object>";
      else trimmed[k] = v;
    }
    return JSON.stringify(trimmed);
  } catch {
    return "<args>";
  }
}
