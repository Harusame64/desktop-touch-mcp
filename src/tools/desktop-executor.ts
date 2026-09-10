/**
 * desktop-executor.ts — Route desktop_act actions to the appropriate native backend.
 *
 * Priority order:
 *   1. uia      → clickElement / setElementValue (UIA Invoke/ValuePattern)
 *   2. cdp      → CDP click via screen coords / evaluateInTab fill
 *   3. terminal → background WM_CHAR injection (no focus steal); explicit fail if unsupported
 *   4. mouse    → mouse click at entity rect center (visual-only fallback)
 *
 * All deps are injectable so tests can mock every route without OS bindings.
 * Real deps are imported lazily (dynamic import) to keep module load light —
 * with one static exception: `_resolve-log.js` (ADR-035 Phase 1 observation),
 * which has to be reachable from the closures below and pulls in no native
 * binding of its own.
 *
 * G2: terminal route now uses background WM_CHAR path via bg-input.ts.
 *     On unsupported windows (Chromium, UWP) it throws explicitly so the caller
 *     gets ok:false reason:"executor_failed" and can fall back to V1 terminal({action:'send'}).
 */

import type { UiEntity, ExecutorKind, ExecutorOutcome } from "../engine/world-graph/types.js";
import { logResolve, logDispatchSink } from "./_resolve-log.js";
import type { TouchAction } from "../engine/world-graph/guarded-touch.js";
import { assertCoordinateReachable } from "../engine/reachable-bounds.js";
import { WindowExcludedError } from "../engine/tool-exclusion.js";
import { probeAim, aimProbeEnabled, readWindowIdentity } from "../engine/aim-probe.js";
import { whoIsUnderPoint, type PointOwner } from "../engine/point-owner.js";
import {
  toAim,
  compareAimIdentity,
  readWindowIdentityFields,
  homingCorrectionForSources,
  observedHwndOfOrigin,
  containsPoint,
  type Aim,
  type WindowIdentity,
  AimIdentityChangedError,
  AimOccludedError,
  AimBlockedByExcludedWindowError,
  AimedWindowGoneError,
  AimedPointOutsideWindowError,
  AimedRouteFailedError,
  AIM_WINDOW_GONE,
} from "../engine/aim.js";
import type { TargetSpec } from "../engine/world-graph/session-registry.js";
import type { AdvertisedExecutorKind } from "../capabilities/registry.js";

// ── Injectable backend interface ──────────────────────────────────────────────

export interface ExecutorDeps {
  /**
   * UIA Invoke: click/invoke by label (name) or automationId.
   *
   * ADR-036 — `hwnd` names the window the caller actually resolved. When it is present the
   * backend addresses that handle and does not look a window up by title, so a second window
   * answering to the same title cannot take the action. Trailing and optional so a backend
   * (or a test double) that ignores it still satisfies the interface.
   */
  uiaClick(windowTitle: string, name?: string, automationId?: string, hwnd?: bigint): Promise<void>;
  /** UIA ValuePattern: type text into a textbox. `hwnd` as in {@link ExecutorDeps.uiaClick}. */
  uiaSetValue(windowTitle: string, value: string, name?: string, automationId?: string, hwnd?: bigint): Promise<void>;
  /** CDP: click a DOM element by CSS selector. */
  cdpClick(selector: string, tabId?: string): Promise<void>;
  /** CDP: fill a text input by CSS selector.
   * NOTE: uses DEFAULT_CDP_PORT (9222). Phase 2 should extend TargetSpec with optional cdpPort. */
  cdpFill(selector: string, value: string, tabId?: string): Promise<void>;
  /**
   * Terminal: send text to a terminal window via background WM_CHAR injection (G2).
   * Does not steal focus. Throws explicitly for unsupported windows (Chromium, UWP).
   * On failure, caller sees ok:false reason:"executor_failed" and can fall back to V1 terminal({action:'send'}).
   */
  terminalSend(windowTitle: string, text: string, hwnd?: bigint): Promise<void>;
  /**
   * Issue #327 item E: UIA `setValue` fallback. Posts WM_CHAR to the focused child
   * of the target window via `bg-input.ts::postCharsToHwnd`. Used when the primary
   * UIA `ValuePattern` route throws (e.g. Notepad's RichEditD2DPT entity whose
   * locator name/automationId cannot be re-found by `makeSetElementValueScript`).
   * Throws on unsupported windows (Chromium / WT-XAML) — caller surfaces
   * executor_failed and the LLM's `if_unexpected.try_next` from PR #329 points
   * at `keyboard({action:'type', text, method:'foreground'})` as the next rung
   * (FG SendInput bypasses BG injection restrictions).
   *
   * Success returns the `"keyboard"` ExecutorKind. Note that `"keyboard"` is an
   * internal-fallback-only executor — it is NOT advertised in
   * `UiAffordance.executors` / `UiEntity.unsupportedExecutors` (both remain the
   * 4-executor union). See `types.ts::ExecutorKind` JSDoc for the
   * advertised-surface rationale.
   */
  keyboardTypeBg(windowTitle: string, text: string, hwnd?: bigint): Promise<void>;
  /** Mouse: click at absolute screen coordinates. */
  mouseClick(x: number, y: number): Promise<void>;
  /**
   * ADR-036 — where the aimed window is NOW, so a coordinate press can be checked against it.
   *
   * `null` means "no rectangle came back", which is NOT the same as "the window is gone":
   * `getWindowRectByHwnd` also answers null when the native win32 binding is missing or the call
   * throws, and this repo ships builds without that module. Reading null as gone refused every
   * pinned coordinate press on such a build, with the message "the window you aimed at no longer
   * exists" about a window on screen (2ゲート目の指摘) — the same conflation `isWindowGone` was
   * written to avoid, reintroduced one file over. {@link ExecutorDeps.aimIsGone} is what earns the
   * difference.
   *
   * Optional, and omitting it skips the check rather than blocking the press: a test double that
   * does not care about coordinates should not have to grow one. Production passes
   * `getWindowRectByHwnd`.
   */
  aimRect?(hwnd: bigint): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /**
   * ADR-036 — whether the handle is known NOT to name a window any more.
   *
   * Consulted only when {@link ExecutorDeps.aimRect} returned null, to tell "gone" from "cannot
   * tell". Production passes `isWindowGone`, which answers **false** whenever the binding could
   * not be asked, so only a successful call is evidence. Absent (or false) means the containment
   * check is skipped for this press: it goes out the way it did before this ADR existed, which is
   * a known blind press and strictly better than refusing every press on a build that cannot
   * answer the question.
   *
   * Async so production can reach `win32` through the same dynamic import every other dep uses;
   * a test double may return a plain boolean.
   */
  aimIsGone?(hwnd: bigint): Promise<boolean> | boolean;
  /**
   * ADR-036 — who owns the aimed handle right now.
   *
   * `undefined` means the question could not be answered — no native binding, the window already
   * gone, a build that cannot ask — and that is NOT evidence of a different window: the comparison
   * treats it as `"unknown"` and lets the action through, because refusing on an unanswered
   * question would take every aimed action down on such a build.
   *
   * Optional, so a test double that does not care about identity need not grow one; absent means
   * no comparison is made, and the probe records that as its own row rather than as a silent pass.
   */
  aimIdentity?(hwnd: bigint): Promise<WindowIdentity | undefined> | WindowIdentity | undefined;
  /**
   * ADR-036 item 6 — who would take a press at this point, from the aim's point of view.
   *
   * `"other"` blocks the press: the window on top would have taken it. `"owned"` allows it even
   * where the aim's own rectangle does not reach, because that is where a dropdown or a context
   * menu lives. `"unknown"` is not a verdict — the containment check decides, exactly as it did
   * before this dep existed.
   *
   * Optional so a test double need not grow one, and so a build whose enumeration cannot answer
   * loses only this rung rather than the whole press.
   */
  pointOwner?(aimHwnd: bigint, x: number, y: number): PointOwner | undefined;
}

// ── G2: Background terminal send — injectable for testing ─────────────────────

/**
 * Injectable deps for the background terminal send path.
 * Exported so unit tests can exercise the routing logic without OS bindings.
 */
export interface TerminalBgDeps {
  /** Find terminal window by title substring. Returns undefined if not found. */
  findWindow(windowTitle: string): { hwnd: unknown; title: string } | undefined;
  /** Check if WM_CHAR injection is supported for this HWND. */
  canBgSend(hwnd: unknown): { supported: boolean; reason?: string; className?: string };
  /** Send text to HWND via WM_CHAR. Returns partial result if send was incomplete. */
  bgSend(hwnd: unknown, text: string): { sent: number; full: boolean };
}

/**
 * Core background terminal send logic — separated for testability.
 *
 * Throws if:
 *   - Window not found by title
 *   - Background injection not supported (Chromium, UWP, etc.)
 *   - Send incomplete (partial write)
 *
 * Never falls back to foreground focus-steal (G2 contract).
 */
export function terminalBgExecute(
  windowTitle: string,
  text: string,
  deps: TerminalBgDeps
): void {
  const win = deps.findWindow(windowTitle);
  if (!win) throw new Error(`Terminal window not found: "${windowTitle}"`);

  const check = deps.canBgSend(win.hwnd);
  if (!check.supported) {
    throw new Error(
      `Background terminal send not supported for "${windowTitle}" ` +
      `(${check.reason ?? "unknown"}, class: ${check.className ?? "?"}).` +
      ` Use V1 terminal(action='send') as fallback.`
    );
  }

  const result = deps.bgSend(win.hwnd, text);
  if (!result.full) {
    throw new Error(
      `Background terminal send incomplete: sent ${result.sent}/${text.length} chars to "${windowTitle}"`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ADR-036 item 2 — the two helpers that used to live here, `resolveWindowTitle(target)` and the
// call to `parseTargetHwnd(target)`, are gone into the aim itself (`engine/aim.ts`). Both read the
// same `TargetSpec` and each answered half of "which window is this?", which is precisely how the
// two halves came to disagree: the title helper answered `windowTitle ?? "@active"` while the
// registry keyed sessions `hwnd > tabId > windowTitle`. One value with both fields cannot hold two
// opinions. `"@active"` is still what the title-only backends are told when there is no title.

/**
 * ADR-036 — where a coordinate press on a pinned session actually goes.
 *
 * The specification's ladder for `mouse_click(x, y)`, in its order:
 *
 * >   -> check cached target rect and z-order
 * >   -> refresh target rect via Win32 if stale or dirty
 * >   -> if rect moved, apply homing correction
 * >   -> if another top-level window covers point, block or refocus
 * >   -> if target identity changed, invalidate coordinates
 *
 * All three rungs are here now — identity one level up, before a route is even chosen, because a
 * changed identity makes every rectangle in this function meaningless. This RETURNS the point to
 * press rather than asserting about the one it was handed: the correction and the checks have to
 * be talking about the same point, and a function that validates one while the caller presses
 * another validates nothing.
 *
 * The mouse route is not a downgrade: for an entity whose only affordance is visual — an OCR
 * label, a `read`-only control — it is the route, and refusing it outright would take the
 * capability away from exactly the windows UIA cannot see. What it must not be is BLIND. The
 * point comes from a rect remembered at discover time, and a window that has since moved,
 * minimised or closed leaves that point over something else, which then takes the press.
 *
 * Measured on Windows 2026-09-09: pinned `desktop_act` on `read` entities pressed the remembered
 * rect and returned `ok:true` with no `downgrade` — invisible to the caller and to the guard
 * that ends the ladder after a failed UIA attempt, because there was no failed attempt.
 *
 * What this does NOT prove, in the order the holes were found:
 *
 *   - Containment is not identity WITHIN the window, and a different CONTROL takes the press.
 *     Measured on Windows 2026-09-09 (win2, five stacked buttons whose own click handlers write to
 *     a log): a lease taken on the title bar, the window moved 71 px up, the remembered point left
 *     where it was — `desktop_act` returned `ok:true`, `executor:"mouse"`, and the button that
 *     logged the press was `BTN1`, which the lease had never named. Three independent channels
 *     agreed: the rect read from outside (top 200 → 129), `AutomationElement::FromPoint`
 *     (`CELL BUTTONS` → `BTN1`), and the button's own log line. Nothing in the envelope shows it —
 *     `observation.motion` was `no_change` and `residual.fractionChanged` was 0.
 *
 *     So containment catches the move that takes the point OUT of the window (and minimise, which
 *     parks the rect at -32000, and a window that is gone); it never catches the move that keeps
 *     the point inside, and that case pressed whatever had arrived under the point.
 *
 *     The population is narrower than it looks: only entities that reach the mouse route get here,
 *     which in that fixture meant the `read` / `primaryAction:"read"` class. A button whose
 *     `preferredExecutors` lead with `uia` goes down the UIA road and never asks this question.
 *
 *     **Closed by the homing correction (item 5).** The aim carries the window origin those
 *     coordinates were measured against, and a window that moved without resizing moves the point
 *     with it. What is still NOT closed: a window that RESIZED — the contents may have reflowed,
 *     and translating a point through a reflow is inventing a layout — and a control that moved
 *     inside a window that did not. Both leave the point where it was and say so in the row.
 *   - That the aimed window is the topmost one at that point. **Closed by item 6**
 *     (`point-owner.ts`), approximately: the z-order enumeration answers who is under the point,
 *     `WindowFromPoint` is the exact primitive and is not bound, and the three blind spots that
 *     leaves are named in that file.
 *
 * This paragraph is written twice as long as it wants to be because its first version claimed the
 * middle case ("catches what was measured — moved, minimised, gone") and the measurement above
 * says otherwise. A comment is a claim, not a check.
 */
async function resolvePressPoint(
  deps: ExecutorDeps,
  aim: Aim,
  /**
   * ADR-036 item 12 — the window these COORDINATES were measured in, which is not always the window
   * the call named. Passed in rather than read off the aim, because for a title-only discover the
   * aim has no handle at all and the entity does.
   */
  aimHwnd: bigint | undefined,
  /** ADR-036 item 5 — its sources say whether the bracketed origin can describe its coordinates. */
  entity: UiEntity,
  x: number,
  y: number,
  label: string,
  /**
   * ADR-036 item 12 — the failure this call is already recovering FROM, when it is one.
   *
   * Only the UIA downgrade road has one: UIA click failed, and the mouse press that would have
   * covered for it is what the ladder below may refuse. Without it the caller sees the refusal and
   * not the failure that made the coordinate road the road (gate 2, 2026-09-10) — and "UIA could
   * not find the element" is usually the more useful half for whoever has to decide what to do
   * next. Attached to every refusal this function makes, because any of its rungs can be the one
   * that ends that recovery.
   */
  cause?: unknown,
): Promise<{ x: number; y: number }> {
  /** `undefined` rather than `{ cause: undefined }`: an absent cause must not print as one. */
  const because: ErrorOptions | undefined = cause !== undefined ? { cause } : undefined;
  // Narrowed rather than asserted. The caller only reaches here with a handle, and an assertion
  // would keep that true by decree: this way a caller that stops checking loses the ladder, which
  // is what it did before the ladder existed, instead of throwing inside it.
  if (aimHwnd === undefined) return { x, y };
  // ADR-036 item 12 — where this handle came from, written into every row and every refusal below.
  //
  // Without a source field, a title-only run produces a handle that appears from nowhere: one act
  // says the call named none, the next row shows one, and nothing in the trace says the executor
  // inferred it from `entity.origin` (gate 2, 2026-09-10). The refusals had the same problem in
  // prose — they said "the window this call named" about a window the call never named, and on this
  // road the call named a TITLE.
  //
  // **The row's NAME was half of that defect, and it survived the first fix** (gate 2, same day).
  // The ladder wrote its handle as `aimHwnd`, the field `act.aim` uses for the handle the CALL
  // named, so one act produced `act.aim{aimHwnd:null}` and then `act.route{aimHwnd:"4919"}` — one
  // name carrying two facts, beside the `hwndFrom` that had just been added to separate them. From
  // `df2b4d4` the ladder writes `coordHwnd` / `coordHwndFrom` (the names the mouse rows already
  // used) and `aimHwnd` means "the handle the call named" in every row.
  //
  // **Sweeps taken before that commit quote the old names**, and they are not wrong — they are what
  // the build wrote. Read `act.route{aimHwnd:"4919", hwndFrom:"entity_origin"}` from an older
  // record as today's `coordHwnd` / `coordHwndFrom`. Records are annotated rather than rewritten,
  // because rewriting a record makes it agree with code that never produced it (win2, 2026-09-10).
  const handleFrom = aimHwnd === aim.hwnd ? "aim" : "entity_origin";
  /** Named the way the caller would recognise it, which is not the same sentence on both roads. */
  const theWindow = handleFrom === "aim"
    ? `the window this call named (hwnd ${aimHwnd})`
    : `the window these coordinates were measured in (hwnd ${aimHwnd}, from the entity's origin)`;
  if (!deps.aimRect) {
    // A skipped check writes a row saying so. Without it the log shows a press with a handle and
    // no containment row, which reads exactly like a build that never reached this line.
    // Both rows, because both rungs were skipped. A press with an aim and no `homing` row reads
    // exactly like a build that never reached the rung — the failure the reasons in that row were
    // written to prevent, one level up.
    probeAim("act.route", { route: "homing", checked: false, why: "no_aim_rect_dep", coordHwnd: aimHwnd.toString(), coordHwndFrom: handleFrom, from: { x, y }, label });
    probeAim("act.route", { route: "containment_check", checked: false, why: "no_aim_rect_dep", coordHwnd: aimHwnd.toString(), coordHwndFrom: handleFrom, point: { x, y }, label });
    return { x, y };
  }
  const rect = await deps.aimRect(aimHwnd);
  if (!rect) {
    // No rectangle is two different facts. Only a source that can say so reports the window gone;
    // everything else is "cannot tell", and a check that cannot be made is skipped rather than
    // turned into a refusal about a window that may well be on screen (see the deps' JSDoc).
    if (await deps.aimIsGone?.(aimHwnd)) {
      throw new AimedWindowGoneError(aimHwnd, `no rectangle for it`, because,
        `${theWindow.charAt(0).toUpperCase()}${theWindow.slice(1)}`);
    }
    probeAim("act.route", { route: "homing", checked: false, why: "no_rectangle_and_not_gone", coordHwnd: aimHwnd.toString(), coordHwndFrom: handleFrom, from: { x, y }, label });
    probeAim("act.route", { route: "containment_check", checked: false, why: "no_rectangle_and_not_gone", coordHwnd: aimHwnd.toString(), coordHwndFrom: handleFrom, point: { x, y }, label });
    return { x, y };
  }

  // ADR-036 item 5 — the specification's FIRST rung, and the one the implementation did not have:
  // *if rect moved, apply homing correction*. The point came from a rectangle measured against the
  // window origin at discover time; when the window has moved and kept its size, the point the
  // caller means is the same offset inside it. Everything below — occlusion, containment, the
  // press itself — uses the corrected point, because a ladder that checks one point and presses
  // another is checking nothing.
  // ADR-036 item 12 — WHOSE origin this is. The rectangle in `aim.origin` was measured around the
  // window `toAim` resolved, and `rect` above is now read from `aimHwnd`, which on this road came
  // from the ENTITY. When those are two different windows the origin's delta was measured somewhere
  // else, and subtracting it moves the point by a distance nothing here has a reason for:
  // reproduced by construction with a hand-built `Aim` — a silent 500 px displacement (gate 2,
  // 2026-09-10). `measured_in_another_window` cannot catch it, because the aim that has no handle
  // gives the guard nothing to compare and absence is deliberately "no evidence" there.
  //
  // Production never reaches it — `readOriginRectForTarget` returns nothing for a target that
  // resolved to no handle, so an origin without a handle is not recorded — but that invariant lives
  // in another file, and a ladder that presses coordinates must not depend on a caller it does not
  // control. No origin for THIS window is exactly `no_origin_rect`: the correction is declined and
  // nothing else about the ladder changes.
  const origin = aimHwnd === aim.hwnd ? aim.origin : undefined;
  let homing = homingCorrectionForSources(entity.sources, origin, rect, x, y, {
    capturedIn: observedHwndOfOrigin(entity.origin),
    originOf: aim.hwnd,
  });
  // ADR-036 item 5 — the correction is about the AIMED window, and a point can belong to a window
  // merely drawn inside it. A modal dialog, or a dropdown that opens OVER its combo, is a top-level
  // window of its own whose centre falls inside the owner's rectangle — and it does NOT move when
  // its owner moves. Applying the owner's delta there moves a point that was already right, and the
  // ownership test below then runs at the moved point and can see the owner as clear (PR 側 codex
  // on #609, second round). That is a press the code got right before this rung existed.
  //
  // The question is put to the screen at the REMEMBERED point, and only when a correction would
  // otherwise be adopted. An owned window sitting there is reason to leave the point alone: the
  // entity MAY belong to it, that window has not moved, and the press then goes out exactly as it
  // did before this rung, where the `owned` allowance below lets it through.
  //
  // **"May" is doing real work, and it now has evidence against it in some cases.** When the entity
  // records the window its pixels came from and that window IS the aim, the entity did not come out
  // of the popup — so a popup that happens to sit on the remembered point says nothing, and
  // dropping the correction there sends the press into the popup instead of following the aim's own
  // control to where it moved (PR 側 codex, 2026-09-10). The evidence arrived one commit earlier,
  // in `capturedIn`, and this line was still reading only the screen.
  //
  // An unrecorded origin still suppresses, because absence is not evidence either way and that is
  // the behaviour every entity had before the handle existed. The mistake this risks is a declined
  // correction, which costs the press nothing.
  const capturedIn = observedHwndOfOrigin(entity.origin);
  if (homing.applied && capturedIn !== aimHwnd && deps.pointOwner?.(aimHwnd, x, y)?.kind === "owned") {
    homing = { applied: false, x, y, why: "owned_popup_at_remembered_point" };
  }
  probeAim("act.route", {
    route: "homing",
    coordHwnd: aimHwnd.toString(),
    coordHwndFrom: handleFrom,
    // The origin as the aim holds it, so a row can be read without the run that produced it.
    // `null` for one that was never taken, and `{kind:"moved_during_read"}` for one that was taken
    // and says the coordinates are unusable: "nobody looked", "the correction declined to move it"
    // and "the window would not hold still" are three different facts and only two of them are
    // about the window.
    origin: origin ?? null,
    windowRect: rect,
    from: { x, y },
    to: { x: homing.x, y: homing.y },
    applied: homing.applied,
    delta: homing.applied ? { dx: homing.dx, dy: homing.dy } : null,
    why: homing.applied ? null : homing.why,
    label,
  });
  x = homing.x;
  y = homing.y;

  const inside = containsPoint(rect, x, y);

  // ADR-036 item 6 — who would actually take this press. The specification's ladder asks this
  // between the moved-rectangle correction and the identity check, and it answers a different
  // question from containment: a rectangle can contain a point that another window is drawn over.
  //
  // It runs BEFORE the containment verdict is acted on, because it can also overrule it. A combo
  // dropdown, a context menu and a tooltip are separate top-level windows that sit outside their
  // owner's rectangle, and they are what the caller means to press when they discovered one —
  // refusing those as "the point left the window" is a false refusal the containment check makes
  // today (gate 2).
  //
  // Asked before this rung's own refusals are acted on, and the reason is a regression the resize
  // refusal introduced (gate 2, third pass): a dropdown or a modal drawn OVER its owner has its
  // centre INSIDE the owner's rectangle, so the correction gets past `point_was_outside_origin`
  // and answers `window_resized` about a window the entity does not live on. The entity is on a
  // separate top-level window that did not resize, and before this commit `owned` let it through.
  const owner = deps.pointOwner?.(aimHwnd, x, y);
  probeAim("act.route", {
    route: "containment_check",
    checked: true,
    coordHwnd: aimHwnd.toString(),
    coordHwndFrom: handleFrom,
    point: { x, y },
    windowRect: rect,
    inside,
    pointOwner: owner ? { kind: owner.kind, ...("hwnd" in owner ? { hwnd: owner.hwnd.toString(), title: owner.title, ...(owner.via ? { via: owner.via } : {}) } : {}), ...("why" in owner ? { why: owner.why } : {}) } : null,
    // WHOSE window it was checked against, said out loud. `checked:true` alone claims the point was
    // validated against the entity's window, and on this road nothing has verified that the handle
    // still NAMES that window: identity invalidation is gated on `aim.hwnd`, and a title-only act
    // has none, so a recycled handle produces a row that says "checked" about a stranger (Opus
    // sandbox review, 2026-09-10 — a residual, since the pre-ADR code pressed there with no row at
    // all). "Checked" and "checked against the right window" must not share a representation.
    identityBaseline: aim.identity !== undefined && aimHwnd === aim.hwnd ? "compared" : "none",
    label,
  });
  if (owner?.kind === "blocked") {
    // A security refusal, and it is asked before every rung below. Those rungs change what the
    // caller should do next — restore a minimised window, re-discover after a resize — and none of
    // them changes whether THIS press may go out. Answering one of them first would also make the
    // ladder's order the thing that decides whether a locker dialog is pressed.
    //
    // **Nothing about the covering window is said**: not its handle, not its title, not its
    // process. Naming it would hand back what the exclusion registry exists to withhold, and would
    // confirm by naming that the window over the point IS the locker (gate 2, Opus sandbox review).
    // What the caller gets is the coordinates it already had and the fact that something there is
    // out of bounds — the least that can be said while still refusing.
    //
    // Its own class and its own reason, NOT `WindowExcludedError`. The first version of this rung
    // reused that one because `reason:"window_excluded"` already carried the line this case needs —
    // "Do NOT retry by coordinate ... a route that does not check the exclusion". It carries three
    // others, and two of them are false here: they tell the caller that THEIR window is excluded and
    // that they should go act on a different one, when their window is fine and something else is
    // over the point. One apt line out of four is not "the advice this case needs" (gate 2, Opus
    // sandbox review, 2026-09-10) — and the fourth line names the key locker, delivering in prose
    // the identification the detail was carefully written not to give.
    //
    // **The residual, stated rather than hidden**: a caller that presses point after point still
    // learns WHERE something out of bounds is, because a refusal is an answer. All three options
    // leak that much; the other two add the window's title, or the keystroke itself.
    throw new AimBlockedByExcludedWindowError(
      `Refusing to click (${x}, ${y}) for "${label}": a window this server may not act through is ` +
      `over that point. Nothing was clicked. Nothing about that window is named here — not its ` +
      `title, not its handle — and it is not the window these coordinates were measured in.`,
      because,
    );
  }
  if (!homing.applied && homing.why === "window_off_desktop") {
    // Refused HERE, not left to the containment check below. Between the two sits the occlusion
    // rung, and `whoIsUnderPoint` filters minimised windows out of its own candidate list — so on
    // a real desktop something else is almost always over the remembered point, and the caller
    // would get `aim_occluded` ("bring the intended window forward") about a window that is
    // minimised, instead of the refusal that names the minimise and says to restore it (gate 2,
    // second pass). The unit cell for this passed only because its deps carried no `pointOwner`.
    throw new AimedPointOutsideWindowError(
      `Refusing to click (${x}, ${y}) for "${label}": ${theWindow} is ` +
      `parked off the desktop at (${rect.x}, ${rect.y}) — that is what Windows reports for a ` +
      `MINIMISED window, and no point on screen belongs to it. Nothing was clicked. Restore it ` +
      `(focus_window) and re-run desktop_discover.`,
      aimHwnd,
      because,
    );
  }
  if (!homing.applied && homing.why === "moved_during_read") {
    // The window would not hold still while it was being read, so the coordinates in this snapshot
    // were measured across more than one position: an early lane's candidate describes the window
    // where it was, a late one's where it went, and nothing here can say which is which. Pressing
    // the remembered point is the stale-coordinate press this rung exists to remove, and no
    // correction can repair it — there is no single delta (gate 1, third pass, 2026-09-09).
    throw new AimedPointOutsideWindowError(
      `Refusing to click (${x}, ${y}) for "${label}": these coordinates belong to ${theWindow}, and ` +
      `that window MOVED while it was being read, so the coordinates in that snapshot were measured ` +
      `against more than one position — no single correction describes them. Nothing was clicked. ` +
      `Re-run desktop_discover once the window has settled.`,
      aimHwnd,
      because,
    );
  }
  // ADR-036 item 5 — the coordinates say which window they came from, so the screen has to agree.
  //
  // `measured_in_another_window` is the one verdict that invalidates every comparison the ladder
  // makes: the origin, the current rectangle, the resize and the containment are all about the aim,
  // and these pixels are not. That leaves exactly one usable piece of evidence — who is under the
  // point NOW.
  //
  // **It had its own copy of that test until the review below.** The press is allowed where the
  // answer is the window the pixels came from and refused where it is a DIFFERENT one — and that
  // sentence is now written once, at the allowance a few lines down, which every road reaches.
  // Two copies had already drifted apart: this one refused on any answer, the other allowed any
  // owned window at all (PR 側 codex on #609 and on #612; Opus sandbox review, 2026-09-10). Both
  // halves of the rule are corrections of a round that got the other half wrong.
  //
  // **`aim` is NOT the third answer, and that is measured.** The version of this that shipped for a
  // few hours also refused when the enumeration said the aim itself was on top — reading that as
  // "the entity's window is not there". It does not mean that. `whoIsUnderPoint` cannot see an
  // untitled popup at all, so a dropdown or tooltip drawn over its owner makes it answer `aim`
  // while the popup really is on top, and the press that follows is correct (win2, 2026-09-10,
  // `dev/adr036-items56-popups/`). Refusing there would have been a false refusal for the commonest
  // popup on Windows, invented out of the enumeration's blind spot.
  //
  // `unknown` and a missing dep stay out of it for the same reason, and `other` falls through to
  // the occlusion refusal below, which names the covering window and says what to do about it.
  // Only now the popup allowance. The press is on a window this one owns: allowed, and allowed
  // even where the aim's own rectangle does not contain the point, because that is where dropdowns
  // live — and allowed before the verdicts BELOW, which are statements about the AIM's layout and
  // say nothing about a window that merely hangs off it.
  //
  // **`unknown` does NOT get this allowance, and that is a decision rather than an oversight**
  // (PR 側 codex, 2026-09-10). A `ComboLBox` dropdown answers `unattributable_window`, so an item
  // of it that hangs OUTSIDE the owner's rectangle still ends at the containment refusal below.
  // That is a residual and not a regression: before the hit test existed, an untitled popup was
  // invisible to the enumeration, so a point outside the aim's rectangle found either a stranger
  // (`other`, refused) or nothing (`unknown`, refused by containment). The press was refused then
  // and is refused now; what changed is only that we can see why.
  //
  // Widening the allowance to `unknown` would be a NEW press in a case that was refused, and the
  // measurement says what would come with it: the rung answers on "captionless, same thread", which
  // a splash screen and a custom-chrome frame satisfy too. Pressing outside the aim's rectangle
  // into one of those is exactly what item 6 exists to stop. What would close it honestly is
  // knowing the popup belongs to the aim — and no rule on ownership, thread or process establishes
  // that for a `ComboLBox`, which is the open question this ADR carries.
  //
  // Deliberately NOT before the two above. Those are statements about the whole SNAPSHOT: a
  // minimised aim and a smeared read make every coordinate in it unusable, the popup's included.
  // `owned` says which top-level window is under the point NOW — not that the leased entity came
  // from it — so letting it past those two reports success after pressing an unrelated dropdown
  // (PR 側 codex on #609). The previous round moved this line one rung too far up.
  //
  // **The allowance is not unconditional, and the narrowing has a condition of its own.** An owned
  // window that is NOT where the pixels came from is an occluder: the entity's own origin says the
  // control is in another window, so the press would land in a dialog while the caller is told
  // their control was clicked (PR 側 codex, 2026-09-10, P1).
  //
  // Refused only on the OS's answer. `whoIsUnderPoint` has two mechanisms and they do not deserve
  // the same trust: `WindowFromPoint` resolves real hit regions, while the ENUMERATION reads
  // rectangles and is measured blind to a click-through overlay's transparency — it names a window
  // presses fall straight through. Refusing on that would invent a refusal out of a known blind
  // spot, which is the same mistake as reading `aim` as evidence of absence, and it would break
  // presses that work today on every build without the native addon (Opus sandbox review,
  // 2026-09-10). On the enumeration's answer the allowance stands, exactly as before.
  //
  // Both earlier rungs consult the same verdict on their way past — `measured_in_another_window`
  // used to carry its own copy of this test, which is one rule in two places (and the two drifted:
  // one refused on any answer). It reads it here now, once.
  if (owner?.kind === "owned") {
    // Absence is not evidence: an entity that recorded no origin keeps the allowance it always had.
    if (capturedIn === undefined || owner.hwnd === capturedIn || owner.via !== "os_hit_test") {
      return { x, y };
    }
    throw new AimedPointOutsideWindowError(
      `Refusing to click (${x}, ${y}) for "${label}": these coordinates were measured in window ` +
      `${capturedIn}, and the window under that point now is ${owner.hwnd} ("${owner.title}") — ` +
      `a different window that ${aimHwnd} also owns. A menu, dialog or dropdown has an origin of ` +
      `its own and does not move with the window that owns it, so nothing here can follow these ` +
      `coordinates to where they went. Nothing was clicked. Re-run desktop_discover.`,
      aimHwnd,
      because,
    );
  }

  if (!homing.applied && homing.why === "window_resized" && origin?.kind === "measured") {
    // The point WAS inside this window, and the window has relaid out since. Nothing here can say
    // where the control went — that is what the correction declined to guess — and pressing the
    // remembered coordinate anyway is exactly the silent wrong press this ladder exists to remove
    // (gate 1, 2026-09-09). Containment cannot catch it: a resized window usually still contains
    // the point, which is why the press went through before.
    //
    // Same refusal as a point that left the window, deliberately: the recovery is identical
    // (re-discover and act on what comes back), and the published advice for that reason already
    // names the resize. A second reason with the same advice would be one more thing to keep in
    // step for no reader's benefit.
    throw new AimedPointOutsideWindowError(
      `Refusing to click (${x}, ${y}) for "${label}": these coordinates belong to ${theWindow}, which is ` +
      `still on screen but has been RESIZED since the lease was taken — it was ` +
      `${origin.rect.width}x${origin.rect.height} and is ${rect.width}x${rect.height} now. A ` +
      `window that moved without resizing would have been followed, had these coordinates been ` +
      `measured in the same read that measured it; a resize can lay the contents out differently, ` +
      `and nothing here can say what is under that point now. Re-run desktop_discover.`,
      aimHwnd,
      because,
    );
  }
  // Now the stranger on top — after this rung's verdicts, because "bring the intended window
  // forward" is not the recovery for a window that resized or is minimised.
  if (owner?.kind === "other") {
    throw new AimOccludedError(aimHwnd, owner.hwnd, owner.title, x, y, because, theWindow);
  }
  if (!inside) {
    // Typed, not a plain `Error`: the loop reports `executor_failed` for anything it cannot name,
    // and that reason's first suggestion is a coordinate click at the entity's rect — this point.
    throw new AimedPointOutsideWindowError(
      `Refusing to click (${x}, ${y}) for "${label}": these coordinates belong to ${theWindow}, and ` +
      `that window is now at (${rect.x}, ${rect.y}) ${rect.width}x${rect.height}. The point comes from a ` +
      `rectangle remembered at discover time, and it was not corrected: ${homing.applied ? "it was" : homing.why}. ` +
      `A window that moved WITHOUT resizing is followed when the coordinates were measured in the ` +
      `same read that measured the window. Whatever is under that point now would take the click. ` +
      `Re-run desktop_discover.`,
      aimHwnd,
      because,
    );
  }
  return { x, y };
}

/**
 * ADR-036 probe — a road that succeeded says so.
 *
 * The first version of this probe only wrote at the two mouse presses and the containment check,
 * so a run that went cleanly through UIA left no row at all and had to be inferred from the gap
 * between `act.aim` and the next seam. That is the probe breaking its own rule — absence is
 * recorded, not inferred — and it made the road that works the only one with no evidence (win2,
 * from the first real-machine sweep, 2026-09-09).
 */
function probeRoute(route: string, aimHwnd: bigint | undefined, entity: UiEntity, extra: Record<string, unknown> = {}): void {
  probeAim("act.route", {
    route,
    // `hasAim`, not `aimed`: this is a reading of the handle, and it was called `aimed` while the
    // comment beside it claimed it meant "the containment check ran". Those are different facts,
    // and on a build whose `aimRect` cannot answer they come apart (gate 2).
    hasAim: aimHwnd !== undefined,
    aimHwnd: aimHwnd !== undefined ? aimHwnd.toString() : null,
    entityId: entity.entityId,
    entityLabel: entity.label ?? null,
    ...extra,
  });
}

/**
 * One side of an `act.identity` row — every field {@link compareAimIdentity} looks at, and nothing
 * it does not. A row that omitted a field the decision used made a real refusal look like a bug.
 */
function identityRow(id: WindowIdentity): Record<string, unknown> {
  return {
    pid: id.pid,
    processName: id.processName,
    processStartTimeMs: id.processStartTimeMs,
    // Written as null rather than left out when absent: "could not read the class" and "this build
    // never read one" are different readings, and only one of them is about the window.
    className: id.className ?? null,
    titleFingerprint: id.titleFingerprint ?? null,
  };
}

function rectCenter(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}
// ── Executor factory ──────────────────────────────────────────────────────────

/**
 * Build an ExecutorFn that routes to the appropriate native backend.
 *
 * Called lazily so `target` reflects the current session.lastTarget at touch time.
 * Pass `deps` to inject mock backends in tests; omit for production native bindings.
 *
 * Routing priority: uia → cdp → terminal → mouse (visual fallback)
 * Routing uses the entity's source-specific `locator` fields.
 *
 * UIA click failure gracefully falls through to mouse when entity has a rect.
 */
export function createDesktopExecutor(
  target: Aim | TargetSpec | undefined,
  deps?: ExecutorDeps
): (entity: UiEntity, action: TouchAction, text?: string) => Promise<ExecutorKind | ExecutorOutcome> {
  const d = deps ?? getSharedRealDeps();
  // ADR-036 item 2 — the aim is a value now. A raw `TargetSpec` is still accepted, because most
  // callers (nearly all of them tests) hand one over, and `toAim` reads it as an aim with no
  // identity — which is the truth about it: the caller's words were never evidence about who owns
  // the window. Production passes a real `Aim`, and only that arm can carry identity.
  const aim = toAim(target);

  return async (entity, action, text) => {
    const winTitle = aim.title ?? "@active";
    // ADR-036 — read once per touch, next to the title it replaces, so a route added later has to
    // walk past it rather than reach for `winTitle` alone.
    const aimHwnd = aim.hwnd;

    // ADR-036 item 12 — which window this entity's COORDINATES were measured in.
    //
    // `aimHwnd` is what the call NAMED, and for the commonest way of naming a window it is nothing:
    // `desktop_discover({windowTitle: "…"})` against an ordinary top-level window goes through
    // `_resolve-window.ts` case 3, which finds the window and returns null ON PURPOSE so the
    // providers keep searching by title. The aim then carries no handle, and every rung of this
    // ADR — identity invalidation, occlusion, containment, the homing correction — is gated behind
    // one and silently does not run.
    //
    // **This buys TWO of those four, and the count was wrong twice before it was read carefully**
    // (gate 2, 2026-09-10; corrected again on re-derivation). Occlusion and containment ask the OS
    // where the window is NOW and can run on any handle that names one — those two are what a
    // title-only call gains here.
    //
    // The homing correction cannot: it subtracts the delta between the window's rectangle at
    // discover time and its rectangle now, and the first of those is `aim.origin` — measured around
    // the window `toAim` resolved. This road has no such window, so `origin` is `undefined` below
    // and the correction is declined with `no_origin_rect`. What the entity records is a HANDLE, not
    // the rectangle it was measured against, and the correction needs the rectangle.
    //
    // **Declined is not "the only verdict this road can produce"** — an earlier version of this
    // paragraph said the latter and it is false (Opus sandbox review, 2026-09-10).
    // `homingCorrectionForSources` asks `window_off_desktop` FIRST, before it looks at any origin,
    // so a MINIMISED window on this road answers that instead and the act refuses with the message
    // that names the minimise. The window-gone refusal is reached the same way. Only the verdicts
    // that need the origin RECTANGLE are out of reach here. (Do not "fix" that
    // by passing `aim.origin` anyway: it belongs to a different window, and the cell above this
    // one exists because doing so displaced a press by 100 px in each direction.)
    //
    // Identity invalidation cannot either: it compares the window against a BASELINE taken when the
    // lease was read, and `readIdentityForTarget` only takes one for a target that resolved to a
    // handle — so a title-only aim carries no `identity` to compare against. A recycled handle on
    // this road is still uncaught, and closing it means recording an identity per OBSERVATION,
    // which is the same lane work ADR-036 item 5 carries.
    //
    // The entity knows. ADR-029 already answered this for the viewport gate, and `origin.hwnd` is
    // its answer: the handle the CAPTURE resolved, not a re-derivation of the query. Re-resolving
    // the title here instead would be worse than doing nothing: three searches resolve a title in
    // this codebase and none of them agree by construction — the UIA bridge takes the first
    // UIA-tree child whose name matches, `runSomPipeline` the first Z-ORDER window, and
    // `findPlainTopLevelWindowsByTitle` walks Z-order while excluding dialogs and owned windows. A
    // fourth search would pin the act to a window the read may never have touched.
    //
    // Kept SEPARATE from `aimHwnd`: this one only decides where a coordinate press may land and is
    // never handed to a backend, so the read path's addressing is untouched and a wrong value costs
    // a refusal rather than a press into another window.
    //
    // **Which entities this actually reaches, stated narrowly.** Only lanes that RECORD a handle
    // put one here: `runSomPipeline` resolves one and the visual and OCR lanes carry it through as
    // `originHwnd`. **The UIA lane records one too, since item 15** — `getUiElements` reports the
    // handle it resolved, on both the Rust and the PowerShell road, and the provider stamps it. It
    // did not until 2026-09-10, and the cost was measured rather than argued: a UIA entity whose
    // window had been CLOSED was pressed blind at the remembered coordinates and the caller was
    // told `ok:true` (win2, `dev/item13-detail/RESULTS-round2.md`).
    //
    // A build whose read cannot report a handle is unchanged — no handle, no ladder, exactly as
    // before. A merged group is covered either way, since the handle is read from the group rather
    // than from whichever lane observed last.
    const coordHwnd = aimHwnd ?? observedHwndOfOrigin(entity.origin);

    // A round of item 12 also carried a `hwndConflict` refusal here, for an entity whose lanes had
    // named different windows. Deleted with the state that produced it — and **the derivation lives
    // in `world-graph/resolver.ts` alone.** This comment carried a second copy of it; the copy was
    // wrong about how many lanes write `originHwnd`, and it was still wrong after the other copy
    // had been corrected (Opus sandbox review, 2026-09-10). One rule, one place.
    //
    // What matters here is only the consequence: no entity reaches this line carrying "the lanes
    // disagreed". Only a hand-built entity could reach the refusal that used to be here, and
    // `guarded-touch` flattened its recovery advice to `aim_point_outside_window` on the way out,
    // so nothing it said reached a caller either.

    // ADR-036 item 2 — the specification's identity invalidation, at the only moment it can be
    // checked: after the lease was taken and before anything is done about it.
    //
    // > If the same `hwnd` appears with a different process identity, RPG treats it as identity
    // > invalidation, not an ordinary update.
    //
    // Windows recycles handles, so "the handle still names a window" is not "the handle still
    // names YOUR window" — and every check downstream, the containment one included, asks the OS
    // about whatever owns the number now. `"unknown"` is not `"changed"`: a build with no native
    // binding, or a process that has already gone, cannot answer, and refusing on an unanswered
    // question would take every action down on those builds.
    if (aim.hwnd !== undefined && aim.identity !== undefined) {
      const now = await d.aimIdentity?.(aim.hwnd);
      const verdict = compareAimIdentity(aim, now);
      // Every field the comparator reads, on both sides. The row used to carry pid, process name
      // and start time only, so a `changed` decided by the CLASS landed as a row whose two sides
      // were byte-identical — indistinguishable from a broken comparator, in the one instrument
      // that exists to explain this refusal (gate 2, 2026-09-09). `titleFingerprint` rides along
      // because it is recorded and never decisive, and a reader has to be able to see that.
      probeAim("act.identity", {
        aimHwnd: aim.hwnd.toString(),
        then: identityRow(aim.identity),
        now: now ? identityRow(now) : null,
        verdict,
        comparedByExecutor: true,
      });
      if (verdict === "changed") {
        throw new AimIdentityChangedError(aim.hwnd, aim.identity, now);
      }
    }

    // ADR-036 probe — the seam where the read path's work either arrives or does not.
    if (aimProbeEnabled()) {
      probeAim("act.aim", {
        // Spelled out rather than handing the whole value over. The replacer in `aim-probe.ts`
        // makes a raw `Aim` serialisable now, but a row is a statement about what the executor
        // read, and every field here is one this code actually uses — a value dumped whole says
        // "here is everything", which is how a reader ends up believing a field that was never
        // consulted (gate 2).
        aim: {
          title: aim.title ?? null,
          hwnd: aim.hwnd?.toString() ?? null,
          tabId: aim.tabId ?? null,
          identity: aim.identity
            ? { pid: aim.identity.pid, processName: aim.identity.processName, processStartTimeMs: aim.identity.processStartTimeMs }
            : null,
        },
        aimFrom: (target as Aim | undefined)?.kind === "aim" ? "aim" : "target_spec",
        aimHasIdentity: aim.identity !== undefined,
        winTitle,
        aimHwnd: aimHwnd !== undefined ? aimHwnd.toString() : null,
        entityId: entity.entityId,
        entityLabel: entity.label ?? null,
        action,
        sources: entity.sources,
        preferredExecutors: entity.preferredExecutors ?? null,
        rect: entity.rect ?? null,
      });
      if (aimHwnd !== undefined && aim.identity === undefined) {
        // No identity to compare against — the aim came in as a raw target, or the read could not
        // answer when it was taken. Recorded anyway: "nothing to compare" and "compared, same" are
        // different facts, and only one of them is evidence.
        probeAim("act.identity", {
          aimHwnd: aimHwnd.toString(),
          then: null,
          now: readWindowIdentity(aimHwnd),
          verdict: "unknown",
          comparedByExecutor: false,
        });
      }
    }

    // Issue #296 Phase 2 — `desktop_discover` derives `unsupportedExecutors`
    // from UIA `controlType` + `patterns` (e.g. `ListItem`/`TabItem` without
    // `InvokePattern`, `TogglePattern`-only checkboxes, visual-only entities)
    // and stashes the array on `UiEntity` so we can skip a route that the
    // capability derivation already predicted would fail.
    //
    // `mouse` is honoured here too (Opus PR #302 P2 #1) — the type union allows
    // it, so the executor must respect it rather than silently routing through
    // the unconditional mouse fallback. In practice today nothing emits
    // `'mouse'` in `unsupportedExecutors`, but treating the field as authoritative
    // future-proofs against capability rules that flag e.g. unreliable rects.
    const blocked = entity.unsupportedExecutors ?? [];
    const uiaBlocked      = blocked.includes("uia");
    const cdpBlocked      = blocked.includes("cdp");
    const terminalBlocked = blocked.includes("terminal");
    const mouseBlocked    = blocked.includes("mouse");

    // ADR-020 SR-1 PR-SR1-2 (北極星 9, Round 7 confirmed): preferredExecutors の
    // 責務は **各 executor block の entry eligibility** に限定する。registry が
    // bake した `entity.preferredExecutors` に含まれない executor の block は
    // skip し、block 内部の fallback / error message / return shape は baseline
    // と bit-equal 維持 (北極星 9 (2)/(4)/(5))。
    //
    // 設計境界 (sub-plan §5.2 + §5.5):
    //   - `entity.preferredExecutors === undefined` → 全 executor で true を返す
    //     (baseline と完全同一動作、北極星 9 (1))。
    //   - generic outer loop / 失敗集約 / 任意 [from → to] downgrade marker は
    //     導入しない (現 executor の fallback は単純 routing ladder ではなく
    //     recovery fallback + 公開 contract を含むため; sub-plan §5.2 末尾参照)。
    //   - 内部 keyboard fallback (UIA setValue → keyboardTypeBg) は引き続き
    //     bare `"keyboard"` return (PR #330 contract、OQ-SR5-1 で SR-5 再判断)。
    const preferredAllows = (executor: AdvertisedExecutorKind): boolean =>
      entity.preferredExecutors === undefined || entity.preferredExecutors.includes(executor);

    // ── UIA route ────────────────────────────────────────────────────────────
    if (entity.sources.includes("uia") && !uiaBlocked && preferredAllows("uia")) {
      const automationId = entity.locator?.uia?.automationId;
      const name         = entity.locator?.uia?.name ?? entity.label;
      // Phase 4: 'setValue' absorbs former set_element_value tool — same UIA
      // ValuePattern path as 'type'. Both actions land here for any UIA entity.
      //
      // Issue #327 item E: when `uiaSetValue` throws (most commonly because the
      // PowerShell `name -like '*…*'` locator filter in `makeSetElementValueScript`
      // cannot re-find the entity — Notepad's RichEditD2DPT with empty/unstable name
      // is the canonical dogfood case), fall back to background WM_CHAR injection
      // via `keyboardTypeBg`. The fallback uses the same primitive as `terminalSend`
      // and respects `canInjectAtTarget` so Chromium / UWP / WT-XAML hosts still
      // surface executor_failed cleanly. On combined failure we surface a joint
      // error message so the LLM sees both rungs' diagnostics in one envelope.
      if ((action === "type" || action === "setValue") && text !== undefined) {
        try {
          await d.uiaSetValue(winTitle, text, name, automationId, aimHwnd);
          probeRoute("uia", aimHwnd, entity, { why: "uia_set_value" });
          return "uia";
        } catch (uiaErr) {
          // R3 tool-exclusion — as in the click path below: refusals are not rungs.
          if (uiaErr instanceof WindowExcludedError) throw uiaErr;
          // A dead aim is NOT short-circuited here, unlike in the click path. That rung addresses
          // the same handle (`keyboardTypeBg` looks the window up by hwnd and throws when the
          // enumeration does not hold it), so it cannot write into a different window — and a
          // window whose UIA provider has gone while the HWND lives is exactly the case WM_CHAR
          // injection was added for. The click path's downgrade is blind by coordinate; this one
          // is not.
          try {
            await d.keyboardTypeBg(winTitle, text, aimHwnd);
            probeRoute("keyboard", aimHwnd, entity, { why: "uia_set_value_failed" });
            return "keyboard";
          } catch (kbErr) {
            // Both rungs are spent, so the refusal that was let through above is now the whole
            // answer: a window that has gone gets the same typed refusal here as it does on the
            // click path, instead of an `executor_failed` that reads like a UIA hiccup
            // (2ゲート目の指摘). One condition, one answer, whichever action asked.
            if (uiaErr instanceof AimedWindowGoneError) throw uiaErr;
            // ADR-036 — and an aimed WRITE ends the same way an aimed click does. Both rungs
            // addressed the handle and both are spent; reported as `executor_failed` the caller is
            // told to fall back to `click_element` / `mouse_click` at the entity's rect, which is
            // the blind press the click path refuses two branches down. One aim, two actions,
            // opposite advice (2ゲート目の指摘). Unpinned calls keep the generic reason: they never
            // promised which window, so the coordinate road is theirs to take — and since item 12
            // that road is CHECKED when it is taken through `desktop_act`, against the window the
            // entity was captured in. Deliberately left as `executor_failed` rather than made a
            // typed refusal here: nothing is pressed on this branch either way, so the only thing
            // at stake is the reason, and `AimedRouteFailedError` says "this call named its
            // window" about a call that named a title (gate 2, 2026-09-10).
            // Wording kept from PR #330 — two suites pin it, and the fact they pin is that the
            // joint diagnostic survives; renaming it would have been churn wearing a fix's clothes.
            const ladder =
              `Type fallback ladder exhausted for "${entity.label ?? entity.entityId}"` +
              `${aimHwnd !== undefined ? ` on window ${aimHwnd}` : ""}: ` +
              `uia=${uiaErr instanceof Error ? uiaErr.message : String(uiaErr)} / ` +
              `keyboard=${kbErr instanceof Error ? kbErr.message : String(kbErr)}`;
            if (aimHwnd !== undefined) {
              throw new AimedRouteFailedError(
                `${ladder}. Not falling back to a coordinate press — this call named its window, ` +
                `and the entity's rect is a screen point that any window can be under. ` +
                `Re-run desktop_discover.`,
                aimHwnd,
                { cause: kbErr },
                // What the caller is shown: the ladder that was spent, without the backend's own
                // text. `ladder` is written here for a reader; `kbErr.message` is not (item 13).
                `Every write route to window ${aimHwnd} was spent for "${entity.label ?? entity.entityId}" — ` +
                `the UIA value route and the background write both failed — and the act was not ` +
                `finished as a coordinate press.`,
              );
            }
            throw new Error(ladder, { cause: kbErr });
          }
        }
      }
      try {
        await d.uiaClick(winTitle, name, automationId, aimHwnd);
        probeRoute("uia", aimHwnd, entity, { why: "uia_invoke" });
        return "uia";
      } catch (uiaErr) {
        // R3 tool-exclusion — a refusal is not a failure to route around. Every other throw
        // here means "UIA could not do it, try the mouse"; this one means "you may not touch
        // that window", and the mouse fallback would touch it anyway, by coordinate, at the
        // rect the secure dialog now occupies (2ゲート目の指摘).
        if (uiaErr instanceof WindowExcludedError) throw uiaErr;
        // ADR-036 — nor is a dead aim a rung. The rect below is where the window WAS; a window
        // that has closed since the lease was taken has usually been replaced on screen by
        // whatever was behind it, and the downgrade would click that instead. "Window drift" is
        // one of the five failures the perception graph is built to stop, so this ends the
        // ladder and says so (2ゲート目の指摘).
        if (uiaErr instanceof AimedWindowGoneError) throw uiaErr;
        // ADR-036 — and an aimed click does not finish as a blind one.
        //
        // The downgrade below clicks `entity.rect`'s centre. That is a screen coordinate, and a
        // coordinate is not aimed at anything: whatever occupies the point takes the press. For a
        // call that named its window by handle — the whole subject of this ADR — that is the
        // failure it exists to remove, arriving as the recovery path.
        //
        // Measured on Windows 2026-09-09, and worse than the argument: with the window frame
        // synthesised into the read but not the write, EVERY press of `Close` and `Minimize` on a
        // pinned session came back `ok:true` while `executor` said `mouse` and `downgrade` said
        // `Element not found` — the mouse landed on the rect, one of them at `-32000,-32000`, and
        // only a caller reading `downgrade` could have known. Success was being reported for a
        // press that UIA never made.
        //
        // So the ladder ends here when the aim was a handle. An honest failure lets the caller
        // re-discover; a blind press lets it believe. Unpinned calls keep the downgrade — a title
        // was never a promise about which window — but it is no longer BLIND: see below.
        if (aimHwnd !== undefined) {
          // Typed for the same reason the two refusals above are: an untyped throw arrives as
          // `executor_failed`, and that reason's published first suggestion is "fall back to
          // mouse_click using the entity rect center" — the blind press this branch exists to
          // refuse, handed back as the recovery (PR 側 codex, 2026-09-09).
          throw new AimedRouteFailedError(
            `UIA click failed for "${entity.label ?? entity.entityId}" on window ${aimHwnd}: ` +
            `${uiaErr instanceof Error ? uiaErr.message : String(uiaErr)}. ` +
            `Not falling back to a coordinate click — this call named its window, and the ` +
            `entity's rect is a screen point that any window can be under. Re-run desktop_discover.`,
            aimHwnd,
            { cause: uiaErr },
            // The message above quotes the UIA failure, which on this road is a PowerShell rejection
            // carrying the whole script; the caller-facing sentence says the same thing without it.
            `The UIA route to window ${aimHwnd} failed for "${entity.label ?? entity.entityId}", and ` +
            `the act was not finished as a coordinate click.`,
          );
        }
        // UIA click failed (element not found, stale tree, etc.).
        // Prefer entity.rect (freshest, from most-recent candidate) over locator.visual.rect
        // which may be stale (captured at recognition time, before the element moved).
        const rect = entity.rect ?? entity.locator?.visual?.rect;
        if (!rect) throw new Error(
          `UIA click failed for "${entity.label ?? entity.entityId}" and no rect for mouse fallback`,
          { cause: uiaErr },
        );
        const remembered = rectCenter(rect);
        // ADR-036 item 12 — and this downgrade is a coordinate press like the one 140 lines below.
        //
        // The comment above used to end "the rect is all they ever had", and this commit is what
        // makes that false: the entity records the window its pixels were captured in, so an
        // unpinned call has a window to check the point against after all. Without this the same
        // entity was refused on one road and pressed unchecked on the other — reproduced by gate 2
        // (2026-09-10) with a `設定` window over the point: `mouseClick` went out and `pointOwner`
        // was never asked. That is the 2026-09-09 measurement recorded above, surviving in the case
        // this commit has just shown is not really unpinned.
        //
        // **How often this road is taken was a guess, and the machine answered differently.**
        // The sentence here used to say merged UIA entities were "the ladder's real traffic". On a
        // desktop with no vision backend there ARE no merged entities: a title-only discover
        // returned `["uia"]` for every entity on two fixtures (13 of them), the visual lanes are
        // called and produce nothing, and `act.route` shows one row per act — `route:"uia"`,
        // `hasAim:false`. UIA invoke does not use coordinates, so the ladder is never reached at
        // all (win2, 2026-09-10, `dev/pr612-entity-origin/`).
        //
        // That is scope, not a defect: this branch fixes the road for the entities that take it —
        // ones a visual or OCR lane produced, which is where `origin.hwnd` comes from in the first
        // place. Where UIA can serve the window by title, the coordinate road is not taken and none
        // of this runs. Written here because the next reader will otherwise measure the same thing
        // again to find out whether their change matters.
        const { x, y } = coordHwnd !== undefined
          ? await resolvePressPoint(d, aim, coordHwnd, entity, remembered.x, remembered.y, entity.label ?? entity.entityId, uiaErr)
          : remembered;
        // ADR-029: the UIA route works on any monitor. The mouse downgrade
        // reaches every monitor too since Phase 2a, but the point still has to
        // BE on one — a stale rect that now sits off-screen is refused here
        // rather than clicked somewhere else.
        assertCoordinateReachable(x, y);
        // ADR-036 probe — the downgrade press. Recorded so the two mouse roads can be told apart in
        // the log. `aimHwnd` is always null here: the pinned case threw four branches up, so this
        // road is unreachable with an aim — but `coordHwnd` is not, and a row where it is set is
        // the ladder having run on the window the entity came from.
        probeRoute("mouse", undefined, entity, {
          why: "uia_downgrade",
          point: { x, y },
          remembered,
          coordHwnd: coordHwnd !== undefined ? coordHwnd.toString() : null,
          coordHwndFrom: coordHwnd !== undefined ? "entity_origin" : null,
        });
        await d.mouseClick(x, y);
        // Issue #327 item C: signal the silent downgrade so the LLM sees
        // `executor: "mouse"` AND `downgrade: { from: "uia", reason: ... }`
        // — without the marker the dogfood envelope cannot distinguish
        // "UIA was tried and failed" from "UIA was not the chosen route".
        const reason = uiaErr instanceof Error ? uiaErr.message : String(uiaErr);
        return { kind: "mouse", downgrade: { from: "uia", reason } };
      }
    }

    // ── CDP route ────────────────────────────────────────────────────────────
    const cdpSelector = entity.locator?.cdp?.selector;
    if (cdpSelector && !cdpBlocked && preferredAllows("cdp")) {
      const cdpTabId = entity.locator?.cdp?.tabId ?? aim.tabId;
      // Phase 4: 'setValue' on a CDP entity uses cdpFill — equivalent to
      // browser_fill for controlled inputs (React/Vue/Svelte).
      if ((action === "type" || action === "setValue") && text !== undefined) {
        await d.cdpFill(cdpSelector, text, cdpTabId);
        probeRoute("cdp", aimHwnd, entity, { why: "cdp_fill", tabId: cdpTabId ?? null });
        return "cdp";
      }
      await d.cdpClick(cdpSelector, cdpTabId);
      probeRoute("cdp", aimHwnd, entity, { why: "cdp_click", tabId: cdpTabId ?? null });
      return "cdp";
    }

    // ── Terminal route ───────────────────────────────────────────────────────
    // Terminals have no click affordance — terminalSend requires a string.
    // Mirror the UIA/CDP gates: only invoke when the caller actually supplied
    // text (action='type'/'setValue', or action='auto' with text). Otherwise
    // fall through to the mouse fallback so click/invoke on a terminal entity
    // doesn't silently send an empty string.
    if (entity.sources.includes("terminal") && !terminalBlocked && text !== undefined && preferredAllows("terminal")) {
      // The handle goes with it. This executor is built for one session — `target` is that
      // session's `lastTarget`, and the entities reaching it were read from that session's own
      // discover — so there is no entity here belonging to another window to protect.
      //
      // Two narrower shapes were tried and both were wrong. Comparing the two title strings
      // passes whenever they happen to match, and equal titles do not make one window, which is
      // the premise of this ADR. Asking "did the entity name a terminal window?" fails the
      // other way: the terminal provider always fills that field, so the handle was dropped for
      // every ordinary terminal entity and `terminalSend` went back to the first z-order match
      // (gate 1). The title is still passed for the backend that has no handle to use.
      const termWin = entity.locator?.terminal?.windowTitle ?? winTitle;
      await d.terminalSend(termWin, text, aimHwnd);
      probeRoute("terminal", aimHwnd, entity, { why: "terminal_send", termWin });
      return "terminal";
    }

    // ── Keyboard route (ADR-020 SR-5 PR-SR5-2、北極星 9 (4) + 5 block sequential) ──
    // `preferredExecutors` に `"keyboard"` が含まれ、UIA / CDP / terminal の
    // どれも entry しなかった場合に到達する direct keyboard 経路。`keyboardTypeBg`
    // (UIA route 内 recovery と同 primitive、`bg-input.ts::postCharsToHwnd` 経由
    // WM_CHAR injection) を呼び出し、bare `"keyboard"` return (PR #330 contract 維持、
    // OQ-SR5-1 exit condition (1))。失敗時は throw 直伝播 (CDP/terminal と同 pattern、
    // mouse rescue しない、北極星 9 (3) 整合)。
    //
    // 到達条件 (sub-plan §5.2 末尾):
    //   - `preferredExecutors=["keyboard"]` 単独 set で UIA-排除 + (a) `sources` に
    //     "uia" 含まない or (b) `unsupportedExecutors.includes("uia")` で uiaBlocked、
    //     かつ CDP / terminal eligibility なし
    //   - text 必須 + (action === "type" | "setValue") のみ entry (click は keyboard で意味なし)
    // 典型 ValuePattern entity (`preferredExecutors=["uia","keyboard"]`) は UIA block
    // で entry → UIA setValue → keyboardTypeBg 内部 ladder で bare "keyboard" return
    // (新 block は到達せず、北極星 2 = PR #330 contract bit-equal 維持)。
    // 北極星 9 (1) baseline 完全同一動作維持: entity.preferredExecutors が undefined
    // (registry lookup 不在 = test 直 invoke / legacy path) の case で新 keyboard block
    // を entry させないため、`preferredAllows("keyboard")` (undefined 時 true 返却) では
    // なく、explicit な `entity.preferredExecutors !== undefined && includes("keyboard")`
    // で gate する。これで preferredExecutors を明示 advertise していない baseline 経路
    // (e.g. unsupportedExecutors:["uia"] 単独 + text な test case) で text drop 防止 throw
    // への到達経路が baseline と bit-equal 維持される。
    if (
      entity.preferredExecutors !== undefined &&
      entity.preferredExecutors.includes("keyboard") &&
      !blocked.includes("keyboard") &&
      text !== undefined &&
      (action === "type" || action === "setValue")
    ) {
      await d.keyboardTypeBg(winTitle, text, aimHwnd);
      probeRoute("keyboard", aimHwnd, entity, { why: "keyboard_only_entity" });
      return "keyboard";
    }

    // ── Mouse fallback ───────────────────────────────────────────────────────
    // Opus PR #302 P2 #2 — when the caller supplied `text` (action='type'/
    // 'setValue', or action='auto' with text) and every text-capable executor
    // (UIA / CDP / terminal) was skipped or blocked, the previous fall-through
    // to a bare `mouseClick(rectCenter)` silently dropped the text payload —
    // the LLM thinks it typed something, but only a focus click was issued.
    // Throw a typed `executor_failed`-shaped error instead so the guarded-touch
    // wrapper surfaces `ok:false reason:'executor_failed'` and the caller can
    // diagnose the dropped payload rather than chasing a phantom-typed bug.
    if (text !== undefined && (action === "type" || action === "setValue")) {
      // ADR-020 SR-5 PR-SR5-2: keyboard executor が advertised に昇格したので
      // diagnostic string にも keyboard 経路の skip 理由を含める。
      const keyboardBlocked = blocked.includes("keyboard");
      throw new Error(
        `setValue/type requested for "${entity.label ?? entity.entityId}" but no text-capable executor available ` +
        `(uia${uiaBlocked ? "=blocked" : "=no-source"}, cdp${cdpBlocked ? "=blocked" : "=no-selector"}, terminal${terminalBlocked ? "=blocked" : "=no-source-or-text"}, keyboard${keyboardBlocked ? "=blocked" : "=not-in-preferred"}) — mouse fallback would drop the text payload`
      );
    }
    if (mouseBlocked) {
      throw new Error(
        `No executor available for entity "${entity.label ?? entity.entityId}": mouse fallback also blocked by unsupportedExecutors`
      );
    }
    // ADR-020 SR-1 PR-SR1-2 (北極星 9 + R-SR1-2-e): preferredExecutors が
    // mouse を含まない場合の throw を mouseBlocked と同経路で扱う。text drop
    // 防止 throw を先に評価する順序は維持しているため、text 付き action は
    // mouseBlocked と同等に上の text-drop branch で扱われる。
    if (!preferredAllows("mouse")) {
      // Round 8 P3-2 反映: mouseBlocked 経路の error message と統一して LLM 観測時の
      // log 差分を減らす。R-SR1-2-e (sub-plan §5.5) で「mouseBlocked と同経路で扱う」
      // と明記済の throw、文言も bit-equal にする。
      throw new Error(
        `No executor available for entity "${entity.label ?? entity.entityId}": mouse fallback also blocked by unsupportedExecutors`
      );
    }
    if (!entity.rect) {
      throw new Error(
        `No executor available for entity "${entity.label ?? entity.entityId}": no rect for mouse fallback`
      );
    }
    const remembered = rectCenter(entity.rect);
    // ADR-036 — if this call named a window, the specification's ladder runs here and decides
    // where the press actually goes: homing correction, then who is under the point, then whether
    // the point is in the window at all. Identity invalidation ran at the top of this closure,
    // before any route was chosen, because a changed identity makes every rectangle meaningless.
    const { x, y } = coordHwnd !== undefined
      ? await resolvePressPoint(d, aim, coordHwnd, entity, remembered.x, remembered.y, entity.label ?? entity.entityId)
      : remembered;
    // ADR-029 Phase 1 — and the point that gets PRESSED is the one that has to be on a monitor.
    // Checked here rather than on the remembered point, because those stopped being the same
    // question: a window discovered on a second monitor that Windows relocated when the monitor was
    // unplugged leaves the REMEMBERED point on no screen at all, and refusing there would report an
    // unreachable coordinate about a window the correction had just followed to a perfectly
    // reachable one (gate 2, 2026-09-09).
    assertCoordinateReachable(x, y);
    // ADR-036 probe — the press this ADR is about: a coordinate taken from a rect remembered at
    // discover time. Both points are written: `point` is where it went, `remembered` is where the
    // snapshot said it was, and a row where they differ is the homing correction doing its work.
    probeRoute("mouse", aimHwnd, entity, {
      why: "visual_or_read_entity",
      point: { x, y },
      remembered,
      rect: entity.rect,
      // Both, because they are different facts: what the call named, and what the ladder ran
      // against. A row where `aimHwnd` is null and `coordHwnd` is not is item 12 doing its work.
      coordHwnd: coordHwnd !== undefined ? coordHwnd.toString() : null,
      coordHwndFrom: aimHwnd !== undefined ? "aim" : coordHwnd !== undefined ? "entity_origin" : null,
    });
    await d.mouseClick(x, y);
    return "mouse";
  };
}

// ── Real deps (Windows native) ────────────────────────────────────────────────

/**
 * Module-level cache so all sessions share one set of native handles
 * (keyboard/mouse singletons, dynamic-imported modules).
 */
let _realDepsCache: ExecutorDeps | undefined;

function getSharedRealDeps(): ExecutorDeps {
  if (_realDepsCache) return _realDepsCache;
  _realDepsCache = {
    async uiaClick(windowTitle, name, automationId, hwnd) {
      const { clickElement } = await import("../engine/uia-bridge.js");
      // ADR-036 — the bridge has taken a handle since H3 ("bypass title-based root search",
      // added for Save As and the other common dialogs), and `ui-elements.ts` has passed one
      // for every resolved window since then. What could not reach it was THIS path: the
      // interface above had nowhere to put a handle, so `desktop_act` always asked by title.
      const r = await clickElement(windowTitle, name, automationId, undefined, hwnd !== undefined ? { hwnd } : undefined);
      // ADR-036 — "the window is gone" is not "UIA could not do it": see `aim.ts`.
      if (!r.ok && r.code === AIM_WINDOW_GONE) throw new AimedWindowGoneError(hwnd, r.error);
      if (!r.ok) throw new Error(r.error ?? "UIA click failed");
    },

    async uiaSetValue(windowTitle, value, name, automationId, hwnd) {
      const { setElementValue } = await import("../engine/uia-bridge.js");
      const r = await setElementValue(windowTitle, value, name, automationId, hwnd !== undefined ? { hwnd } : undefined);
      if (!r.ok && r.code === AIM_WINDOW_GONE) throw new AimedWindowGoneError(hwnd, r.error);
      if (!r.ok) throw new Error(r.error ?? "UIA setElementValue failed");
    },

    async cdpClick(selector, tabId) {
      // TODO: support non-default CDP port via TargetSpec.cdpPort (Phase 2)
      const { getElementScreenCoords, DEFAULT_CDP_PORT } = await import("../engine/cdp-bridge.js");
      const coords = await getElementScreenCoords(selector, tabId ?? null, DEFAULT_CDP_PORT);
      if ((coords as { error?: string }).error) {
        throw new Error((coords as { error?: string }).error ?? "CDP getElementScreenCoords failed");
      }
      // ADR-029: coordinates only become known inside this dep, so the
      // reachability check lives here rather than in the executor core.
      assertCoordinateReachable(coords.x, coords.y);
      const { mouse, Button } = await import("../engine/nutjs.js");
      const { moveCursorTo } = await import("../engine/cursor.js");
      await moveCursorTo(coords.x, coords.y);
      await mouse.click(Button.LEFT);
    },

    async cdpFill(selector, value, tabId) {
      const { evaluateInTab, DEFAULT_CDP_PORT } = await import("../engine/cdp-bridge.js");
      const expr = `(function(){
  const el = document.querySelector(${JSON.stringify(selector)});
  if(!el) return { ok:false, error:"Element not found: " + ${JSON.stringify(selector)} };
  el.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value")?.set
    ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value")?.set;
  if(nativeSetter) nativeSetter.call(el, ${JSON.stringify(value)});
  else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event("input",{bubbles:true}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
  return { ok:true };
})()`;
      const r = await evaluateInTab(expr, tabId ?? null, DEFAULT_CDP_PORT) as { ok: boolean; error?: string };
      if (!r.ok) throw new Error(r.error ?? "CDP fill failed");
    },

    async terminalSend(windowTitle, text, hwnd) {
      // G2: Background WM_CHAR path — no focus steal.
      // canInjectViaPostMessage() gates supported terminals (Windows Terminal, conhost).
      // Unsupported windows (Chromium, UWP) throw explicitly — caller gets executor_failed
      // and the LLM description directs them to V1 terminal({action:'send'}) as fallback.
      const { enumWindowsInZOrder, isWindowGone: isWindowGoneSync } = await import("../engine/win32.js");
      const { canInjectViaPostMessage, postCharsToHwnd } = await import("../engine/bg-input.js");
      const wins = enumWindowsInZOrder();
      terminalBgExecute(windowTitle, text, {
        // ADR-035 Phase 1 — the same unfiltered, silently-first-match shape the
        // v1 resolvers have, reached through `desktop_act` instead. Instrumented
        // so the observation window covers BOTH public dispatchers; leaving it
        // out would put a hole in the H2 evidence exactly where a v2 caller
        // writes (Opus Round 2 P2).
        findWindow: (title) => {
          // ADR-036 — when the caller resolved a handle, this is no longer a lookup: the
          // enumeration is consulted only to fetch that window's record, and a same-titled
          // sibling cannot be returned instead. `pinnedByHwnd` keeps the ADR-035 evidence
          // able to count the two shapes apart.
          if (hwnd !== undefined) {
            const named = wins.filter((w) => w.hwnd === hwnd);
            logResolve({
              resolver: "desktopActTerminalSend",
              query: title,
              matches: named,
              pinnedByHwnd: true,
              identity: "lookup",
              intent: "write",
            });
            // ADR-036 — a by-handle miss is ordinary (`enumWindowsInZOrder` drops untitled,
            // sub-50 px and excluded windows), and the throw downstream only knows the title,
            // so it named a window that is plainly on screen. Thrown here, AFTER the resolve
            // is logged: an earlier pre-check said the same sentence but left the miss out of
            // the H2 evidence, counting handle successes and not handle failures (2ゲート目).
            if (!named[0]) {
              // ADR-036 — and say WHICH kind of miss it is. A generic Error becomes
              // `executor_failed`, whose published terminal recovery is "use V1
              // terminal(action='send')" — a title-based road that can type into a same-titled
              // sibling or into the replacement window. That advice is right for a window that
              // is merely filtered out of the enumeration (untitled, sub-50 px, excluded) and
              // wrong for one that has been destroyed, so the two stop sharing an answer
              // (PR 側 codex の P1).
              if (isWindowGoneSync(hwnd)) throw new AimedWindowGoneError(hwnd);
              throw new Error(
                `Terminal window not found: hwnd ${hwnd} is not in the enumeration (title was "${title}")`,
              );
            }
            return named[0];
          }
          const matches = wins.filter((w) => w.title.toLowerCase().includes(title.toLowerCase()));
          logResolve({
            resolver: "desktopActTerminalSend",
            query: title,
            matches,
            identity: "lookup",
            intent: "write",
          });
          return matches[0];
        },
        canBgSend:  (hwnd) => canInjectViaPostMessage(hwnd),
        bgSend:     (hwnd, t) => {
          // `TerminalBgDeps` types the handle as `unknown` (it is a test seam);
          // the concrete value here is the `bigint` from the enumeration above.
          logDispatchSink({
            sink: "wm_char",
            tool: "desktop_act:terminal_send",
            targetHwnd: typeof hwnd === "bigint" ? hwnd : null,
            payloadChars: t.length,
          });
          return postCharsToHwnd(hwnd, t);
        },
      });
    },

    async keyboardTypeBg(windowTitle, text, hwnd) {
      // Issue #327 item E: UIA setValue fallback. Uses the same WM_CHAR primitive
      // as terminalSend but resolves to the focused child via `canInjectAtTarget`
      // so the BG class check classifies the actual key-receiving HWND (Notepad's
      // RichEditD2DPT child rather than the "Notepad" top-level). Chromium / WT-XAML
      // hosts surface "Background keyboard type not supported" so the joint error
      // message above (`Type fallback ladder exhausted: ...`) carries the diagnostic.
      //
      // Opus Round 1 P2-2 note (PR #330): the LLM-visible BG path at
      // `keyboard.ts:973` gates on `canInjectViaPostMessage(top-level hwnd)` and
      // delegates to `postCharsToHwnd` which internally resolves the child via
      // `resolveTarget`. The asymmetry is deliberate here — the child-class check
      // is the right semantic for "send keys to the active edit control" and the
      // Notepad RichEditD2DPT case is exactly where the parent-class check is too
      // coarse. The path-class refactor epic should reconcile both BG paths under
      // a single semantic (tracked in memory `project_path_class_refactor_pending`).
      const { enumWindowsInZOrder } = await import("../engine/win32.js");
      const { canInjectAtTarget, postCharsToHwnd } = await import("../engine/bg-input.js");
      const wins = enumWindowsInZOrder();
      // ADR-035 Phase 1 — the `terminalSend` twin above; see its comment.
      // ADR-036 — and its handle branch: a resolved handle names the window outright, so the
      // enumeration is only asked for that window's record.
      const byHandle = hwnd !== undefined;
      const matches = byHandle
        ? wins.filter((w) => w.hwnd === hwnd)
        : wins.filter((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
      const win = matches[0];
      logResolve({
        resolver: "desktopActKeyboardType",
        query: windowTitle,
        matches,
        ...(byHandle && { pinnedByHwnd: true }),
        identity: "lookup",
        intent: "write",
      });
      if (!win) {
        // ADR-036 — say which question was asked. `enumWindowsInZOrder` drops untitled,
        // sub-50 px and excluded windows, so a by-handle miss is ordinary, and reporting the
        // title alone told an operator that a window plainly on screen was "not found".
        throw new Error(
          byHandle
            ? `Window not found for keyboardTypeBg: hwnd ${hwnd} is not in the enumeration (title was "${windowTitle}")`
            : `Window not found for keyboardTypeBg: "${windowTitle}"`,
        );
      }
      const check = canInjectAtTarget(win.hwnd);
      if (!check.supported) {
        throw new Error(
          `Background keyboard type not supported for "${windowTitle}" ` +
          `(${check.reason ?? "unknown"}, class: ${check.className ?? "?"}).`,
        );
      }
      logDispatchSink({ sink: "wm_char", tool: "desktop_act:keyboard_type", targetHwnd: win.hwnd, payloadChars: text.length });
      const r = postCharsToHwnd(win.hwnd, text);
      if (!r.full) {
        throw new Error(
          `Background keyboard type incomplete: sent ${r.sent}/${text.length} chars to "${windowTitle}"`,
        );
      }
    },

    async aimRect(hwnd) {
      const { getWindowRectByHwnd } = await import("../engine/win32.js");
      return getWindowRectByHwnd(hwnd);
    },

    pointOwner(aimHwnd, x, y) {
      // Synchronous on purpose: it reads one enumeration snapshot, and an await here would let the
      // screen change between the question and the press it is protecting.
      return whoIsUnderPoint(aimHwnd, x, y);
    },

    async aimIdentity(hwnd) {
      // `getWindowIdentity` answers a zeroed identity for both "no such window" and "this build
      // cannot ask", and the two have to arrive as one thing the caller can recognise: nothing.
      const { getWindowIdentity, getWindowClassName, getWindowTitleW } = await import("../engine/win32.js");
      return readWindowIdentityFields(hwnd, {
        identity: getWindowIdentity,
        className: getWindowClassName,
        title: getWindowTitleW,
      });
    },

    async aimIsGone(hwnd) {
      // `isWindowGone` says false whenever it could not ask, which is the whole point of pairing
      // it with `aimRect`: a null rectangle plus "cannot tell" must not become "the window you
      // aimed at is gone".
      const { isWindowGone } = await import("../engine/win32.js");
      return isWindowGone(hwnd);
    },

    async mouseClick(x, y) {
      // ADR-029 Phase 2a: the shared cursor choke point places the pointer on
      // any monitor (and refuses rather than clamping when it cannot); the
      // click itself needs no coordinates — it hits whatever is under the
      // cursor.
      const { mouse, Button } = await import("../engine/nutjs.js");
      const { moveCursorTo } = await import("../engine/cursor.js");
      await moveCursorTo(x, y);
      await mouse.click(Button.LEFT);
    },
  };
  return _realDepsCache;
}
