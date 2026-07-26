import { mouse } from "../engine/nutjs.js";
import { logDiagnostic } from "../engine/diagnostic-log.js";
import { showBalloonTip } from "./balloon.js";

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

/**
 * ADR-030 Phase 1 (§3.1): pure zone predicate — the failsafe corner is the
 * top-left 10px of the PRIMARY monitor only. Lower bound added: negative
 * virtual-screen coordinates (monitors left of / above the primary) must NOT
 * be in-zone. Exported so the multi-monitor regression is testable by
 * coordinate injection alone (ADR-030 AC1 — no second monitor needed).
 */
export function isInFailsafeZone(x: number, y: number): boolean {
  return x >= 0 && x <= FAILSAFE_RADIUS && y >= 0 && y <= FAILSAFE_RADIUS;
}

/**
 * The "ghost zone": in-zone under the pre-fix predicate (no lower bound)
 * but out-of-zone under the fixed one — i.e. the negative-coordinate band
 * that used to fire spuriously. Used by Proposal B (one-time miss notice).
 */
export function isInLegacyGhostZone(x: number, y: number): boolean {
  return x <= FAILSAFE_RADIUS && y <= FAILSAFE_RADIUS && !isInFailsafeZone(x, y);
}

/** Which call site is probing the failsafe (drives the per-origin logging /
 *  notification split — ADR-030 plan §3.2). */
export type FailsafeOrigin = "per-tool" | "watcher" | "background";

export class FailsafeError extends Error {
  /** Trigger coordinates + effective hold — carried on the error so the
   *  watcher exit path can log WHERE the failsafe fired (ADR-030 OQ1: was it
   *  a negative-coordinate-band trigger?). The error is the only channel that
   *  survives from the throw site to the watcher's catch. */
  readonly x: number;
  readonly y: number;
  readonly holdMs: number;

  constructor(x: number, y: number, holdMs: number) {
    super(
      "FAILSAFE triggered: mouse has been at the top-left corner of the primary monitor (within " +
        FAILSAFE_RADIUS +
        "px of 0,0) continuously. " +
        "Operation aborted for safety. Move mouse away from corner to resume."
    );
    this.name = "FailsafeError";
    this.x = x;
    this.y = y;
    this.holdMs = holdMs;
  }
}

// Module-level state — when did the cursor first enter the failsafe zone?
// `_lastInZoneAt` is the most recent in-zone sample; we use it to detect a
// large gap between samples (cursor may have left and returned unobserved)
// and restart the dwell timer in that case. Reset to null on the first check
// that finds the cursor outside the zone.
let _enteredAt: number | null = null;
let _lastInZoneAt: number | null = null;
// Per-tool balloon throttle (plan §3.2): the `_enteredAt` value we already
// notified for. One balloon per dwell episode — an LLM retrying refused tool
// calls against the same episode does not re-notify.
let _notifiedEpisodeAt: number | null = null;

// Proposal B (ghost-zone miss notice, plan §3.4) — an independent dwell state
// of the same shape as the main one, so the notice reproduces exactly the
// dwell that would have fired under the pre-fix predicate. Never affects the
// trigger behaviour (no throw, no shared state).
let _ghostEnteredAt: number | null = null;
let _ghostLastInZoneAt: number | null = null;
let _ghostNoticeShown = false;

/** Exported for the balloon-length guard test — see `ghostBalloonBody`. */
export const BALLOON_TITLE = "desktop-touch-mcp: emergency stop";
/** Exported for the balloon-length guard test — see `ghostBalloonBody`. */
export const PER_TOOL_BALLOON_BODY =
  "Tool calls are being refused: the mouse has stayed in the top-left corner of the primary monitor. " +
  "Move the cursor away from the corner to resume.";
/** Exported for the balloon-length guard test — `szInfoTitle` only carries 63 characters, and the
 *  previous 66-character wording lost its last three ("...PRIMARY monit") with no warning. */
export const GHOST_BALLOON_TITLE = "desktop-touch-mcp: emergency stop corner moved";
/**
 * Exported for the balloon-length guard test (`tests/unit/balloon-length.test.ts`).
 *
 * MUST stay well inside `NOTIFYICON_BALLOON_TEXT_MAX`: the earlier wording was 272 characters, and
 * the shell silently drops everything past 255 — the notice arrived cut off mid-sentence, once per
 * session, with nothing anywhere recording that it had been clipped (Codex Round 2; the mechanism is
 * truncation, not rejection — see `balloon.ts`). Keep it at ≤240 so the interpolated `holdMs` can
 * grow by several digits safely.
 */
export function ghostBalloonBody(holdMs: number): string {
  return (
    "The cursor rested where older versions triggered the emergency stop, but it no longer fires there. " +
    "The stop is now the top-left corner of the PRIMARY monitor only (within 10px of 0,0), held for " +
    `${holdMs}ms. Shown once per session.`
  );
}

/**
 * Proposal B — the ghost-zone dwell tracker. Fires a one-per-process balloon
 * + diagnostic log when the cursor dwells (same holdMs) in the band that the
 * PRE-fix predicate would have treated as in-zone. Origin-independent: every
 * probe (per-tool / watcher / background) feeds samples (plan §3.4 — the
 * §3.2 origin split applies to TRIGGER notices only). Never throws.
 */
function trackGhostZone(x: number, y: number, holdMs: number, now: number): void {
  if (isInLegacyGhostZone(x, y)) {
    if (_ghostLastInZoneAt !== null && now - _ghostLastInZoneAt > MAX_INTRA_DWELL_GAP_MS) {
      _ghostEnteredAt = now;
    } else if (_ghostEnteredAt === null) {
      _ghostEnteredAt = now;
    }
    _ghostLastInZoneAt = now;
    if (!_ghostNoticeShown && now - _ghostEnteredAt >= holdMs) {
      _ghostNoticeShown = true;
      logDiagnostic({ kind: "failsafe", event: "ghost_zone_notice", x, y, holdMs });
      // Best-effort fire-and-forget — a notification failure must never
      // affect tool execution.
      void showBalloonTip(GHOST_BALLOON_TITLE, ghostBalloonBody(holdMs)).catch(() => {});
    }
  } else {
    _ghostEnteredAt = null;
    _ghostLastInZoneAt = null;
  }
}

/**
 * Check mouse position. Throws `FailsafeError` only after the cursor has been
 * inside the failsafe zone (≤ `FAILSAFE_RADIUS` px from the primary monitor's
 * top-left) continuously for `DESKTOP_TOUCH_FAILSAFE_HOLD_MS` milliseconds
 * (default 500).
 *
 * The zone is the PRIMARY monitor's top-left corner only (ADR-030 §3):
 * negative virtual-screen coordinates — monitors left of / above the primary
 * — never arm the failsafe. Dwelling in that legacy band instead produces a
 * one-time educational notice (Proposal B).
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
 * watcher AND from the key-locker background guard. The dwell timer is shared
 * across all call sites; `origin` only routes the observability side effects
 * (plan §3.2):
 *   - "per-tool"   → diagnostic log per refusal + balloon once per dwell episode
 *   - "background" → diagnostic log per refusal, NO balloon (the dropped
 *                    credential prompt stays visible in the pane)
 *   - "watcher"    → no side effects here — the watcher tick logs/notifies
 *                    itself (avoids double logging)
 */
export async function checkFailsafe(origin: FailsafeOrigin = "per-tool"): Promise<void> {
  try {
    const pos = await mouse.getPosition();
    const holdMs = readHoldMs();
    const now = Date.now();

    // Proposal B: feed the ghost-zone tracker on every sample (origin-independent).
    trackGhostZone(pos.x, pos.y, holdMs, now);

    const inZone = isInFailsafeZone(pos.x, pos.y);
    if (inZone) {
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
        if (origin === "per-tool" || origin === "background") {
          // One log line per refusal (plan §3.2 / ADR AC3 — the per-tool and
          // background paths previously left no trace at all).
          logDiagnostic({
            kind: "failsafe",
            event: "triggered",
            origin,
            x: pos.x,
            y: pos.y,
            holdMs,
          });
          if (origin === "per-tool" && _notifiedEpisodeAt !== _enteredAt) {
            // One balloon per dwell episode (throttle: LLM retry bursts
            // against the same episode notify once). Best-effort.
            _notifiedEpisodeAt = _enteredAt;
            void showBalloonTip(BALLOON_TITLE, PER_TOOL_BALLOON_BODY).catch(() => {});
          }
        }
        throw new FailsafeError(pos.x, pos.y, holdMs);
      }
      // Inside the zone but not yet dwelled long enough — no-op.
    } else {
      // Cursor left the zone — clear the dwell timestamp so the next entry
      // starts the hold counter fresh. (A move from the corner into the
      // negative-coordinate band lands here too: the ghost band is
      // out-of-zone under the fixed predicate, so the dwell timer resets.)
      _enteredAt = null;
      _lastInZoneAt = null;
    }
  } catch (err) {
    if (err instanceof FailsafeError) throw err;
    // Transient mouse query error — don't block tools.
    // Also do not clear _enteredAt here — we don't know cursor state.
  }
}

/** Test-only: reset the dwell timestamps + notice flags. Not exposed via the public index. */
export function _resetFailsafeForTest(): void {
  _enteredAt = null;
  _lastInZoneAt = null;
  _notifiedEpisodeAt = null;
  _ghostEnteredAt = null;
  _ghostLastInZoneAt = null;
  _ghostNoticeShown = false;
}
