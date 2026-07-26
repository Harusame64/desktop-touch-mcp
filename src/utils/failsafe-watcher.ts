/**
 * src/utils/failsafe-watcher.ts — the failsafe background-watcher tick
 * (ADR-030 Phase 1, plan §3.3 W5).
 *
 * Extracted from the inline `setInterval` callback in `server-windows.ts` so
 * the exit gate is unit-testable with every dependency injected.
 *
 * Proposal A: the watcher's `process.exit(1)` only fires while a tool call is
 * actually executing (`getActiveToolCallCount() > 0` — handlers past the
 * failsafe pre-check; see `failsafe-wrap.ts`). While idle, the server stays
 * up: the per-tool gate refuses new calls and the key-locker background guard
 * suspends the credential flow, so "nothing executes" is preserved without
 * tearing down the MCP session (stdio cannot reconnect).
 *
 * NOTE: the gate input is deliberately NOT the transport-level
 * `inflightIds` — that set counts requests before tool dispatch, so calls the
 * failsafe merely refuses would count as in-flight and an idle corner-park +
 * LLM retry burst would still exit (plan Round 4 Codex P2). The transport
 * count is still logged on the existing `kind:"exit"` line (unchanged
 * semantics, shared with the other exit writers).
 */

import type { DiagnosticEvent } from "../engine/diagnostic-log.js";
import { FailsafeError } from "./failsafe.js";

/** Upper bound on the pre-exit notification await — the exit must not hang on
 *  a stalled notification pipeline (ADR-030 R5 / plan R-P4). */
const NOTIFY_TIMEOUT_MS = 1000;

const EXIT_BALLOON_TITLE = "desktop-touch-mcp: emergency stop";
function exitBalloonBody(holdMs: number): string {
  return (
    "Failsafe triggered while an operation was running: the mouse stayed in the top-left corner " +
    `of the primary monitor for ${holdMs}ms. The MCP server has exited.`
  );
}

export interface FailsafeWatcherDeps {
  /** The shared failsafe probe — `() => checkFailsafe("watcher")` in production
   *  (the "watcher" origin suppresses checkFailsafe's own logging; this tick
   *  owns the watcher-path observability — plan §3.2). */
  checkFailsafe: () => Promise<void>;
  /** Exit-gate input: tool handlers past the pre-check, still executing
   *  (`getActiveToolCallCount` from failsafe-wrap — plan Round 4). */
  getActiveToolCallCount: () => number;
  /** For the existing `kind:"exit"` log line only: transport-level inflight
   *  (`inflightIds.size` — refusals included, per its shutdown-grace semantics). */
  getTransportInflight: () => number;
  /** For the existing `kind:"exit"` log line only (required field). */
  getShutdownPending: () => boolean;
  /** Balloon notifier (`showBalloonTip`). Awaited (bounded) before exit. */
  notify: (title: string, body: string) => Promise<void>;
  logDiagnostic: (e: DiagnosticEvent) => void;
  stopTray: () => void;
  exit: (code: number) => void;
}

/**
 * Build the async tick the server drives every 500 ms. Behaviour:
 *   - probe resolves → clear the armed_idle episode flag; nothing else.
 *   - `FailsafeError` + active tool calls > 0 → notify (≤1 s), console line,
 *     two log lines (new `kind:"failsafe"` with coordinates + the existing
 *     `kind:"exit"` with its unchanged fields), stopTray, exit(1).
 *   - `FailsafeError` + idle → log `armed_idle` once per dwell episode and
 *     keep the server alive.
 *   - any other throw → ignore (matches the previous inline watcher).
 */
export function createFailsafeWatcherTick(deps: FailsafeWatcherDeps): () => Promise<void> {
  // Episode dedup for the idle path: set when armed_idle has been logged for
  // the current dwell episode, cleared on the first tick where the probe
  // resolves (cursor left the corner / dwell restarted).
  let armedIdleLogged = false;

  return async () => {
    try {
      await deps.checkFailsafe();
      armedIdleLogged = false;
    } catch (err) {
      if (!(err instanceof FailsafeError)) return;
      const active = deps.getActiveToolCallCount();
      if (active > 0) {
        // Runaway brake: a tool handler is mid-execution — exit, as before.
        // Notify BEFORE exiting (the spawned balloon child survives the
        // parent), but never let a stalled notifier delay the stop by more
        // than NOTIFY_TIMEOUT_MS.
        await Promise.race([
          deps.notify(EXIT_BALLOON_TITLE, exitBalloonBody(err.holdMs)).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, NOTIFY_TIMEOUT_MS)),
        ]);
        console.error(
          "[desktop-touch] FAILSAFE triggered: mouse at top-left corner of the primary monitor. Exiting."
        );
        deps.logDiagnostic({
          kind: "failsafe",
          event: "triggered",
          origin: "watcher",
          x: err.x,
          y: err.y,
          holdMs: err.holdMs,
          activeToolCalls: active,
        });
        // The existing exit record, unchanged: `inflight` stays the
        // TRANSPORT count (same semantics as every other kind:"exit"
        // writer), `shutdownPending` stays required.
        deps.logDiagnostic({
          kind: "exit",
          trigger: "failsafe",
          exitCode: 1,
          inflight: deps.getTransportInflight(),
          shutdownPending: deps.getShutdownPending(),
        });
        deps.stopTray();
        deps.exit(1);
      } else if (!armedIdleLogged) {
        armedIdleLogged = true;
        deps.logDiagnostic({
          kind: "failsafe",
          event: "armed_idle",
          x: err.x,
          y: err.y,
          holdMs: err.holdMs,
        });
      }
    }
  };
}
