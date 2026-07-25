/**
 * ADR-029 — refuse mouse coordinates the current input backend cannot reach.
 *
 * Since Phase 2a the native path (`src/win32/mouse.rs`, driven by
 * `src/engine/cursor.ts`) places the cursor anywhere on the virtual desktop, so
 * the reachable region is every connected monitor. On an installation without
 * that native module, movement falls back to nut.js / libnut, which addresses
 * the primary monitor only and silently pulls any other point into it — there
 * the region stays the primary monitor, exactly as in Phase 1.
 *
 * The region is therefore chosen by capability, not compiled in: widening it
 * unconditionally would hand back the silent misclick on every build that
 * cannot actually reach the other monitors.
 *
 * **Per monitor, not the bounding box.** A point in the gap of an L-shaped or
 * staggered layout is inside the virtual screen's bounding rectangle but on no
 * monitor, and Windows pulls the cursor to the nearest one — i.e. it fires
 * somewhere the caller did not ask for. That is the failure this guard exists
 * to prevent, so containment is tested against each monitor's rectangle.
 *
 * Every caller must run this BEFORE moving the cursor — once a coordinate has
 * been clamped, the wrong position is already in effect.
 */

import { enumMonitors, getPrimaryMonitorBounds } from "./win32.js";
import { hasNativeCursorMove } from "./native-engine.js";
import { CoordinateOutsideReachableBoundsError } from "../errors/typed-errors.js";

export interface ReachableBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the cursor can currently be placed.
 *
 * - `monitors` — the native path is available: every connected monitor, tested
 *   individually so layout gaps are excluded.
 * - `rect` — a single rectangle: the primary monitor on a build without the
 *   native path, or a caller-supplied override in tests.
 * - `null` — unknown. Monitor enumeration failed, so nothing can be judged.
 */
export type ReachableRegion =
  | { kind: "monitors"; monitors: ReachableBounds[] }
  | { kind: "rect"; rect: ReachableBounds };

function contains(b: ReachableBounds, x: number, y: number): boolean {
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
}

let warnedUnknownBounds = false;

/**
 * The layout is read once per gesture rather than once per call.
 *
 * A single drag asks three times — the handler checks both endpoints before
 * pressing, then the move checks again — and `EnumDisplayMonitors` on each was
 * not only wasted work but a correctness gap: the guard could approve a point
 * against one layout while the move ran against another. A short window keeps
 * the whole gesture on one answer.
 *
 * It stays short because a monitor really can be unplugged mid-gesture. That
 * case is not left to this cache: the native move reads the cursor back and
 * reports a placement failure when the OS pulled it elsewhere.
 */
const REGION_CACHE_MS = 250;
let cachedRegion: { at: number; region: ReachableRegion | null } | null = null;

/** Drop the memoised layout — tests that swap the monitor set need this. */
export function _resetReachableRegionCacheForTests(): void {
  cachedRegion = null;
}

/**
 * Resolve the region the cursor can be placed in, or `null` when that cannot
 * be determined.
 *
 * `null` is treated as "allow" by the callers below: refusing every click on a
 * machine whose monitor enumeration fails would be worse than the misclick risk
 * it guards against. Callers that report a failure afterwards need to know this
 * happened, though — a coordinate that was never checked may simply be stale —
 * so the distinction is part of the return type rather than hidden inside.
 */
export function resolveReachableRegion(): ReachableRegion | null {
  const now = Date.now();
  if (cachedRegion && now - cachedRegion.at < REGION_CACHE_MS) return cachedRegion.region;

  let region: ReachableRegion | null;
  try {
    if (hasNativeCursorMove()) {
      const monitors = enumMonitors().map((m) => m.bounds);
      region = monitors.length > 0 ? { kind: "monitors", monitors } : null;
    } else {
      const primary = getPrimaryMonitorBounds();
      region = primary ? { kind: "rect", rect: primary } : null;
    }
  } catch {
    region = null; // Win32 failure → unknown → allow (same stance as the viewport gate)
  }
  if (region === null && !warnedUnknownBounds) {
    // Allowing everything keeps a machine with unreadable monitor info usable, but
    // it also restores the silent-misclick behaviour this guard exists to prevent.
    // Say so once rather than failing quietly in both directions.
    warnedUnknownBounds = true;
    console.error(
      "[reachable-bounds] monitor bounds unavailable — coordinate reachability cannot be checked; " +
        "clicks may land somewhere other than the requested point.",
    );
  }
  cachedRegion = { at: now, region };
  return region;
}

/** Is (x, y) inside `region`? An unknown (`null`) region cannot be judged, so it allows. */
export function isPointInRegion(x: number, y: number, region: ReachableRegion | null): boolean {
  if (!region) return true;
  return region.kind === "monitors"
    ? region.monitors.some((m) => contains(m, x, y))
    : contains(region.rect, x, y);
}

/**
 * @param bounds Override the reachable region (tests). Defaults to the region
 *   resolved from the live monitor layout. A `null` override means "unknown" —
 *   the guard then allows the coordinate rather than blocking every click.
 */
export function isCoordinateReachable(x: number, y: number, bounds?: ReachableBounds | null): boolean {
  const region =
    bounds === undefined
      ? resolveReachableRegion()
      : bounds === null
        ? null
        : ({ kind: "rect", rect: bounds } as const);
  return isPointInRegion(x, y, region);
}

/**
 * Throw {@link CoordinateOutsideReachableBoundsError} when (x, y) is on no
 * monitor the cursor can currently be placed on. No-op otherwise.
 */
export function assertCoordinateReachable(
  x: number,
  y: number,
  bounds?: ReachableBounds | null,
): void {
  const region =
    bounds === undefined
      ? resolveReachableRegion()
      : bounds === null
        ? null
        : ({ kind: "rect", rect: bounds } as const);
  assertPointInRegion(x, y, region);
}

/**
 * Same check against an already-resolved region. `cursor.ts` resolves the
 * region once per move — it needs the same value afterwards to word a placement
 * failure — and would otherwise pay for a second monitor enumeration here.
 */
export function assertPointInRegion(x: number, y: number, region: ReachableRegion | null): void {
  if (isPointInRegion(x, y, region)) return;
  throw new CoordinateOutsideReachableBoundsError(describeUnreachable(x, y, region));
}

/**
 * The user-facing half of the refusal. Which message applies is decided by
 * capability, not by the shape of the region: a single rectangle can equally
 * well be a test override, and telling a test that the native input module is
 * missing would be wrong.
 */
function describeUnreachable(x: number, y: number, region: ReachableRegion | null): string {
  if (region?.kind === "monitors") {
    const layout = region.monitors
      .map((m) => `${m.width}x${m.height} at (${m.x}, ${m.y})`)
      .join(", ");
    return (
      `CoordinateOutsideReachableBounds: (${x}, ${y}) is not on any connected monitor ` +
      `(monitors: ${layout}). Mouse input works on all monitors, so this usually means the ` +
      `coordinates are stale — the window moved or closed after they were read. Re-run ` +
      `desktop_discover (or take a fresh screenshot) and act on the new coordinates.`
    );
  }
  const where =
    region?.kind === "rect"
      ? `${region.rect.width}x${region.rect.height} at (${region.rect.x}, ${region.rect.y})`
      : "the reachable area";
  if (!hasNativeCursorMove()) {
    return (
      `CoordinateOutsideReachableBounds: (${x}, ${y}) is outside the primary monitor ${where}. ` +
      `This installation is running without its built-in Windows input module, so mouse input ` +
      `reaches the primary monitor only — acting on this coordinate would click somewhere else ` +
      `instead. Move the target window onto the primary monitor, or reinstall / update the ` +
      `server to restore multi-monitor input.`
    );
  }
  return (
    `CoordinateOutsideReachableBounds: (${x}, ${y}) is outside ${where}. Acting on this ` +
    `coordinate would click somewhere else instead.`
  );
}
