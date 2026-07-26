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
/** Exported for the balloon-length guard test (`NotifyIcon` rejects bodies over 255 chars). */
export function exitBalloonBody(holdMs: number): string {
  return (
    "Failsafe triggered while an operation was running: the mouse stayed in the top-left corner " +
    `of the primary monitor for ${holdMs}ms. The MCP server has exited.`
  );
}
/** The correction sent when the exit is averted after the exit balloon has
 *  already claimed the server is gone — see the `exit_averted` branch below. */
export const AVERTED_BALLOON_BODY =
  "The operation finished before shutdown. The server is still running; new tool calls stay " +
  "blocked while the mouse stays in the corner.";

export interface FailsafeWatcherDeps {
  /** The shared failsafe probe — `() => checkFailsafe("watcher")` in production
   *  (the "watcher" origin suppresses checkFailsafe's own logging; this tick
   *  owns the watcher-path observability — plan §3.2). */
  checkFailsafe: () => Promise<void>;
  /** Exit-gate input: tool handlers past the pre-check, still executing
   *  (`getActiveToolCallCount` from failsafe-wrap — plan Round 4). Read TWICE
   *  on the trigger path: once to open the exit branch, once after the notify
   *  await to confirm the gate is still open (the `exit_averted` recheck). */
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
 *   - `FailsafeError` + active > 0, but the count fell to 0 during the notify
 *     await → log `exit_averted` once per dwell episode, send a correcting
 *     balloon (the exit balloon already went out) and stay alive.
 *   - `FailsafeError` + idle → log `armed_idle` once per dwell episode and
 *     keep the server alive.
 *   - any other throw → ignore (matches the previous inline watcher).
 */
export function createFailsafeWatcherTick(deps: FailsafeWatcherDeps): () => Promise<void> {
  // Episode dedup for the idle path: set when armed_idle has been logged for
  // the current dwell episode, cleared on the first tick where the probe
  // resolves (cursor left the corner / dwell restarted).
  let armedIdleLogged = false;
  // Re-entrancy guard for the trigger path. The server drives this tick from a
  // 500 ms `setInterval`, which does NOT await the previous invocation, while
  // the trigger path awaits the notifier for up to NOTIFY_TIMEOUT_MS (1 s) —
  // so up to two further ticks can enter the same branch and double-fire the
  // balloon / the `triggered` log line. Set before the await and released by
  // the guarded `finally` below on every path EXCEPT the one that ordered the
  // exit (an exiting process never needs it back).
  let stopping = false;

  return async () => {
    if (stopping) return;
    try {
      await deps.checkFailsafe();
      armedIdleLogged = false;
    } catch (err) {
      if (!(err instanceof FailsafeError)) return;
      const active = deps.getActiveToolCallCount();
      if (active > 0) {
        stopping = true;
        // Anything between here and `deps.exit` can throw (a diagnostic write
        // failing, a tray handle already gone). Leaving `stopping` latched in
        // that case would wedge the watcher permanently — the failsafe would
        // go deaf for the rest of the session (P3-4). A NAKED `finally` is
        // wrong though: on the exit path `stopping` must STAY set, because
        // `deps.exit` is only `process.exit` in production — in tests (and any
        // fake) it RETURNS, and a re-armed guard would let the next tick fire
        // a second exit. Hence the reset is conditional on no exit having been
        // ordered; the averted path reaches it via its `return`.
        let exitCalled = false;
        try {
          // Runaway brake: a tool handler is mid-execution — exit, as before.
          // Notify BEFORE exiting (the spawned balloon child survives the
          // parent), but never let a stalled notifier delay the stop by more
          // than NOTIFY_TIMEOUT_MS.
          let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              deps.notify(EXIT_BALLOON_TITLE, exitBalloonBody(err.holdMs)).catch(() => {}),
              new Promise<void>((resolve) => {
                timeoutTimer = setTimeout(resolve, NOTIFY_TIMEOUT_MS);
              }),
            ]);
          } finally {
            // The averted path keeps the process alive, so a still-pending 1 s
            // timer would hold the event loop for no reason (P3-9).
            if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          }
          // Recheck the gate: the await above can span up to NOTIFY_TIMEOUT_MS,
          // and the last active handler may have returned in the meantime. The
          // balloon has already claimed the server "has exited", which is now
          // wrong — standing down is still the right call (killing an idle
          // session costs the user the whole MCP connection; stdio cannot
          // reconnect), so we correct the record instead: a second balloon says
          // the server survived and that the corner still blocks new calls.
          const activeAfterNotify = deps.getActiveToolCallCount();
          if (activeAfterNotify === 0) {
            deps.logDiagnostic({
              kind: "failsafe",
              event: "exit_averted",
              x: err.x,
              y: err.y,
              holdMs: err.holdMs,
            });
            // Same dwell episode as the idle path: don't also log armed_idle on
            // the next tick while the cursor stays in the corner.
            armedIdleLogged = true;
            // Fire-and-forget: the process survives here, so there is no race
            // against `exit` to await (unlike the exit balloon above).
            deps.notify(EXIT_BALLOON_TITLE, AVERTED_BALLOON_BODY).catch(() => {});
            return; // the `finally` below clears `stopping`
          }
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
            // The post-await value: the gate that actually authorised this exit.
            activeToolCalls: activeAfterNotify,
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
          exitCalled = true;
          deps.exit(1);
        } finally {
          if (!exitCalled) stopping = false;
        }
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
