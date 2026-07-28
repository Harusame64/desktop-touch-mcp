/**
 * tests/e2e/helpers/e2e-screen.ts
 *
 * Decide WHERE on the desktop the E2E suite is allowed to put the windows it
 * spawns.
 *
 * WHY: the E2E suite drives real windows on a real desktop — it spawns blank
 * click targets and PowerShell consoles, focuses them, and clicks into them.
 * On a single-monitor machine there is nowhere else to put them, but on a
 * multi-monitor machine dropping every test window on the PRIMARY monitor
 * steals the screen the human is working on: windows pop over the editor, the
 * foreground focus is yanked away mid-test, and the user's own clicks/keys race
 * with the suite's synthetic input (which in turn makes focus-sensitive tests
 * flaky). Putting the test windows on a NON-PRIMARY monitor when one exists
 * keeps the suite entirely off the user's working screen.
 *
 * Behaviour contract:
 *   - >= 2 monitors, one of which reports itself primary → the first
 *     non-primary monitor is chosen, and callers place their windows there.
 *   - single monitor (or monitor enumeration unavailable / no primary
 *     reported) → `null`, and callers keep their previous, unchanged
 *     placement. Nothing about single-monitor runs changes.
 *
 * Coordinates are virtual-screen coordinates and are frequently NEGATIVE for a
 * monitor placed to the left of the primary (e.g. a virtual display at
 * x = -1920), which is exactly the interesting case for multi-monitor
 * regressions — so helpers here never clamp to a non-negative origin.
 */
import { enumMonitors, setWindowBounds } from "../../../src/engine/win32.js";

/** Gap between the monitor's work area edge and the spawned window. */
const MARGIN = 120;

export interface E2eScreen {
  /**
   * Top-left corner to place a test window at: the target monitor's work-area
   * origin plus `MARGIN`, pulled back so a window of the requested size still
   * fits inside the work area.
   */
  origin: { x: number; y: number };
  /** Full (non-work-area) bounds of the chosen monitor, for callers that need the extent. */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * Pick the monitor E2E windows should be placed on, or null when the suite
 * should keep its default (primary-monitor) placement.
 *
 * @param size Optional window size; when given, the returned origin is clamped
 *             so a window of that size stays inside the target work area.
 */
export function pickE2eScreen(size?: { width: number; height: number }): E2eScreen | null {
  let monitors;
  try {
    monitors = enumMonitors();
  } catch {
    // Native module unavailable / headless — behave like a single-monitor box.
    return null;
  }
  // Require a real multi-monitor layout AND a monitor that claims primary.
  // Without the `some(primary)` check a failed enumeration (nothing marked
  // primary) would make the single connected display look "non-primary" and
  // the placement logic would fire on a single-monitor machine.
  if (monitors.length < 2 || !monitors.some((m) => m.primary)) return null;
  const target = monitors.find((m) => !m.primary);
  if (!target) return null;

  // Prefer the work area (excludes taskbar) but fall back to full bounds if a
  // driver reports a degenerate work area.
  const area =
    target.workArea.width > 0 && target.workArea.height > 0 ? target.workArea : target.bounds;
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  // Clamp: never push the window past the far edge, and never before the
  // near edge (a window larger than the monitor simply starts at the origin).
  const maxX = area.x + Math.max(0, area.width - w);
  const maxY = area.y + Math.max(0, area.height - h);
  return {
    origin: {
      x: Math.max(area.x, Math.min(area.x + MARGIN, maxX)),
      y: Math.max(area.y, Math.min(area.y + MARGIN, maxY)),
    },
    bounds: { ...target.bounds },
  };
}

/**
 * Move an already-spawned window onto the E2E screen, keeping its current size
 * and Z-order (`setWindowBounds` uses SWP_NOZORDER, so TopMost / foreground
 * state is untouched). No-op returning false on a single-monitor machine or
 * when the move fails — callers treat placement as best-effort cosmetics, never
 * as a precondition.
 */
export function moveWindowToE2eScreen(
  hwnd: bigint,
  currentSize: { width: number; height: number }
): boolean {
  const screen = pickE2eScreen(currentSize);
  if (!screen) return false;
  try {
    return setWindowBounds(hwnd, screen.origin.x, screen.origin.y, currentSize.width, currentSize.height);
  } catch {
    return false;
  }
}
