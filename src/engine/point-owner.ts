/**
 * point-owner.ts — who would take a press at this point.
 *
 * ADR-036 item 6, the middle rung of the specification's ladder for a coordinate press:
 *
 * > `mouse_click(x, y)` → if rect moved, apply homing correction → **if another top-level window
 * > covers point, block or refocus** → if target identity changed, invalidate coordinates
 *
 * The containment check that exists asks whether the point is inside the aimed window's rectangle.
 * That is a different question: a rectangle can contain a point that another window is drawn over,
 * and the press goes to whatever is on top. Measured on Windows 2026-09-09 (win2): a fixture's
 * presses were landing in `設定` / `XBOX` / `EAWorkWindow` windows sitting over the point, and read
 * as "nothing was pressed" because the fixture's own log stayed empty. The fixture was raised to
 * TOPMOST to get a clean cell for a different question, which is the right move for that cell and
 * quietly removed the evidence for this one.
 *
 * ## What this answers, and what it cannot
 *
 * The exact primitive is `WindowFromPoint`, which Windows resolves against real hit regions. This
 * module does not have it — the native bindings do not expose it yet — so it reconstructs the
 * answer from `enumWindowsInZOrder`: the frontmost enumerated window whose rectangle contains the
 * point. That is right in the ordinary case and blind in three named ways:
 *
 *   - **The enumeration drops windows.** Invisible, untitled and sub-50 px windows never appear, so
 *     a covering window with no caption is not seen. The failure direction is "looks clear when it
 *     is not", which is the dangerous one, and it is why this returns `unknown` rather than `aim`
 *     when it cannot enumerate at all.
 *   - **A rectangle is not a hit region.** Rounded corners, custom regions and per-pixel-alpha
 *     layered windows all take presses on some of their rectangle and not the rest.
 *   - **Click-through windows are excluded by style, not by behaviour.** `WS_EX_TRANSPARENT` is
 *     honoured here because that is what it means, but a window can be effectively click-through in
 *     other ways.
 *
 * When the native side gains `WindowFromPoint`, this becomes a fallback for builds without it
 * rather than the primary answer.
 */

import { enumWindowsInZOrder, type WindowZInfo } from "./win32.js";

/** `WS_EX_TRANSPARENT` — the style that says "presses pass through me". */
const WS_EX_TRANSPARENT = 0x00000020;

/**
 * Who is under the point, from the aim's point of view.
 *
 * `owned` is a first-class answer rather than a kind of `other`: a combo-box dropdown, a context
 * menu and a tooltip are separate top-level windows that sit OUTSIDE their owner's rectangle, and
 * they are exactly what the caller means to press when they discovered one. Treating them as
 * strangers would refuse the ordinary case (gate 2 raised this against the containment check,
 * which refuses them today).
 */
export type PointOwner =
  | { kind: "aim" }
  | { kind: "owned"; hwnd: bigint; title: string }
  | { kind: "other"; hwnd: bigint; title: string }
  | { kind: "unknown"; why: "enumeration_failed" | "no_window_at_point" };

/** Injectable so the classification can be tested without a desktop. */
export interface PointOwnerDeps {
  enumerate: () => WindowZInfo[];
}

function contains(w: WindowZInfo, x: number, y: number): boolean {
  const r = w.region;
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/**
 * Walk the owner chain from `hwnd` looking for `aim`.
 *
 * Uses the enumeration's own `ownerHwnd` rather than a fresh syscall so the answer is consistent
 * with the snapshot the rest of this function reasons about — a chain read a moment later can
 * disagree with the rectangles it is being matched against. Bounded because a corrupt chain must
 * not spin: eight hops is far past anything Windows produces (a dropdown's owner is its parent
 * window, and that is normally the whole chain).
 */
function isOwnedBy(start: WindowZInfo, aim: bigint, byHwnd: Map<string, WindowZInfo>): boolean {
  let owner = start.ownerHwnd ?? null;
  for (let hop = 0; hop < 8 && owner !== null; hop++) {
    if (owner === aim) return true;
    owner = byHwnd.get(String(owner))?.ownerHwnd ?? null;
  }
  return false;
}

/**
 * ADR-036 item 6 — who would take a press at `(x, y)`, given that the caller aimed at `aim`.
 *
 * Never throws: a question that cannot be asked answers `unknown`, and the caller must treat that
 * as "no evidence" rather than as "clear". The same rule as every other read on this path — a
 * build that cannot answer must not have every action refused, and must not have every action
 * waved through either, which is why the caller decides what `unknown` costs.
 */
export function whoIsUnderPoint(
  aim: bigint,
  x: number,
  y: number,
  deps: PointOwnerDeps = { enumerate: enumWindowsInZOrder },
): PointOwner {
  let windows: WindowZInfo[];
  try {
    windows = deps.enumerate();
  } catch {
    return { kind: "unknown", why: "enumeration_failed" };
  }
  if (windows.length === 0) return { kind: "unknown", why: "enumeration_failed" };

  const byHwnd = new Map(windows.map((w) => [String(w.hwnd), w]));
  const candidates = windows
    .filter((w) => !w.isMinimized && !w.isCloaked)
    .filter((w) => ((w.exStyle ?? 0) & WS_EX_TRANSPARENT) === 0)
    .filter((w) => contains(w, x, y))
    .sort((a, b) => a.zOrder - b.zOrder);

  const top = candidates[0];
  if (!top) return { kind: "unknown", why: "no_window_at_point" };
  if (top.hwnd === aim) return { kind: "aim" };
  if (isOwnedBy(top, aim, byHwnd)) return { kind: "owned", hwnd: top.hwnd, title: top.title };
  return { kind: "other", hwnd: top.hwnd, title: top.title };
}
