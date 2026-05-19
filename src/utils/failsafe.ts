import { mouse } from "../engine/nutjs.js";

const FAILSAFE_RADIUS = 10;
const DEFAULT_HOLD_MS = 500;

// The 500 ms background watcher in server-windows.ts polls at fixed cadence;
// per-tool pre-checks may fire at any moment. If the gap between two
// consecutive in-zone observations is larger than this, we assume the cursor
// may have left and returned within the unsampled window and restart the
// dwell timer (Codex review R1 P2-2). 1500 ms = 3x watcher tick, generous
// enough to tolerate setInterval slip without re-introducing the
// in-zone → out → in drive-by failure mode.
const MAX_INTRA_DWELL_GAP_MS = 1500;

function readHoldMs(): number {
  const raw = process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS;
  if (raw === undefined) return DEFAULT_HOLD_MS;
  // Codex review R1 P2-1: a blank / whitespace-only env value would coerce
  // to 0 via Number("") and silently restore the immediate-trigger behaviour
  // we're trying to remove. Treat blank as "unset" and fall back to default.
  // `"0"` (explicit numeric zero) remains a valid opt-out.
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_HOLD_MS;
  const n = Number(trimmed);
  // `n >= 0` lets the user opt back into the immediate-trigger behaviour
  // (HOLD_MS=0) without re-introducing the bug that motivated the redesign.
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HOLD_MS;
}

export class FailsafeError extends Error {
  constructor() {
    super(
      "FAILSAFE triggered: mouse has been at top-left corner (within " +
        FAILSAFE_RADIUS +
        "px of 0,0) continuously. " +
        "Operation aborted for safety. Move mouse away from corner to resume."
    );
    this.name = "FailsafeError";
  }
}

// Module-level state — when did the cursor first enter the failsafe zone?
// `_lastInZoneAt` is the most recent in-zone sample; we use it to detect a
// large gap between samples (cursor may have left and returned unobserved)
// and restart the dwell timer in that case. Reset to null on the first check
// that finds the cursor outside the zone.
let _enteredAt: number | null = null;
let _lastInZoneAt: number | null = null;

/**
 * Check mouse position. Throws `FailsafeError` only after the cursor has been
 * inside the failsafe zone (≤ `FAILSAFE_RADIUS` px from top-left) continuously
 * for `DESKTOP_TOUCH_FAILSAFE_HOLD_MS` milliseconds (default 500).
 *
 * Drive-by cursor movements through (0,0) — common during window drag, dock
 * gestures, automated E2E tests, accidental flicks — no longer trigger the
 * emergency stop. The 500 ms hold requirement is short enough that a
 * deliberate "park the cursor in the corner" gesture still feels immediate to
 * a human, but long enough that no normal usage will hit it by accident.
 *
 * Sampling caveat: detection is poll-based (500 ms watcher tick + per-tool
 * pre-checks). A cursor that leaves and re-enters the zone entirely between
 * two samples is not directly observable. We mitigate by restarting the
 * dwell timer whenever consecutive in-zone samples are separated by more
 * than `MAX_INTRA_DWELL_GAP_MS` (3x the watcher tick), so a long unsampled
 * gap is treated as if the cursor may have left.
 *
 * `DESKTOP_TOUCH_FAILSAFE_HOLD_MS=0` restores the original immediate-trigger
 * behaviour for callers who depend on it (kill-switch escape hatch).
 *
 * Call this before every tool execution AND from the 500 ms background
 * watcher. The dwell timer is shared across both call sites.
 */
export async function checkFailsafe(): Promise<void> {
  try {
    const pos = await mouse.getPosition();
    const inZone =
      pos.x <= FAILSAFE_RADIUS && pos.y <= FAILSAFE_RADIUS;
    if (inZone) {
      const holdMs = readHoldMs();
      const now = Date.now();
      // Codex review R1 P2-2: if the gap since the last in-zone sample is
      // large enough that the cursor could have left and returned without
      // being observed, restart the dwell timer.
      if (
        _lastInZoneAt !== null &&
        now - _lastInZoneAt > MAX_INTRA_DWELL_GAP_MS
      ) {
        _enteredAt = now;
      } else if (_enteredAt === null) {
        _enteredAt = now;
      }
      _lastInZoneAt = now;
      if (now - _enteredAt >= holdMs) {
        throw new FailsafeError();
      }
      // Inside the zone but not yet dwelled long enough — no-op.
    } else {
      // Cursor left the zone — clear the dwell timestamp so the next entry
      // starts the hold counter fresh.
      _enteredAt = null;
      _lastInZoneAt = null;
    }
  } catch (err) {
    if (err instanceof FailsafeError) throw err;
    // Transient mouse query error — don't block tools.
    // Also do not clear _enteredAt here — we don't know cursor state.
  }
}

/** Test-only: reset the dwell timestamp. Not exposed via the public index. */
export function _resetFailsafeForTest(): void {
  _enteredAt = null;
  _lastInZoneAt = null;
}
