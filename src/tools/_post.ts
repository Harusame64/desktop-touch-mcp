/**
 * _post.ts — Post-state narration helper + action history ring buffer.
 *
 * Phase 2.1 of anti-fukuwarai-ideals-plan.md.
 * Adds a small `post` block to action tool responses so the LLM can decide
 * its next move without taking a confirmation screenshot.
 *
 * Also maintains a ring buffer of recent action posts for get_history().
 */

import { enumWindowsInZOrder, getWindowProcessId, getProcessIdentityByPid } from "../engine/win32.js";
import type { ToolResult } from "./_types.js";

export interface PostState {
  focusedWindow: string | null;
  focusedElement: string | null;
  windowChanged: boolean;
  elapsedMs: number;
}

export interface HistoryEntry {
  tool: string;
  argsDigest: string;
  ok: boolean;
  errorCode?: string;
  post: PostState;
  tsMs: number;
}

const HISTORY_MAX = 20;
const history: HistoryEntry[] = [];

export function recordHistory(entry: HistoryEntry): void {
  history.push(entry);
  while (history.length > HISTORY_MAX) history.shift();
}

export function getHistorySnapshot(n = 5): HistoryEntry[] {
  return history.slice(-Math.max(1, Math.min(n, HISTORY_MAX)));
}

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
      const windowChanged = !!after.hwnd && !!before.hwnd && after.hwnd !== before.hwnd;
      const post: PostState = {
        focusedWindow: after.title,
        focusedElement: null, // Phase 2.1 keeps this minimal; rich variant lives in get_context()
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
          } else {
            obj.post = post;
            block.text = JSON.stringify(obj, null, 2);
          }
        }
      }

      recordHistory({
        tool: toolName,
        argsDigest: digest(args),
        ok: okFlag,
        ...(errorCode ? { errorCode } : {}),
        post,
        tsMs: Date.now(),
      });
    } catch {
      // Don't let post-narration failure leak.
    }
    return result;
  };
}

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
