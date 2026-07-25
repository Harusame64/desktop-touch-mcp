/**
 * ADR-029 Phase 1 — refuse mouse coordinates the current input backend cannot reach.
 *
 * The nut.js / libnut path addresses the primary monitor only: a point outside it
 * is clamped into it, so a click aimed at a second monitor silently lands on
 * whatever sits at the clamped position (and a negative coordinate can even land
 * in the failsafe corner). Until the native multi-monitor path exists, such a
 * coordinate is rejected up front rather than acted on.
 *
 * Every caller must run this BEFORE moving the cursor — once libnut has clamped,
 * the wrong position is already in effect.
 *
 * The reachable region is the primary monitor's bounds today and widens to the
 * whole virtual screen once the native path lands; only the message and the
 * recovery advice change then, not the error code.
 */

import { getPrimaryMonitorBounds } from "./win32.js";
import { CoordinateOutsideReachableBoundsError } from "../errors/typed-errors.js";

export interface ReachableBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * @param bounds Override the reachable region (tests). Defaults to the primary
 *   monitor. A `null` result from the lookup means "unknown" — the guard then
 *   allows the coordinate rather than blocking every click on a machine whose
 *   monitor enumeration failed.
 */
export function isCoordinateReachable(x: number, y: number, bounds?: ReachableBounds | null): boolean {
  const region = bounds === undefined ? safePrimaryBounds() : bounds;
  if (!region) return true; // unknown region → cannot judge → allow
  return (
    x >= region.x &&
    x < region.x + region.width &&
    y >= region.y &&
    y < region.y + region.height
  );
}

/**
 * Throw {@link CoordinateOutsideReachableBoundsError} when (x, y) cannot be
 * reached by the current input backend. No-op otherwise.
 */
export function assertCoordinateReachable(
  x: number,
  y: number,
  bounds?: ReachableBounds | null
): void {
  const region = bounds === undefined ? safePrimaryBounds() : bounds;
  if (isCoordinateReachable(x, y, region)) return;
  const where = region
    ? `primary monitor ${region.width}x${region.height} at (${region.x}, ${region.y})`
    : "the reachable area";
  throw new CoordinateOutsideReachableBoundsError(
    `CoordinateOutsideReachableBounds: (${x}, ${y}) is outside ${where}. ` +
      `Mouse input currently reaches the primary monitor only — acting on this ` +
      `coordinate would click somewhere else instead.`
  );
}

function safePrimaryBounds(): ReachableBounds | null {
  try {
    return getPrimaryMonitorBounds();
  } catch {
    return null; // Win32 failure → unknown → allow (same conservative stance as the viewport gate)
  }
}
