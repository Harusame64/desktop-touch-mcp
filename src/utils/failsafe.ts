import { mouse } from "../engine/nutjs.js";

const FAILSAFE_RADIUS = 10;
const DEFAULT_HOLD_MS = 500;

function readHoldMs(): number {
  const raw = process.env.DESKTOP_TOUCH_FAILSAFE_HOLD_MS;
  if (raw === undefined) return DEFAULT_HOLD_MS;
  const n = Number(raw);
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
// Reset to null on the first check that finds the cursor outside the zone.
let _enteredAt: number | null = null;

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
      if (_enteredAt === null) {
        _enteredAt = Date.now();
      }
      if (Date.now() - _enteredAt >= holdMs) {
        throw new FailsafeError();
      }
      // Inside the zone but not yet dwelled long enough — no-op.
    } else {
      // Cursor left the zone — clear the dwell timestamp so the next entry
      // starts the hold counter fresh.
      _enteredAt = null;
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
}
