/**
 * ADR-029 Phase 2a — the one place that moves the mouse cursor.
 *
 * Before this module every caller reached into nut.js directly, which meant the
 * primary-monitor clamp (and later the reachability guard) had to be repeated
 * at each site. Cursor movement now funnels through {@link moveCursorTo}: the
 * guard, the native/fallback decision, and the interpolation live once, and
 * `tests/unit/reachable-bounds.test.ts` pins the invariant that no other file
 * under `src/` moves the cursor.
 *
 * Interpolation stays on the JS side. The native binding is deliberately dumb —
 * a Rust sleep loop would hold the libuv thread for the whole gesture (over a
 * second to cross a 4K desktop at the default speed), whereas nut.js's own
 * design, a path computed in JS and fed point by point to native code, yields
 * between ticks. What the native side does provide is a batch entry point, so a
 * tick costs one call instead of one per interpolated pixel.
 */

import { mouse, Point, straightTo, DEFAULT_MOUSE_SPEED } from "./nutjs.js";
import { nativeWin32, hasNativeCursorMove } from "./native-engine.js";
import type { NativeCursorPoint } from "./native-types.js";
import {
  assertPointInRegion,
  resolveReachableRegion,
  isPointInRegion,
  type ReachableRegion,
} from "./reachable-bounds.js";
import { CursorPlacementBlockedError } from "../errors/typed-errors.js";

/**
 * Distance between interpolated points, in pixels.
 *
 * nut.js emits one point per pixel, and applications that watch the pointer
 * stream — drag thresholds, `dragover`, freehand drawing — see every one of
 * them. Stepping by time instead (say 8 ms ticks) would jump ~24 px at the
 * default speed and hand those applications a much coarser gesture, so the step
 * is a distance and the pacing loop below is what deals with the clock.
 */
const STEP_PX = 1;

/**
 * Nominal tick length. Windows timers cannot resolve much below this, so a tick
 * carries however many points the requested speed calls for rather than
 * pretending to sleep for a fraction of a millisecond per pixel.
 */
const TICK_MS = 8;

export interface CursorPoint {
  x: number;
  y: number;
}

/** One tick's worth of movement: the points to emit, and when they are due. */
interface PathSegment {
  points: CursorPoint[];
  /** Milliseconds from the start of the gesture at which this segment should land. */
  dueAtMs: number;
}

/**
 * Straight-line path from `from` to `to`, stepping by {@link STEP_PX}.
 *
 * The final point is always exactly `to` — an animated move must end on the
 * same pixel a teleport would, since that is what the caller is about to click.
 *
 * Points that fall on no monitor are dropped rather than emitted. In an L-shaped
 * or staggered layout a straight line can pass through a gap between monitors,
 * and Windows pulls each such point to the nearest monitor: the cursor would
 * visit real, unintended positions on the way, which with a button held means
 * `dragover` and drop-target highlighting firing there. Skipping the gap turns
 * that into a single jump across it.
 *
 * Exported for tests; `moveCursorTo` is the runtime entry point.
 */
export function planCursorPath(
  from: CursorPoint,
  to: CursorPoint,
  region: ReachableRegion | null,
): CursorPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < STEP_PX) return [{ x: to.x, y: to.y }];

  const steps = Math.ceil(distance / STEP_PX);
  const points: CursorPoint[] = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const p = { x: Math.round(from.x + dx * t), y: Math.round(from.y + dy * t) };
    if (!isPointInRegion(p.x, p.y, region)) continue; // in a layout gap — jump it
    const prev = points[points.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) continue;
    points.push(p);
  }
  points.push({ x: to.x, y: to.y });
  return points;
}

/** Split a path into tick-sized segments carrying the time each is due at. */
function segmentPath(points: CursorPoint[], speedPxPerSec: number): PathSegment[] {
  const perTick = Math.max(1, Math.round((speedPxPerSec * TICK_MS) / 1000 / STEP_PX));
  const segments: PathSegment[] = [];
  for (let i = 0; i < points.length; i += perTick) {
    const slice = points.slice(i, i + perTick);
    segments.push({ points: slice, dueAtMs: ((i + slice.length) / perTick) * TICK_MS });
  }
  return segments;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function requireNative(): NonNullable<typeof nativeWin32> {
  if (!nativeWin32) throw new Error("[cursor] native win32 surface missing");
  return nativeWin32;
}

function readNativeCursorPos(): CursorPoint {
  const p: NativeCursorPoint = requireNative().win32GetCursorPos!();
  return { x: p.x, y: p.y };
}

/**
 * Turn a native "did not land" result into the typed error.
 *
 * Which wording applies depends on whether the point was ever checked against
 * the screen layout. When monitor enumeration failed the guard let the
 * coordinate through unverified, so it may simply be stale — claiming it is on
 * a monitor would send the caller off to free a cursor that nothing is holding.
 */
function placementBlocked(
  x: number,
  y: number,
  finalX: number,
  finalY: number,
  region: ReachableRegion | null,
): CursorPlacementBlockedError {
  const landedAt = `The pointer ended up at (${finalX}, ${finalY}) instead.`;
  if (region === null) {
    return new CursorPlacementBlockedError(
      `CursorPlacementBlocked: the cursor could not be moved to (${x}, ${y}), and the monitor ` +
        `layout could not be read, so the point was never checked against the screen. ${landedAt} ` +
        `Nothing was clicked. Either the point is stale — the window moved or closed after the ` +
        `coordinates were read — or something is holding the cursor (a full-screen game, a ` +
        `disconnected remote-desktop session, another program repositioning the pointer).`,
    );
  }
  return new CursorPlacementBlockedError(
    `CursorPlacementBlocked: the cursor could not be moved to (${x}, ${y}), which is on a ` +
      `connected monitor. ${landedAt} Nothing was clicked. This happens when another ` +
      `application has confined the cursor to its own window (common in full-screen games), ` +
      `when the session is not interactive right now (a disconnected or locked remote-desktop ` +
      `session), when another program keeps repositioning the pointer, or when a monitor was ` +
      `added or removed just now.`,
  );
}

/**
 * Move the cursor to (x, y) in physical virtual-screen coordinates.
 *
 * `speed` is px/sec: 0 teleports, omitted uses `DESKTOP_TOUCH_MOUSE_SPEED`
 * (default 3000). Negative coordinates are normal — they address a monitor
 * placed left of or above the primary one.
 *
 * Throws `CoordinateOutsideReachableBounds` when the destination is on no
 * monitor, and `CursorPlacementBlocked` when it is but the pointer could not be
 * put there. It does NOT fall back to nut.js when a native move fails: nut.js
 * would clamp the coordinate into the primary monitor and click the wrong
 * thing, which is the bug this whole ADR removes.
 *
 * Callers that press a mouse button first MUST release it in a `finally` —
 * unlike the old nut.js path, this one can throw mid-gesture.
 */
export async function moveCursorTo(x: number, y: number, speed?: number): Promise<void> {
  const region = resolveReachableRegion();
  assertPointInRegion(x, y, region);

  const s = speed ?? DEFAULT_MOUSE_SPEED;

  if (!hasNativeCursorMove()) {
    // No native path: nut.js, with the guard above still holding the caller to
    // the primary monitor (Phase 1 behaviour, bit for bit).
    if (s === 0) {
      await mouse.setPosition(new Point(x, y));
      return;
    }
    const prev = mouse.config.mouseSpeed;
    mouse.config.mouseSpeed = s;
    try {
      await mouse.move(straightTo(new Point(x, y)));
    } finally {
      mouse.config.mouseSpeed = prev;
    }
    return;
  }

  const native = requireNative();

  if (s === 0) {
    const r = native.win32MoveCursorAbsolute!(x, y);
    if (!r.ok) throw placementBlocked(x, y, r.finalX, r.finalY, region);
    return;
  }

  const from = readNativeCursorPos();
  const path = planCursorPath(from, { x, y }, region);
  const segments = segmentPath(path, s);
  const startedAt = Date.now();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const points: NativeCursorPoint[] = seg.points.map((p) => ({ x: p.x, y: p.y }));
    const r = native.win32MoveCursorPath!(points, isLast);
    if (isLast && !r.ok) throw placementBlocked(x, y, r.finalX, r.finalY, region);
    if (isLast) break;
    // Pace against elapsed time, not a fixed sleep per tick: a slow tick must
    // not stretch the whole gesture, or the effective speed halves on a machine
    // whose timers round up.
    const behindBy = seg.dueAtMs - (Date.now() - startedAt);
    if (behindBy > 0) await sleep(behindBy);
  }
}
