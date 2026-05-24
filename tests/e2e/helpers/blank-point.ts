/**
 * tests/e2e/helpers/blank-point.ts
 *
 * Find a genuinely-empty desktop coordinate (over the wallpaper, outside every
 * visible top-level window) for E2E tests that need a "click that hits nothing"
 * or a defocus click.
 *
 * WHY: several mouse E2E tests used to click HARDCODED coordinates — most often
 * (960, 540) = screen centre, or (50,50)/(100,100) — hoping the spot was empty.
 * On a real desktop those coordinates almost always land on a real window (the
 * host MCP session, the editor, a browser), so the test would carelessly click
 * arbitrary UI: collateral focus changes, accidental button presses, and — in
 * the worst case — the host MCP server's emergency-stop / failsafe. Scanning for
 * an actually-blank spot and clicking THAT matches what a human would do and
 * removes the collateral risk.
 *
 * Scans each monitor for a point inside NO visible, non-minimized top-level
 * window, while avoiding:
 *   - the failsafe corner (≤ FAILSAFE_RADIUS px of 0,0, see src/utils/failsafe.ts),
 *   - the bottom taskbar strip,
 *   - the screen edges (auto-hide bars / off-by-one rounding).
 *
 * Returns null when the screen is fully covered — callers should SKIP the test
 * rather than fall back to a blind click (the whole point of this helper).
 *
 * Coordinates are SCREEN coordinates (what mouseClickHandler expects without an
 * `origin`), matching enumWindowsInZOrder().region and enumMonitors().bounds.
 */
import { enumMonitors, enumWindowsInZOrder } from "../../../src/engine/win32.js";

export interface BlankPoint {
  x: number;
  y: number;
}

/**
 * The desktop shell / wallpaper windows. These ARE the blank surface we want to
 * click, so they must NOT count as "occupied" — they span the whole screen, so
 * including them would make every point look covered (the scan would always
 * return null). "Progman" is the desktop; "WorkerW" hosts the wallpaper.
 */
const SHELL_CLASSES = new Set(["Progman", "WorkerW"]);

/** Avoid the failsafe corner — keep clear of FAILSAFE_RADIUS (10px) of (0,0). */
const FAILSAFE_AVOID = 16;
/** Keep away from screen edges (auto-hide bars, rounding). */
const EDGE_INSET = 24;
/** Keep away from the bottom taskbar. */
const TASKBAR_INSET = 80;
/** Scan grid step (px). */
const STEP = 32;

/**
 * Best-effort scan for an empty desktop point. Returns null if everything is
 * covered (caller should skip the test). Never throws — a native enumeration
 * failure also returns null.
 */
export function findBlankDesktopPoint(): BlankPoint | null {
  let monitors: ReturnType<typeof enumMonitors>;
  let windows: ReturnType<typeof enumWindowsInZOrder>;
  try {
    monitors = enumMonitors();
    windows = enumWindowsInZOrder();
  } catch {
    return null;
  }

  const rects = windows
    .filter((w) => !w.isMinimized && w.isCloaked !== true && !SHELL_CLASSES.has(w.className ?? ""))
    .map((w) => w.region)
    .filter((r) => r.width > 0 && r.height > 0);

  const covered = (x: number, y: number): boolean =>
    rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

  for (const m of monitors) {
    const b = m.bounds;
    const left = b.x + EDGE_INSET;
    const right = b.x + b.width - EDGE_INSET;
    const top = b.y + EDGE_INSET;
    const bottom = b.y + b.height - TASKBAR_INSET;
    // Scan from the RIGHT edge inward, top to bottom — the first uncovered,
    // non-failsafe point wins. Right-first is deliberate: desktop ICONS (the
    // Recycle Bin and friends) are NOT top-level windows, so they are invisible
    // to enumWindowsInZOrder and would otherwise read as "blank". Icons live in
    // the top-LEFT by default, so preferring the top-RIGHT avoids clicking them
    // (the old (50,50) blind click landed on the Recycle Bin at full-suite start).
    for (let x = right; x >= left; x -= STEP) {
      for (let y = top; y <= bottom; y += STEP) {
        if (x <= FAILSAFE_AVOID && y <= FAILSAFE_AVOID) continue;
        if (!covered(x, y)) return { x: Math.round(x), y: Math.round(y) };
      }
    }
  }
  return null;
}
