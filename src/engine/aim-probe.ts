/**
 * aim-probe.ts — what the aim actually is, at every seam it passes through.
 *
 * ADR-036, the restoration of the Reactive Perception Graph. The design was never wrong; the
 * line to the aim was not connected, and the layers above it were built by people who could not
 * see where the value came from. So before moving anything toward the specification, this records
 * what the machine does TODAY: the current behaviour is the ground truth, and the specification is
 * where it is being taken.
 *
 * Design rules, each of them a scar:
 *
 *   - **It only reads.** Nothing here calls `observeTarget` or anything else that updates a
 *     tracker, because a probe that writes changes the thing it measures — and the aim's identity
 *     is exactly the kind of state that moves when you look at it.
 *   - **It never throws.** A probe that can break the run it observes will eventually be blamed
 *     for the bug it found. Every entry point swallows its own errors.
 *   - **It writes to a file.** A probe that only prints leaves no record: the terminal is gone
 *     when the window closes, and the interesting run is always the one nobody was watching.
 *   - **Absence is recorded, not inferred.** A seam that is reached with no aim writes
 *     `hwnd: null` rather than writing nothing, so "the aim was empty here" and "this build never
 *     reached this line" are different rows.
 *
 * Off unless `DESKTOP_TOUCH_AIM_PROBE=1`. The path is `DESKTOP_TOUCH_AIM_PROBE_PATH`, or
 * `<home>/.desktop-touch-mcp/logs/aim-probe.jsonl`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getWindowIdentity } from "./win32.js";

/** The seams, in the order one `desktop_discover` → `desktop_act` pair passes through them. */
export type AimSeam =
  /** `see()` entry: the target the caller sent, and the session key it resolved to. */
  | "see.enter"
  /** `normalizeTarget`: what went in, what came out, and what it warned about. */
  | "compose.normalize"
  /** A provider lane: the target id it stamped on its candidates, and the handle it scoped to. */
  | "provider.read"
  /** `see()` exit: what the session ends up remembering as `lastTarget`. */
  | "see.store"
  /** `createDesktopExecutor`: the target the write path was handed, and the handle it parsed. */
  | "act.aim"
  /** Act time: the identity of the window that handle names NOW (read-only). */
  | "act.identity"
  /** Act time: which backend ran, and whether it was aimed. */
  | "act.route";

let seq = 0;
let resolvedPath: string | null = null;
let disabled = false;

function probePath(): string | null {
  if (disabled) return null;
  if (resolvedPath) return resolvedPath;
  if (process.env.DESKTOP_TOUCH_AIM_PROBE !== "1") { disabled = true; return null; }
  const p = process.env.DESKTOP_TOUCH_AIM_PROBE_PATH
    ?? join(homedir(), ".desktop-touch-mcp", "logs", "aim-probe.jsonl");
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    // A directory that cannot be made is not a reason to fail the run being measured.
    disabled = true;
    return null;
  }
  resolvedPath = p;
  return p;
}

/**
 * Record one seam.
 *
 * `data` is written as-is, so callers pass values already reduced to JSON-safe shapes — a `bigint`
 * has to arrive as a string. That is deliberate: the conversion belongs where the value's meaning
 * is known, not in a logger guessing at it.
 */
export function probeAim(seam: AimSeam, data: Record<string, unknown>): void {
  const p = probePath();
  if (!p) return;
  try {
    const line = JSON.stringify({ seq: ++seq, tsMs: Date.now(), pid: process.pid, seam, ...data });
    appendFileSync(p, line + "\n");
  } catch {
    // Never let the observation break the observed.
  }
}

/** True when the probe is on — for call sites whose data costs something to assemble. */
export function aimProbeEnabled(): boolean {
  return probePath() !== null;
}

/**
 * The window identity behind a handle, read without touching any tracker.
 *
 * `identity-tracker.ts` already models exactly what the specification asks for — `hwnd_reused`,
 * `process_restarted`, `hwnd_vanished` — but its entry point (`observeTarget`) RECORDS what it
 * sees, so calling it from here would make the probe part of the mechanism. This reads the same
 * facts through the pure win32 helpers instead.
 *
 * A zeroed identity (`pid: 0`, empty name) means the question could not be answered — the native
 * binding is missing, the process is gone, the handle is not a window. That is not evidence of a
 * different window, and the field is emitted as-is so a reader can tell the two apart.
 */
export function readWindowIdentity(hwnd: bigint): Record<string, unknown> {
  try {
    // `win32.ts` loads the native binding lazily inside its own functions, so importing it here
    // costs nothing in a run with the probe off.
    const ident = getWindowIdentity(hwnd);
    return {
      pid: ident.pid,
      processName: ident.processName,
      processStartTimeMs: ident.processStartTimeMs,
      answered: ident.pid !== 0,
    };
  } catch (err) {
    return { answered: false, error: err instanceof Error ? err.message : String(err) };
  }
}
