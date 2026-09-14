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
 *   - **The enumeration drops windows.** The cause is the TITLE filter, isolated by measurement
 *     rather than inferred: two owned windows of the same size, same owner and same visibility,
 *     differing only in whether they had a caption — the titled one is listed, the untitled one is
 *     not (win2, 2026-09-10, `dev/adr036-items56-popups/`). So a `ComboLBox` dropdown, a
 *     `tooltips_class32` tip and any untitled popup are invisible here.
 *   - **A rectangle is not a hit region.** Rounded corners, custom regions and per-pixel-alpha
 *     layered windows all take presses on some of their rectangle and not the rest.
 *   - **Click-through is decided by style, not by a hit test.** See the mask below, and the
 *     measured overlay that this module reports as occluding while presses go straight through it.
 *
 * ## What `owned` really covers, measured
 *
 * The branch is NOT dead — the same round asked this function about five real popups. **Read the
 * verdict column with its condition**: it was asked with the desktop's own full-screen overlay
 * removed from the enumeration, because **asked as it ships, on a machine carrying one, every row
 * answers `other`** and says nothing about popups at all (the overlay is the subject of the mask
 * below; the raw record is `RESULTS-adr039-overlay.md` beside the table's own).
 *
 * So the column is what this logic decides ABOUT POPUPS, not what the build returns on that
 * desktop. Anyone reproducing it on a machine with such an overlay gets `other` everywhere, and
 * without this sentence would read that as the table being wrong rather than as the overlay
 * answering first.
 *
 *   | popup                        | class                                    | title | owner    | `owned`? |
 *   |------------------------------|------------------------------------------|-------|----------|----------|
 *   | modal `ShowDialog`           | WinForms                                 | yes   | the host | **yes**  |
 *   | modeless owned form          | WinForms                                 | yes   | the host | **yes**  |
 *   | ComboBox dropdown            | `ComboLBox`                              | none  | **none** | no       |
 *   | tooltip                      | `tooltips_class32`                       | none  | the host | no       |
 *   | Windows 11 context menu      | `Microsoft.UI.Content.PopupWindowSiteBridge` | yes | **the shell's XAML island** | no |
 *
 *   (verdicts with the overlay removed, as above — not the shipped answer on that desktop)
 *
 * So `owned` answers for **titled owned windows — dialogs** — which is exactly the case it was
 * written for: a dialog drawn INSIDE its owner's rectangle, whose remembered point must not be
 * moved by the owner's delta. What it cannot see:
 *
 *   - **An untitled popup never reaches the ownership test at all.** The answer is then about
 *     whatever is BEHIND it: a dropdown or tooltip drawn over its owner yields `aim` (and the press
 *     is allowed, correct, without this module ever seeing the popup), while one drawn OUTSIDE its
 *     owner yields `other` — a false refusal naming a window that is not in the way.
 *   - **`ComboLBox` has no owner at all** (`ownerHwnd` is 0). Removing the title filter is
 *     therefore necessary and NOT sufficient — and on its own it would make things worse: the
 *     dropdown would arrive as an unowned window on top and turn today's correct `aim` into a false
 *     `other`. Do not touch that filter before the hit test below exists.
 *   - **A Windows 11 context menu is owned by a shell island**, not by the application. It IS
 *     enumerated and it still answers `other`. No owner-chain rule can recognise it — neither
 *     review round predicted this, and it is not a filter that can be widened to fix.
 *
 * **Therefore `aim` is not evidence that a popup is absent.** It is what this function returns when
 * a popup it cannot see is sitting on top, so no rung may read it as "the entity's window is not
 * there" (see `measured_in_another_window` in the executor).
 *
 * When the native side gains `WindowFromPoint`, this becomes a fallback for builds without it
 * rather than the primary answer. **Note for that work**: `WindowFromPoint` returns the CHILD
 * window under the point — a button, not its frame — so the result has to be walked up to its root
 * before it is compared with a top-level handle, or the aim's own control reads as another window.
 */

import { enumWindowsInZOrder, getWindowTitleW, getWindowThreadId, windowFromPoint, isExcludedWindowHandle, isExcludedWindowAtPoint, type WindowZInfo } from "./win32.js";
import type { NativeWindowAtPoint } from "./native-types.js";

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
 *
 * **Measured, and both bits really are required** (win2, 2026-09-10, ADR-036 item 11). Two reviews
 * had said opposite things about this and neither had measured it: one read `WS_EX_TRANSPARENT` as
 * the hit-test rule for a top-level window, which would have made this mask a permanent block on
 * coordinate presses under any annotation or HUD overlay. The round put a titled, visible, >=50 px
 * overlay over a fixture whose buttons log their own presses, and read the fixture's log:
 *
 *   | overlay                            | exStyle read back | press |
 *   |------------------------------------|-------------------|-------|
 *   | none                               | —                 | lands |
 *   | plain opaque                       | `0x00050108`      | blocked |
 *   | `TRANSPARENT` only                 | `0x00050128`      | **blocked** |
 *   | `TRANSPARENT \| LAYERED`           | `0x000D0128`      | lands |
 *   | `LAYERED` only                     | `0x000D0108`      | blocked |
 *
 * So `TRANSPARENT` alone behaves exactly like a plain opaque window: for THOSE five overlays, the
 * mask below is not the cautious choice, it is the correct one.
 *
 * **And the sentence that used to follow was a false generalisation, measured false the same day.**
 * It read: *"An overlay carrying only that bit really does take the press, so refusing under it is
 * not a false refusal."* The round above built its `LAYERED`-only arm with
 * `SetLayeredWindowAttributes` — a whole-window alpha — and that one does take the press. A second
 * kind exists. `EAWorkWindow` (Dell DDPM) on the same machine is `WS_EX_LAYERED |
 * WS_EX_TOOLWINDOW | WS_EX_TOPMOST` — **no `TRANSPARENT`** — sits at z=0 over the whole 1920x1032
 * screen, titled and visible, and **presses go straight through it into the window below**,
 * measured with the fixture's own log (win2, 2026-09-10). `GetLayeredWindowAttributes` answers
 * `false` for it, because it is built with `UpdateLayeredWindow`: per-pixel alpha, which that API
 * cannot report.
 *
 * **So this mask produces a false refusal on any desktop carrying such an overlay** — and one of
 * them ships with a common monitor utility, covering the entire screen, so `whoIsUnderPoint`
 * answers `other` at EVERY point and every coordinate press is refused with "bring the intended
 * window forward" about a window that was never in the way.
 *
 * **No attribute distinguishes the two kinds.** `TRANSPARENT` is not set on either. `LAYERED`
 * alone is set on both, and the item 11 round proves it cannot mean "passes through".
 * `GetLayeredWindowAttributes` cannot read the one that does. What separates them is the pixel
 * alpha under the point, which only the OS holds — so the answer needs `WindowFromPoint` /
 * `WM_NCHITTEST`, and the note above about the native bindings stops being a footnote and becomes
 * the fix. Until then the mask stays as it is: widening it on a bit that means two things would
 * trade a visible false refusal for a silent press into an overlay.
 *
 * The reusable part is not about window styles. **One arm measured is not a kind measured** — the
 * round measured `SetLayeredWindowAttributes` windows and the comment spoke about layered windows.
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
/**
 * WHICH MECHANISM ANSWERED, because the two do not deserve the same trust.
 *
 * `os_hit_test` is Windows' own answer and resolves real hit regions — rounded corners, custom
 * regions, per-pixel alpha. `enumeration` is this module's reconstruction from rectangles, and its
 * blind spots are measured and written at the top of this file: it cannot see a click-through
 * overlay's transparency, and a window whose rectangle is not its hit region reads as covering a
 * point that presses fall through.
 *
 * A caller that REFUSES on this answer has to know which one it got. ADR-036 item 12 narrowed the
 * owned-window allowance — an owned window that is not where the pixels came from is an occluder —
 * and on the enumeration's answer that would invent a refusal out of a known blind spot, which is
 * the one thing this ladder may not do (gate: Opus sandbox review, 2026-09-10). Refusals ride on
 * `os_hit_test` only; the enumeration's answer still ALLOWS, exactly as before.
 *
 * **On EVERY verdict, not only the two that name a window.** It was first added where the decision
 * used it, which left the field absent exactly where a round needed it to read the record: the
 * real-machine cell for the excluded-window refusal asked which mechanism answered and could not be
 * told, because `blocked` and `aim` carried no `via` (win2, 2026-09-10,
 * `dev/pr618-excluded-window/`). The two roads now BOTH refuse on an excluded window, so "which
 * road refused" stopped being derivable from the verdict's shape — and the same round had to fall
 * back to a cross-reference from another day's file to say which mechanism its addon used.
 *
 * The rule this follows: **a field the decision needs and a field the RECORD needs are different
 * questions**, and the second one is answered by whoever reads the log, months later, without the
 * run. Absence here is not neutral — it makes two mechanisms print the same row.
 *
 * **REQUIRED, not optional, on every member.** Optional would have left the guarantee at "the
 * producers written today all set it": a new branch, or an injected `pointOwner` in a fixture,
 * could omit it and compile, and the serializer would drop the key and print the ambiguous row
 * again (PR 側 codex on #620, P2). A record the type system does not require is a record that
 * decays. It costs every test double one word — and that word is the road the double is standing
 * in for, which a double that refuses on the OS answer and one that allows on the enumeration's
 * genuinely have to state.
 */
export type PointOwnerVia = "os_hit_test" | "enumeration";

export type PointOwner =
  | { kind: "aim"; via: PointOwnerVia }
  | { kind: "owned"; hwnd: bigint; title: string; via: PointOwnerVia }
  | { kind: "other"; hwnd: bigint; title: string; via: PointOwnerVia }
  /**
   * A window that must stop the press and must not be described. `other` and `blocked` both refuse;
   * they differ in what the refusal is allowed to say, and that is exactly why `blocked` cannot be
   * a flavour of `unknown` — `unknown` means "no evidence", and every caller treats no evidence as
   * a reason to keep going (PR 側 codex on #618, P1).
   */
  | { kind: "blocked"; why: "excluded_window"; via: PointOwnerVia }
  | { kind: "unknown"; why: "enumeration_failed" | "no_window_at_point" | "unattributable_window"; via: PointOwnerVia };

/** Injectable so the classification can be tested without a desktop. */
export interface PointOwnerDeps {
  enumerate: () => WindowZInfo[];
  /**
   * ADR-036 item 6 — the OS hit test, when the addon has it.
   *
   * `undefined` means the question could not be asked (an addon built before it, or a failed call)
   * and the enumeration below answers instead. `null` means Windows says nothing is there, which is
   * an ANSWER and not a missing instrument — the two must not collapse into one value, which is the
   * mistake this ADR keeps finding elsewhere.
   */
  fromPoint?: (x: number, y: number) => NativeWindowAtPoint | null | undefined;
  /** Only used on the hit-test road, to name a window the caller is being told about. */
  titleOf?: (hwnd: bigint) => string;
  /** The aim's own thread, for the one comparison that is about "cannot tell" rather than ownership. */
  threadOf?: (hwnd: bigint) => number;
  /**
   * R3 tool exclusion, on the hit-test road. Injectable so a cell can say WHICH window is excluded
   * instead of leaning on a fake handle's PID read failing — with the real predicate, "excluded" and
   * "unreadable while armed" are the same answer on a machine with no addon, so a build that
   * refused every press while a locker was armed passed the cells that were meant to pin this
   * (gate 2, Opus sandbox review, 2026-09-10).
   */
  isExcluded?: (hwnd: bigint) => boolean;
  /**
   * R3 tool exclusion, on the ENUMERATION road, where the excluded window is not in the list at all.
   * See `isExcludedWindowAtPoint` for why this is a separate question rather than a filter.
   */
  excludedAtPoint?: (x: number, y: number) => boolean;
}

/** 0 means "could not read", and the caller treats it as no evidence rather than as a match. */
function threadOrZero(hwnd: bigint): number {
  try {
    return getWindowThreadId(hwnd);
  } catch {
    return 0;
  }
}

/** A window that has gone between the hit test and the read has no name, not a failed call. */
function titleOrEmpty(hwnd: bigint): string {
  try {
    return getWindowTitleW(hwnd);
  } catch {
    return "";
  }
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
  deps: PointOwnerDeps = {
    enumerate: enumWindowsInZOrder,
    fromPoint: windowFromPoint,
    titleOf: titleOrEmpty,
    threadOf: threadOrZero,
  },
): PointOwner {
  // ADR-036 item 6 — the OS first, because it is the question this module is a reconstruction OF.
  //
  // `WindowFromPoint` resolves real hit regions: rounded corners, custom regions, and per-pixel
  // alpha, which is where a layered overlay's transparency actually lives. The enumeration below
  // cannot see any of that, and on a desktop carrying a full-screen `UpdateLayeredWindow` overlay
  // it answers `other` at EVERY point while presses go straight through (measured 2026-09-10).
  const at = deps.fromPoint?.(x, y);
  if (at !== undefined) {
    // An answer, not a silence: Windows looked and found nothing there.
    if (at === null) return { kind: "unknown", why: "no_window_at_point", via: "os_hit_test" };
    // **An excluded window stops the press and is not described.** The enumeration below never sees
    // one — `enumWindowsInZOrder` filters by the same predicate — but `WindowFromPoint` asks the OS,
    // and the OS does not know about this server's registry. Until ADR-036 item 13 the difference
    // stayed inside the loop; now the covering window's title and handle are published in the
    // refusal, so the key locker's secure dialog would hand back exactly what the registry exists to
    // withhold — and confirm, by naming it, that the window over the point IS the locker (gate 2,
    // Opus sandbox review, 2026-09-10).
    //
    // **The first answer to that was `unknown`, and it was wrong** — with a sentence beside it
    // claiming "the press is refused by containment where it would have been refused anyway". It is
    // not: `unknown` means no evidence, the ladder falls through to containment, and a locker dialog
    // drawn INSIDE its owner's rectangle leaves the point `inside` — so the press went out, into the
    // secure dialog, on the one road the exclusion exists to close. Before item 13 this answered
    // `other` and refused (PR 側 codex on #618, P1). Two things a verdict can be — "refuse" and
    // "say nothing about it" — were collapsed into one word.
    //
    // Asked BEFORE `at.root === aim`, and it can only answer yes while a locker is armed (an empty
    // registry short-circuits inside the predicate, with no syscall). So a handle recycled onto the
    // locker's own window is refused here too, which is the press this registry exists to prevent —
    // and on an ordinary desktop the test runs and never returns.
    //
    // **The one false refusal this order can produce**: an aimed window destroyed between the hit
    // test and the PID read reads as unreadable-while-armed, so the caller gets this refusal instead
    // of `aim_window_gone`. Wrong sentence, right outcome — nothing should be pressed there either.
    // The alternative order opens a real hole: a handle recycled onto the locker would answer `aim`
    // and be pressed. Recorded so a reader debugging that envelope is not hunting a locker that was
    // never over the point (gate 2, Opus sandbox review, 2026-09-10).
    if ((deps.isExcluded ?? isExcludedWindowHandle)(at.root)) return { kind: "blocked", why: "excluded_window", via: "os_hit_test" };
    // The primitive returns the CHILD under the point — the aim's own button is not another window.
    if (at.root === aim) return { kind: "aim", via: "os_hit_test" };
    // Ownership by `GW_OWNER`, every hop. This is the one field that was measured to separate an
    // owned modal from an ordinary second window of the same application — the two were identical
    // in thread, in process, in `GA_ROOTOWNER` and in their whole window style (win2, 2026-09-10).
    if (at.ownerChain.some((h) => h === aim)) {
      return { kind: "owned", hwnd: at.root, title: deps.titleOf?.(at.root) ?? "", via: "os_hit_test" };
    }
    // **Cannot attribute, which is not the same as "a stranger".**
    //
    // A `ComboLBox` dropdown has NO owner at all, so no ownership rule reaches it — and until this
    // road existed it was INVISIBLE to us (untitled, so the enumeration dropped it) and the answer
    // came back `aim`, letting the press through, correctly. Asking Windows makes the dropdown
    // visible for the first time, and calling it `other` would turn every combo-box press on every
    // desktop into a refusal: a rung that breaks what worked, which this ladder may not do.
    //
    // So a captionless window on the aim's own thread answers `unknown`. **And the rule is about
    // the CAPTION, not about popups** — measured, and the decisive arm was an ordinary second
    // window of the application with nothing changed but its title erased: `other` with a caption,
    // `unknown` without one (win2, 2026-09-10). A splash screen and a custom-chrome frame answer
    // `unknown` too.
    //
    // That is the cost of this rung, stated plainly: an application's own untitled second window —
    // a tool palette, a custom frame, a window opened before its document — takes a press here as
    // though it were the aim's dropdown. `unknown` is chosen anyway, because the alternative is
    // `other`, and `other` refuses every combo-box press on every desktop: a rung breaking what
    // worked. What it claims is only "no evidence either way"; the caller keeps the behaviour it
    // had before this road existed, which for all of these windows was to press.
    //
    // **Two kinds of context menu, and they are different things rather than two implementations
    // of one** (win2, 2026-09-10, re-measured after the first reading turned out to be an
    // instrument fault — see below):
    //
    //   - the APPLICATION's own menu is the classic `#32768`: its own thread, no caption. It
    //     reaches the rung above and answers `unknown`, so the press goes through. Ten right-clicks
    //     on a fixture's text box produced it ten times out of ten.
    //   - a SHELL menu — the desktop's, Explorer's — is `Microsoft.UI.Content.PopupWindowSiteBridge`
    //     on a different thread and a different process, owned by the shell's XAML island. Nothing
    //     here can attribute it to the aimed application, and it answers `other`. That is correct:
    //     it really is not the application's window.
    //
    // **A claim this file carried for one commit is withdrawn**: that the same right-click on the
    // same control raises either kind, so a user pressing an item in their own menu would be
    // refused at random. The round that appeared to show it was clicking (0, 0) — a lookup returned
    // null and the driver right-clicked the desktop — so the WinUI menu observed was the SHELL's,
    // at `[-10, 0]`, nowhere near the fixture. The control in force checked that the fixture was
    // alive and logging presses; it did not check that the arm's click landed inside the window it
    // was aimed at. Recorded because the correction is more useful than the claim was.
    const aimThread = deps.threadOf?.(aim);
    if (!at.rootHasCaption && aimThread !== undefined && aimThread !== 0 && at.rootThreadId === aimThread) {
      return { kind: "unknown", why: "unattributable_window", via: "os_hit_test" };
    }
    return { kind: "other", hwnd: at.root, title: deps.titleOf?.(at.root) ?? "", via: "os_hit_test" };
  }

  // **The excluded window is not in the list below, and that is not safety.** `enumWindowsInZOrder`
  // filters it out, so the reconstruction answers about whatever is BEHIND it — on an ordinary
  // desktop, the caller's own window — and returns `aim`, which allows the press. The locker dialog
  // then takes it. The same defect the hit-test road had, reached through the other door, and the
  // door every build without `win32WindowFromPoint` uses (gate 2, Opus sandbox review, 2026-09-10).
  //
  // Asked before the enumeration rather than folded into it, because the answer has to come from the
  // RAW list: a predicate applied to a filtered list can only confirm what the filter already
  // removed. Same reason `isExcludedTitle` enumerates raw, written a year earlier.
  if ((deps.excludedAtPoint ?? isExcludedWindowAtPoint)(x, y)) {
    return { kind: "blocked", why: "excluded_window", via: "enumeration" };
  }

  let windows: WindowZInfo[];
  try {
    windows = deps.enumerate();
  } catch {
    return { kind: "unknown", why: "enumeration_failed", via: "enumeration" };
  }
  if (windows.length === 0) return { kind: "unknown", why: "enumeration_failed", via: "enumeration" };

  const byHwnd = new Map(windows.map((w) => [String(w.hwnd), w]));
  const candidates = windows
    .filter((w) => !w.isMinimized && !w.isCloaked)
    .filter((w) => ((w.exStyle ?? 0) & CLICK_THROUGH) !== CLICK_THROUGH)
    .filter((w) => contains(w, x, y))
    .sort((a, b) => a.zOrder - b.zOrder);

  const top = candidates[0];
  if (!top) return { kind: "unknown", why: "no_window_at_point", via: "enumeration" };
  if (top.hwnd === aim) return { kind: "aim", via: "enumeration" };
  if (isOwnedBy(top, aim, byHwnd)) return { kind: "owned", hwnd: top.hwnd, title: top.title, via: "enumeration" };
  return { kind: "other", hwnd: top.hwnd, title: top.title, via: "enumeration" };
}
