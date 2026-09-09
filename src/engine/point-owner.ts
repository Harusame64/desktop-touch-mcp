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
 *   - **Click-through is decided by style, not by a hit test.** A window is passed over only when
 *     it carries `WS_EX_TRANSPARENT` **and** `WS_EX_LAYERED`, the documented combination; a
 *     transparent non-layered window can still take the press, so it is treated as occluding. The
 *     error therefore falls on the side of a visible refusal rather than a silent press into an
 *     overlay.
 *
 * When the native side gains `WindowFromPoint`, this becomes a fallback for builds without it
 * rather than the primary answer.
 */

import { enumWindowsInZOrder, type WindowZInfo } from "./win32.js";

/**
 * `WS_EX_TRANSPARENT` + `WS_EX_LAYERED` — the documented combination for a click-through window.
 *
 * `WS_EX_TRANSPARENT` on its own is NOT a promise about hit testing: on a non-layered window it
 * governs painting order among siblings, and such a window can still take the press (PR 側 codex,
 * 2026-09-09). Skipping it there would classify the aim as "clear" and let the click land on the
 * overlay — the failure direction this whole module is written to avoid. So both bits are required
 * before a window is passed over, and everything else is treated as able to take a press.
 *
 * A window that IS effectively click-through by some other route is therefore reported as
 * occluding, and the caller gets a refusal naming a window it could have pressed through. That is
 * the cheaper mistake: it is visible, it names the window, and the caller can bring the aim
 * forward. The exact answer needs `WindowFromPoint` / `WM_NCHITTEST`, which the native bindings do
 * not expose.
 */
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_LAYERED     = 0x00080000;
const CLICK_THROUGH     = WS_EX_TRANSPARENT | WS_EX_LAYERED;

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
    .filter((w) => ((w.exStyle ?? 0) & CLICK_THROUGH) !== CLICK_THROUGH)
    .filter((w) => contains(w, x, y))
    .sort((a, b) => a.zOrder - b.zOrder);

  const top = candidates[0];
  if (!top) return { kind: "unknown", why: "no_window_at_point" };
  if (top.hwnd === aim) return { kind: "aim" };
  if (isOwnedBy(top, aim, byHwnd)) return { kind: "owned", hwnd: top.hwnd, title: top.title };
  return { kind: "other", hwnd: top.hwnd, title: top.title };
}
