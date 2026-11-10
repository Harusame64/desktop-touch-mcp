/**
 * internal #283 — say why the key locker did, or did not, fill a prompt. A pane's arm (the watch for a
 * credential prompt after a command such as `ssh`) ends in the driver wherever it is cleared — the poll, the
 * tick's arm hygiene, a newer dispatch, `fill_once`, the pane closing — and the driver reports each end once
 * (`onArmEnded`), written here as one diagnostic line. A poll that throws before the capture loop is reported
 * once per arm too. Routine ticks write nothing.
 *
 * Never a secret: each outcome's fields are picked by kind, not copied — no `detail`, no error message. A
 * `fill_aborted` code that carries a message (`loop_error:<message>`) is cut to its prefix.
 */

import { logDiagnostic, type DiagnosticEvent } from "../diagnostic-log.js";
import type { CaptureLoopOutcome } from "./capture-loop.js";
import type { ArmEnd } from "./key-locker-capture-driver.js";
import { safeIdentifier } from "./safe-identifier.js";

type PollEvent = Extract<DiagnosticEvent, { kind: "key_locker_poll" }>;

/** A fill_aborted code safe to write: `loop_error:<message>` cut to `loop_error`, else `safeIdentifier`. */
function safeCode(code: string): string {
  return code.startsWith("loop_error") ? "loop_error" : safeIdentifier(code);
}

/** The safe fields of a capture loop's outcome, by kind. */
function outcomeFields(o: CaptureLoopOutcome): Pick<PollEvent, "outcome" | "reason" | "matched" | "verified"> {
  switch (o.kind) {
    case "declined":
      return { outcome: o.kind, reason: o.reason };
    case "confirm_rejected":
    case "capture_cancelled":
    case "save_failed":
      return { outcome: o.kind };
    case "filled_from_store":
    case "saved":
      return { outcome: o.kind, verified: o.verified };
    case "fill_aborted":
      return { outcome: o.kind, reason: safeCode(o.code), matched: o.matched };
    case "discarded":
      return { outcome: o.kind, reason: o.reason };
    default: {
      const unknown: never = o;
      return { outcome: String((unknown as { kind?: unknown }).kind ?? "unknown") };
    }
  }
}

/** The diagnostic line for one arm's end. */
export function armEndEvent(paneId: string, e: ArmEnd): PollEvent {
  if (e.end === "loop_outcome") return { kind: "key_locker_poll", paneId, end: e.end, ...outcomeFields(e.outcome) };
  if (e.end === "loop_threw" || e.end === "poll_threw") {
    return { kind: "key_locker_poll", paneId, end: e.end, errorName: e.errorName, ...(e.errorCode !== undefined && { errorCode: e.errorCode }) };
  }
  return { kind: "key_locker_poll", paneId, end: e.end };
}

/** Write a line, never throwing: these run in the poll's swallowed chain and the driver's listener. */
export function writePollEvent(event: PollEvent): void {
  try {
    logDiagnostic(event);
  } catch {
    /* best-effort: a log line is never worth a poll */
  }
}
