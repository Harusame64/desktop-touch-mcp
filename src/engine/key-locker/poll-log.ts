/**
 * internal #283 — say why a key-locker poll ended without a fill. The wiring arms every armed pane's poll each
 * tick and swallows its result (a rejected poll must never take the server down), so a locker that "did
 * nothing" at a prompt left no trace. A poll that ends a pane's arm, or runs the capture loop to an outcome,
 * or throws, now writes one diagnostic line. Routine ticks (`idle`, `polling`, `busy`) write nothing.
 */

import { logDiagnostic, type DiagnosticEvent } from "../diagnostic-log.js";
import type { PollResult } from "./key-locker-capture-driver.js";

type PollEvent = Extract<DiagnosticEvent, { kind: "key_locker_poll" }>;

/** The diagnostic line for one poll's end, or null for a routine tick. Never a secret. */
export function pollOutcomeEvent(paneId: string, result: PollResult | undefined, error?: unknown): PollEvent | null {
  if (result === undefined) {
    const errorName = error instanceof Error ? error.name : typeof error;
    return { kind: "key_locker_poll", paneId, status: "error", errorName };
  }
  switch (result.status) {
    case "idle":
    case "polling":
    case "busy":
      return null;
    case "timed_out":
    case "superseded":
    case "declined":
      return { kind: "key_locker_poll", paneId, status: result.status };
    case "filled": {
      const o = result.outcome;
      const reason = "reason" in o ? o.reason : "code" in o ? o.code : undefined;
      return { kind: "key_locker_poll", paneId, status: "filled", outcome: o.kind, ...(reason !== undefined && { reason }) };
    }
  }
}

/** Write the line for one poll's end (see `pollOutcomeEvent`). Never throws: it runs in a swallowed chain. */
export function logPollOutcome(paneId: string, result: PollResult | undefined, error?: unknown): void {
  try {
    const event = pollOutcomeEvent(paneId, result, error);
    if (event !== null) logDiagnostic(event);
  } catch {
    /* best-effort: a log line is never worth a poll */
  }
}
