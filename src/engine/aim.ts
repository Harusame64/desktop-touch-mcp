/**
 * aim.ts — what `desktop_act` is aimed at, and the refusals that say the aim cannot be honoured.
 *
 * ADR-036. A session knows which window it was opened on (`hwnd > tabId > windowTitle`, see
 * `session-registry.ts`), and every backend now takes that handle so a same-titled sibling
 * cannot answer instead. This file holds the piece of that contract both halves need to agree
 * on — the read half emits the code, the executor decides what it means — without either of
 * them importing the other's module graph.
 *
 * Phase 3 of the dig ("make the aim a value rather than a parameter") lands here: today the
 * handle rides as a trailing optional argument, and this is the file that grows a `{ title,
 * hwnd }` when it stops doing that.
 */

/**
 * Backend code for "the handle names a window that is no longer there".
 *
 * `AutomationElement.FromHandle` THROWS for a dead handle rather than returning null, so both
 * hwnd-addressed scripts catch it and print this instead of dying with empty stdout.
 */
export const AIM_WINDOW_GONE = "aim_window_gone";

/**
 * The window this action was aimed at has gone.
 *
 * Its own type because the executor's ladder has to tell it apart from an ordinary UIA failure.
 * "UIA could not do it" is a reason to try the mouse at the entity's rect; "there is nothing
 * there any more" is not — the rect is where the window USED to be, and whatever occupies it now
 * would take the click. That is window drift, one of the five failures the perception graph
 * exists to stop, so this arrives as a refusal rather than as a rung (2ゲート目の指摘).
 */
export class AimedWindowGoneError extends Error {
  readonly hwnd?: bigint;
  constructor(hwnd?: bigint, detail?: string) {
    super(
      `The window this action was aimed at${hwnd !== undefined ? ` (hwnd ${hwnd})` : ""} is gone` +
      `${detail ? `: ${detail}` : ""}. Run desktop_discover again to see what is there now.`,
    );
    this.name = "AimedWindowGoneError";
    this.hwnd = hwnd;
  }
}

/**
 * The coordinates this act would have pressed can no longer be followed to the window it named.
 *
 * `resolvePressPoint` refuses when the point taken from the entity's remembered rect cannot be
 * carried to the window as it is now: the window was MINIMISED (parked at -32000), it was RESIZED
 * (the contents may have reflowed, so it is refused even where the point still falls inside), it
 * MOVED WHILE IT WAS BEING READ (that snapshot's coordinates were measured against more than one
 * position), or there was no origin to follow and the point has left the rectangle. A window that
 * moved WITHOUT resizing is followed automatically and never arrives here, when the coordinates
 * were measured in the same read that measured the window; a move large enough to put the point
 * off the window is answered earlier by the viewport gate (ADR-036 item 5). The refusal
 * was right from the first day; what it threw was a plain `Error`, so `GuardedTouchLoop` reported
 * `executor_failed`, whose published first suggestion is "fall back to mouse_click using the
 * entity rect center". That is the coordinate this refusal just rejected, named verbatim: the
 * executor closed the door and the envelope handed back the key (PR 側 codex, 2026-09-09).
 *
 * Distinct from {@link AimedWindowGoneError}: there the window is gone and nothing addressed to
 * it can succeed; here the window is alive and the coordinate is stale, so a fresh
 * `desktop_discover` returns a rect that works.
 */
export class AimedPointOutsideWindowError extends Error {
  readonly hwnd?: bigint;
  constructor(message: string, hwnd?: bigint) {
    super(message);
    this.name = "AimedPointOutsideWindowError";
    this.hwnd = hwnd;
  }
}

/**
 * Every route to the window the call named has failed, and the blind fallback is refused.
 *
 * An unpinned call finishes a failed UIA click by pressing the entity's rect: a title was never a
 * promise about which window, and the rect is all it ever had. A call that named its window by
 * handle is the opposite case — the coordinate is not aimed at anything, and ADR-036 exists to
 * stop exactly that press. So the ladder ends, and this type carries why.
 *
 * Not click-specific: the type / setValue ladder ends the same way after `uiaSetValue` and the
 * background WM_CHAR rung are both spent, and it was still arriving as `executor_failed` — whose
 * advice opens with the coordinate press the click path had just been taught to refuse. Two
 * actions were giving opposite advice about the same aim (2ゲート目の指摘, 2026-09-09).
 *
 * Same shape as {@link AimedPointOutsideWindowError}, different cause — there the aim went stale,
 * here the aim is current and the attempt on it failed.
 */
export class AimedRouteFailedError extends Error {
  readonly hwnd?: bigint;
  constructor(message: string, hwnd?: bigint, options?: ErrorOptions) {
    super(message, options);
    this.name = "AimedRouteFailedError";
    this.hwnd = hwnd;
  }
}

/**
 * ADR-036 — the handle now belongs to somebody else.
 *
 * The specification's word for this is **invalidation**, and it is deliberately not an ordinary
 * failure: nothing addressed to this aim can succeed, and no retry helps, because the number in
 * the lease names a window that has nothing to do with what was discovered. Windows recycles
 * handles, so this is reachable whenever the aimed window closes between the read and the write.
 *
 * Distinct from {@link AimedWindowGoneError}, which says the handle names nothing at all: there,
 * an action fails and the screen is honest about why; here, an action would have SUCCEEDED against
 * a stranger.
 */
export class AimIdentityChangedError extends Error {
  readonly hwnd: bigint;
  constructor(hwnd: bigint, then: WindowIdentity, now: WindowIdentity | undefined) {
    super(
      `The window this action was aimed at (hwnd ${hwnd}) is not the window the lease was taken on: ` +
      `${describeIdentityChange(then, now)}. Windows reuses handles, so this is a different window wearing ` +
      `the same number — nothing was done to it. Run desktop_discover again.`,
    );
    this.name = "AimIdentityChangedError";
    this.hwnd = hwnd;
  }
}

/**
 * Say which field actually differed, in the same order {@link compareAimIdentity} decides in.
 *
 * The message used to tell one story — "now belongs to a different process" — and print only pid
 * and process name from both sides. When the class check started firing, that produced a refusal
 * that contradicts itself: an application replacing its own window prints *notepad.exe (pid 1234)*
 * on BOTH sides and claims they are different processes (gate 2, 2026-09-09). A reader who trusts
 * the sentence concludes the comparator is broken; a reader who trusts the numbers concludes the
 * refusal is spurious. Neither is true, and neither can be told apart from the text.
 *
 * So the branches here mirror the comparator's exactly, including its two "compared only when both
 * sides have one" rules — a message that names a field the decision did not use would be the same
 * defect pointing the other way.
 */
function describeIdentityChange(then: WindowIdentity, now: WindowIdentity | undefined): string {
  // Unreachable from the executor: `compareAimIdentity` answers "unknown" for an absent `now`, and
  // only "changed" throws. Spelled out anyway because the constructor is public and a caller that
  // built one by hand deserves a sentence rather than "undefined".
  if (!now) return `nothing could say who owns the handle now (it was ${named(then)} when the lease was taken)`;
  if (then.pid !== now.pid) {
    return `it belonged to ${named(then)} and now belongs to ${named(now)}`;
  }
  if (then.processStartTimeMs !== 0 && now.processStartTimeMs !== 0
      && then.processStartTimeMs !== now.processStartTimeMs) {
    return `${named(then)} was restarted — same pid, a later process wearing it`;
  }
  if (then.className !== undefined && now.className !== undefined
      && then.className !== now.className) {
    return `${named(then)} replaced the window on that handle: its class was "${then.className}" ` +
           `when the lease was taken and is "${now.className}" now`;
  }
  // The comparator found something this function does not know how to name — which means the two
  // have been allowed to drift apart. Print both sides whole rather than inventing a reason.
  return `it changed in a way this message does not name yet (then ${JSON.stringify(then, replaceHandle)}, ` +
         `now ${JSON.stringify(now, replaceHandle)})`;
}

function named(id: WindowIdentity): string {
  return `${id.processName || "an unnamed process"} (pid ${id.pid})`;
}

/** `WindowIdentity.hwnd` is a bigint, and `JSON.stringify` throws on those. */
function replaceHandle(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * ADR-036 item 6 — another window is drawn over the point.
 *
 * The specification's ladder for a coordinate press blocks or refocuses here; this blocks, and
 * says which window is in the way so the caller can decide. Refocusing is not done silently
 * because bringing a window forward is a focus change, and focus theft is one of the five failures
 * the perception graph exists to notice — a guard that commits it while enforcing itself would be
 * the same joke as an envelope that recommends the press it just refused.
 *
 * Distinct from {@link AimedPointOutsideWindowError}: there the aim's own rectangle no longer
 * covers the point, and re-discovering fixes it. Here the rectangle is right and something else is
 * on top, so re-discovering returns the same coordinates and the press lands in the same stranger.
 */
export class AimOccludedError extends Error {
  readonly hwnd: bigint;
  constructor(hwnd: bigint, byHwnd: bigint, byTitle: string, x: number, y: number) {
    super(
      `Refusing to press (${x}, ${y}) for the window this act named (hwnd ${hwnd}): the window on top at ` +
      `that point is ${byTitle ? `"${byTitle}"` : "another window"} (hwnd ${byHwnd}), so the press would go there. ` +
      `Bring the intended window forward, or act through a route that does not use coordinates.`,
    );
    this.name = "AimOccludedError";
    this.hwnd = hwnd;
  }
}

// ── The aim as a value ────────────────────────────────────────────────────────

/**
 * ADR-036 — who the aimed window is, beyond its handle.
 *
 * The specification is explicit about why the handle is not enough:
 *
 * > For windows, the runtime row key can be `hwnd`, but **identity must be stronger than `hwnd`**.
 * > If the same `hwnd` appears with a different process identity, RPG treats it as **identity
 * > invalidation**, not an ordinary update.
 *
 * Windows recycles handles. A window that closes between `desktop_discover` and `desktop_act` can
 * leave its number to a window that has nothing to do with the lease, and every check that reads
 * only the handle — including the containment check, which asks the OS for "that window's"
 * rectangle — passes about the replacement.
 *
 * The specification's shape is
 * `WindowIdentity = { hwnd, pid, processStartTime?, processName, className?, titleFingerprint? }`,
 * and every field here is one a `win32` read can actually fill — a field nothing can fill would be
 * a hole wearing a name. It was first written to the three `getWindowIdentity` answers alone;
 * `className` and `titleFingerprint` were added when the same-process case proved the three were
 * not enough, and {@link readWindowIdentityFields} is the one place that fills them, so the three
 * call sites cannot record different things under the same names.
 */
export interface WindowIdentity {
  readonly hwnd: bigint;
  readonly pid: number;
  readonly processName: string;
  readonly processStartTimeMs: number;
  /**
   * The window's class, when it could be read.
   *
   * Process identity alone answers "did the handle move to another program", and Windows also
   * reuses handles INSIDE one program: an application that destroys a top-level window and creates
   * another gets the same pid, the same start time, and can get the same number (PR 側 codex,
   * 2026-09-09). The specification asks for exactly this discriminator —
   * `WindowIdentity = { hwnd, pid, processStartTime?, processName, className?, titleFingerprint? }`
   * — and it was left out when the type was first written to the three fields
   * `getWindowIdentity` answers.
   */
  readonly className?: string;
  /**
   * The window's title when the aim was taken.
   *
   * Recorded, and deliberately NOT decisive: a document window renames itself on every save, and a
   * browser tab on every navigation, so a changed title is the ordinary case rather than evidence
   * of a different window. It is here so a report can say what the window was called, and so a
   * future rule that wants it does not have to re-take the observation.
   */
  readonly titleFingerprint?: string;
}

/**
 * ADR-036 — what an action is aimed at, as one value.
 *
 * The handle used to ride as a trailing optional argument on every backend call, which is how a
 * route added later was not made to carry it: `{ title, hwnd, identity }` in one place cannot be
 * forgotten by construction. That is item 2 of the restoration, and the disease it treats is the
 * same one it was diagnosing — identity that is not a first-class thing gets carried by hand,
 * layer by layer, until a layer drops it.
 *
 * `kind` is a brand rather than decoration: the executor still accepts a raw `TargetSpec` from the
 * many callers (mostly tests) that have not been migrated, and the two shapes are otherwise
 * structurally close enough to confuse — `hwnd` is a decimal STRING on one and a `bigint` on the
 * other, which is exactly the kind of near-miss this ADR keeps finding.
 */
export interface Aim {
  readonly kind: "aim";
  /** The title the read resolved, for the backends that can only search by one. */
  readonly title?: string;
  /** The handle the read was scoped to, when it had one. */
  readonly hwnd?: bigint;
  /** Browser tab, carried through unchanged. */
  readonly tabId?: string;
  /**
   * Who that handle belonged to when the aim was taken. Absent when the question could not be
   * answered (no native binding, the process already gone) — and absence is NOT evidence of a
   * different window, so nothing may refuse on it.
   */
  readonly identity?: WindowIdentity;
  /**
   * ADR-036 item 5 — where the aimed window WAS when these coordinates were taken.
   *
   * Every entity rect in a snapshot is in screen coordinates, and a screen coordinate is only
   * meaningful next to the window origin it was measured against. Without this the executor can
   * ask "is the point still inside the window", which a window that moved with the point still
   * inside passes, and cannot ask "where did that point go" — which is the specification's first
   * rung: *if rect moved, apply homing correction*.
   *
   * Absent means nothing measured an origin — an aim from before this rung, a build that cannot
   * ask — and absence is not evidence, so it costs the correction and nothing else.
   */
  readonly origin?: AimOrigin;
}

/**
 * ADR-036 item 5 — what the read could say about the window's position while it was reading.
 *
 * One value rather than a rectangle plus a flag, because the two would have to be kept in step and
 * a disagreement between them would be unreadable. The second case is the one that keeps being
 * re-learned on this branch in a new place: **"could not ask" and "asked, and the answer is that
 * the coordinates are unusable" are not the same fact**, and merging them into an absent rectangle
 * turns a refusal into a silent blind press (gate 1, third pass, 2026-09-09).
 */
export type AimOrigin =
  /** The window held this rectangle for the whole read, so every coordinate is relative to it. */
  | { kind: "measured"; rect: WindowRect }
  /**
   * The window MOVED while the lanes were reading it. There is no single origin those coordinates
   * were all measured against — an early lane's candidate describes one position and a late one's
   * another — so nothing can be corrected and nothing can be trusted. A coordinate press on this
   * snapshot is refused.
   */
  | { kind: "moved_during_read" };

/** A window rectangle in screen coordinates, as `getWindowRectByHwnd` answers it. */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The `TargetSpec` shape, structurally, so this module does not depend on the session registry. */
interface TargetSpecLike {
  windowTitle?: string;
  hwnd?: string;
  tabId?: string;
}

/**
 * Read either shape as an {@link Aim}.
 *
 * A raw `TargetSpec` becomes an aim with no identity — which is the truth about it: the caller's
 * words were never evidence about who owns the window. Migrating a call site means giving it a
 * real `Aim`; until then it keeps exactly the behaviour it had.
 */
export function toAim(input: Aim | TargetSpecLike | undefined): Aim {
  if (input === undefined) return { kind: "aim" };
  if ((input as Aim).kind === "aim") return input as Aim;
  const spec = input as TargetSpecLike;
  return {
    kind: "aim",
    title: spec.windowTitle,
    hwnd: parseHandle(spec.hwnd),
    tabId: spec.tabId,
  };
}

/**
 * The one place that decides whether a string names a handle.
 *
 * Same rule as `parseTargetHwnd` in `session-registry.ts` — non-positive and unreadable both mean
 * "no handle" — and deliberately a second implementation rather than an import: this module is
 * imported by the engine, and the registry imports the engine. The rule is four lines and the
 * agreement between them is pinned by a test; a cycle to share it would cost more than it saves.
 */
function parseHandle(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    const h = BigInt(raw);
    return h <= 0n ? undefined : h;
  } catch {
    return undefined;
  }
}

/**
 * ADR-036 item 5 — the specification's homing correction, as one decision.
 *
 * > Need `safe.clickCoordinates(target, x, y)`
 * >   -> check cached target rect and z-order
 * >   -> refresh target rect via Win32 if stale or dirty
 * >   -> **if rect moved, apply homing correction**
 * >   -> if another top-level window covers point, block or refocus
 * >   -> if target identity changed, invalidate coordinates
 *
 * A point taken from a snapshot is a screen coordinate, and a screen coordinate means something
 * only next to the window origin it was measured against. When the window has moved and nothing
 * else has changed, the point the caller means is the same OFFSET INSIDE the window, not the same
 * place on the screen. The implementation had only the containment check, which asks a different
 * question and answers "still inside" for exactly the case that goes wrong:
 *
 * > Measured on Windows 2026-09-09 (win2, five stacked buttons whose own click handlers write to a
 * > log): a lease taken on the title bar, the window moved 71 px up, the remembered point left
 * > where it was — `desktop_act` returned `ok:true`, `executor:"mouse"`, and the button that
 * > logged the press was `BTN1`, which the lease had never named.
 *
 * Deliberately narrow, because the three refusals are the honest answers to the cases a
 * translation cannot describe:
 *
 *   - **Resized.** A window that changed size may have reflowed its contents, and moving the point
 *     by the origin's delta would be inventing a layout. Not corrected, and the row says so.
 *   - **The point was not inside the window to begin with.** An owned popup — a dropdown, a
 *     context menu — lives outside its owner's rectangle, and the owner's delta is not its delta.
 *   - **Nothing to compare against.** No origin rectangle means the aim predates this rung or the
 *     read could not answer, and a correction invented from one rectangle is not a correction.
 *
 * Pure, and returns the reason in every branch: a press that was NOT corrected has to be
 * distinguishable in the log from a press that was never asked about.
 */
export type Homing =
  | { applied: true; x: number; y: number; dx: number; dy: number }
  | {
      applied: false;
      x: number;
      y: number;
      why:
        | "no_origin_rect"
        | "moved_during_read"
        | "not_moved"
        | "window_resized"
        | "point_was_outside_origin"
        | "owned_popup_at_remembered_point"
        | "measured_in_another_window"
        | "measurement_moment_unknown"
        | "window_off_desktop";
    };

/**
 * Windows parks a minimised window at `-32000, -32000`, keeping its size.
 *
 * Without this, a minimised window reads as an ordinary move of about 32000 px: the point would be
 * translated into the parked rectangle, containment would PASS (the point really is inside it), and
 * the caller would get a generic coordinate failure from the reachability check instead of the
 * refusal that names the cause and says what to do (gate 1, 2026-09-09). That is a regression this
 * rung would have introduced into a case the code already handled — the parked rectangle is how
 * containment recognised a minimised window in the first place.
 */
const OFF_DESKTOP = -32000;

/**
 * ADR-036 item 5 — lanes whose coordinates were measured DURING this observation.
 *
 * The correction is only valid when the coordinates and the origin describe the same moment. The
 * origin is bracketed around the provider fan-out, so it describes that moment — and every lane
 * reading inside the fan-out is covered by it. `visual_gpu` is not: `getStableCandidates()` hands
 * back the backend's STORED snapshot, whose rectangles may have been captured at a position
 * neither bracket read saw.
 *
 * Correcting those is a REGRESSION, not an imprecision. With `P_cap` the window position at
 * capture, `P_brk` what the bracket saw, `P_act` the position at act time: without this rung the
 * press is right when `P_act == P_cap`; with it, when `P_cap == P_brk`. A window that moved after
 * the capture, sat elsewhere while the lanes ran and came BACK by act time was therefore pressed
 * correctly before the rung and incorrectly after it.
 *
 * `inferred` is out for the same reason with less evidence: nothing says when it was measured.
 *
 * **Two names, not six.** The first version listed `win32`, `som`, `cdp` and `terminal` as well,
 * which asserted a property no name is tied to: `win32` and `som` are emitted by no provider in
 * `composeCandidatesInner` at all, and `cdp` candidates carry no rect, so nothing on the mouse
 * route ever arrived under them (gate 2, 2026-09-10). An allowlist of names is a claim about lanes,
 * and a lane added later under a listed name inherits a trust nobody re-granted — which is exactly
 * how `visual_gpu` was found. Listing only what exists keeps the next lane's arrival a decision.
 *
 * The property this really wants is on the observation, not on its lane's name: an origin recorded
 * WITH each capture would answer it directly, and that is the lane work ADR-036 item 5 carries.
 */
const BRACKETED_SOURCES: ReadonlySet<string> = new Set(["uia", "ocr"]);

/**
 * ADR-036 — the handle of the window an entity was actually observed in, when it is one.
 *
 * `origin.id` is provider-defined and is usually the caller's QUERY — a title, or `"@active"` — so
 * only `origin.hwnd` is read, which ADR-029 defines as *"the handle of the window the candidate was
 * actually observed in, when the producer knows it"*. A browser tab has no window handle and is
 * skipped by the same rule. Non-positive and unreadable both mean "no handle", as everywhere else
 * in this ADR.
 *
 * Structural parameter rather than `UiEntity`, so this module keeps its independence from the
 * world-graph types.
 */
export function observedHwndOfOrigin(
  origin: { kind: "window" | "browserTab"; hwnd?: string } | undefined,
): bigint | undefined {
  const raw = origin?.kind === "window" ? origin.hwnd : undefined;
  return parseHandle(raw);
}

/**
 * ADR-036 item 5 — the correction, and every policy that decides whether it may run.
 *
 * **One function, and that is the fix for a defect this branch has now made three times.** Twice a
 * new policy arrived as a wrapper in FRONT of the ladder, and both times it became a third
 * short-circuit ahead of the rung the ladder's own first comment says is asked "FIRST":
 *
 *   - the sources gate, which answered `measurement_moment_unknown` for a `visual_gpu` entity on a
 *     MINIMISED window, so the minimise refusal never fired and the caller was told to bring a
 *     minimised window forward (gate 2, 2026-09-10);
 *   - the capture-window guard below, which answered `measured_in_another_window` for an entity
 *     captured in an owned popup while the aim was minimised or smeared — and `resolvePressPoint`
 *     switches on this reason, so BOTH whole-snapshot refusals were skipped and the `owned`
 *     allowance pressed the remembered point of a snapshot known to be unusable (PR 側 codex,
 *     2026-09-10).
 *
 * A wrapper is where the next policy would go as well, so there is no longer a function to wrap.
 * Every verdict is a RUNG here, in the order it is asked, and a new one has to be given a place in
 * that order rather than a place in front of it.
 *
 * **Where these reasons actually go.** Into the `act.route` probe row, and into the message of
 * `AimedPointOutsideWindowError` — which `desktop-register.ts` replaces with fixed text and
 * `guarded-touch.ts` collapses to a reason code. So a caller does not see which rung declined; only
 * the log does (gate 2, 2026-09-10, correcting the previous version of this comment, which said the
 * reason "goes in the published refusal text"). Carrying the engine's message through the envelope
 * is ADR-036 item 13. Until it is done, the order below is chosen for what it PRESSES, not for what
 * it says.
 *
 * **Every caller goes through here, and that is the point.** The first version put the policy in
 * the executor and left the correction unconditional, so the frame-diff focal point — the second
 * caller — kept applying a correction the press path had already learned to decline (found by win2
 * auditing the review, 2026-09-10). A guard added in one of two callers is the defect this branch
 * keeps re-finding, and that time it was reproduced INSIDE the fix for it.
 *
 * What stays out of here is the one signal that needs the screen: an owned popup sitting on the
 * remembered point. Only the press path can ask (it holds the `pointOwner` dep), so only the press
 * path declines for it — which means a diagnostic region can still be corrected where the press was
 * not. That costs an off-centre SSIM window and never a press, and it is written down rather than
 * silently uneven.
 */
export function homingCorrectionForSources(
  sources: readonly string[],
  aimOrigin: AimOrigin | undefined,
  current: WindowRect,
  x: number,
  y: number,
  /**
   * ADR-036 item 5 — which window these coordinates were captured in, and which window the origin
   * describes. When both are known and they differ, the origin's delta is not theirs.
   *
   * This is the screen-free half of the owned-popup guard. The other half asks `pointOwner` at the
   * remembered point, and that dep is OPTIONAL by design — a build whose enumeration cannot answer
   * must not have every aimed action refused — so on a build without it the popup case had nothing
   * standing in front of it at all (gate 2, 2026-09-10). This half needs no enumeration: ADR-029
   * already records "the handle the capture actually resolved" on every candidate it produces, and
   * `productionCheckViewport` uses it for exactly this question. It was there and unread.
   *
   * Absent on either side means no evidence, which costs the guard and not the press.
   */
  window?: { capturedIn?: bigint; originOf?: bigint },
): Homing {
  // Asked FIRST, before the origin short-circuits and before either question about whose
  // measurement these coordinates are, because "parked off the desktop" is a property of the
  // current rectangle alone and needs no origin to establish. Asked after them, an aim with no
  // origin — the direct `candidateProvider` road, or a bracket read that could not answer — fell
  // through to the occlusion rung, which filters minimised windows out of its own candidates and
  // named whatever was over the remembered point: the caller was told to bring a MINIMISED window
  // forward (gate 2, third pass). The rung was closed for measured origins only.
  if (current.x <= OFF_DESKTOP || current.y <= OFF_DESKTOP) {
    return { applied: false, x, y, why: "window_off_desktop" };
  }
  // ONLY the rung above is about the screen. Everything from here down compares an ORIGIN to a
  // CURRENT rectangle, and both of those belong to the window the aim resolved — so the first
  // question is whether these coordinates belong to that window at all.
  //
  // Asked before the two origin verdicts, and that took two corrections in opposite directions.
  // Below them it produced a false refusal: `moved_during_read` is manufactured from two bracket
  // reads of the AIM's rectangle, and an owned popup does not move when its owner moves, so an
  // entity captured in a dropdown was refused as "the window would not hold still" on evidence
  // about a window it does not live on — a press that was correct before this rung existed (gate 2,
  // 2026-09-10). Above them, an earlier round had it short-circuit `window_off_desktop` as well,
  // which is why that one stays first: a parked owner hides its popups with it, so there is nothing
  // on screen for these coordinates either way.
  //
  // What this verdict is NOT is permission. The caller holds the one piece of evidence that can
  // stand in for the comparisons below — who is under the point NOW — and it may press only where
  // that answer is the window the pixels came from. See `measured_in_another_window` in the
  // executor: the reason travels with the handle so the caller can ask.
  if (window?.capturedIn !== undefined && window.originOf !== undefined
      && window.capturedIn !== window.originOf) {
    return { applied: false, x, y, why: "measured_in_another_window" };
  }
  if (!aimOrigin) return { applied: false, x, y, why: "no_origin_rect" };
  // Not a missing measurement: a measurement that says these coordinates are unusable. The caller
  // refuses on it, where `no_origin_rect` costs only the correction.
  if (aimOrigin.kind === "moved_during_read") return { applied: false, x, y, why: "moved_during_read" };

  const origin = aimOrigin.rect;
  // Asked before the resize test on purpose. A point that was never inside this window — an owned
  // popup, which has its own origin — was not described by this window's layout, so a change in
  // that layout says nothing about it. Testing the resize first would refuse a dropdown press
  // because its OWNER had been resized.
  //
  // The converse — a modal dialog or a dropdown that opens OVER its combo, so its centre sits
  // INSIDE the owner's rectangle — is NOT a blind spot to record, because it is a REGRESSION: an
  // owned top-level window does not move when its owner moves, so correcting by the owner's delta
  // moves a point that was correct, and the ownership test then runs at the moved point and can see
  // the owner as clear. That is a press the code got right before this rung existed (PR 側 codex on
  // #609, second round), and it is the one outcome a new rung may not produce. The caller therefore
  // asks who is under the REMEMBERED point before adopting a correction, and declines it when the
  // answer is a window the aim owns — see `owned_popup_at_remembered_point` in the executor.
  if (!containsPoint(origin, x, y)) return { applied: false, x, y, why: "point_was_outside_origin" };
  if (origin.width !== current.width || origin.height !== current.height) {
    return { applied: false, x, y, why: "window_resized" };
  }

  // LAST, and it took a round to learn why. This is the only verdict here that is about the
  // COORDINATES rather than about the window, and the caller refuses on several of the ones above
  // it — so answering first meant answering INSTEAD of them. A `visual_gpu` entity on a window that
  // had been RESIZED came back `measurement_moment_unknown`, the executor's resize refusal never
  // fired (it switches on `window_resized`), and the remembered point was pressed into a layout
  // that may have reflowed underneath it — a press that was refused before this gate existed
  // (PR 側 codex, 2026-09-10). The same shape as the two rungs above, for the third time on this
  // branch: a new question placed before an older refusal takes its turn.
  //
  // Below the geometry, it still does its whole job: a window that merely MOVED is not followed for
  // a lane the bracket cannot vouch for, which is the regression this gate exists to prevent.
  //
  // Every source, not any: a merged entity is only as trustworthy as its least-dated lane.
  if (sources.length === 0 || !sources.every((src) => BRACKETED_SOURCES.has(src))) {
    return { applied: false, x, y, why: "measurement_moment_unknown" };
  }

  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  if (dx === 0 && dy === 0) return { applied: false, x, y, why: "not_moved" };
  return { applied: true, x: x + dx, y: y + dy, dx, dy };
}

/** Half-open on the far edges, the same rule the containment check uses. */
export function containsPoint(rect: WindowRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * ADR-036 — read a window's identity the same way everywhere.
 *
 * Three places take this baseline: the ingress path (`compose-providers.ts`), the fallback for
 * results that carried none (`desktop.ts::_aimFor`), and the act-side re-read (the executor's
 * `aimIdentity` dep). They were three copies of the same fifteen lines, and they had already
 * drifted: two recorded `target.windowTitle` — the caller's SEARCH STRING, so
 * `desktop_discover({windowTitle: "Notepad"})` against "Untitled - Notepad" filed the query as the
 * window's title — while the third recorded the live `GetWindowTextW`. Nothing consumes the field
 * yet, so nothing was refused wrongly; the first rule that compares the two sides would have
 * refused every act (gate 2, 2026-09-09).
 *
 * The reads are passed in rather than imported so this module stays free of `win32` (the engine
 * imports it, and one of the callers loads `win32` lazily on purpose). What lives here is the
 * POLICY, which is the part that was inconsistent:
 *
 *   - a zeroed pid is "could not ask", and becomes nothing at all rather than a value;
 *   - an empty class or title is "could not read it", not "it has none", so it is dropped;
 *   - a throwing secondary read costs its own field and not the whole identity.
 *
 * Not atomic — the handle can change hands between the calls — so the identity is read again after
 * the secondary reads and a sample that moved under us is discarded instead of returned. See the
 * body for why the earlier reasoning ("a cross-process tear fails safe") was wrong: two windows can
 * share a framework class, and then the chimera matches the lease on every compared field.
 *
 * What this does NOT do is close the gap between the check and the press. Nothing here can: that
 * gap is milliseconds to seconds wide and this one is microseconds. It only stops the function from
 * reporting a window that never existed (gate 1 and the PR review, 2026-09-09; ADR-036 item 9).
 */
export function readWindowIdentityFields(
  hwnd: bigint,
  reads: {
    identity: (hwnd: bigint) => { pid: number; processName: string; processStartTimeMs: number } | undefined;
    className?: (hwnd: bigint) => string;
    title?: (hwnd: bigint) => string;
  },
): WindowIdentity | undefined {
  // Two attempts, because a sample assembled from two windows describes neither.
  //
  // The reads are not atomic, and the handle can change hands between them. The comment that used
  // to stand here claimed that only the same-process case mattered, because a cross-process tear
  // would leave a pid that no longer matches and fail safe. **That was wrong, and the PR review
  // found the case**: two windows can share a framework class (`Chrome_WidgetWin_1`, `#32770`),
  // and then the chimera — the OLD process's pid with the NEW window's class — matches the lease
  // on every compared field. `compareAimIdentity` answers "same" and the act goes to the stranger.
  //
  // So the identity is read again after the secondary reads, and a sample that moved under us is
  // thrown away rather than returned. Retrying once is enough: a handle changing hands twice inside
  // two microsecond-scale reads is not a case worth a loop, and the second attempt is what makes
  // the act-side comparison see the NEW process and refuse. This does NOT close the gap between the
  // check and the press — nothing here can, and that gap is milliseconds to seconds wider — but it
  // stops this function from inventing a window that never existed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const sample = readOneSample(hwnd, reads);
    if (sample) return sample;
  }
  return undefined;
}

/** One internally consistent sample, or nothing when the handle moved under the read. */
function readOneSample(
  hwnd: bigint,
  reads: {
    identity: (hwnd: bigint) => { pid: number; processName: string; processStartTimeMs: number } | undefined;
    className?: (hwnd: bigint) => string;
    title?: (hwnd: bigint) => string;
  },
): WindowIdentity | undefined {
  let ident;
  try {
    ident = reads.identity(hwnd);
  } catch {
    return undefined;
  }
  if (!ident || ident.pid === 0) return undefined;
  const className = readOrNothing(reads.className, hwnd);
  const titleFingerprint = readOrNothing(reads.title, hwnd);
  // The same questions again, after the reads that could have straddled a handover.
  //
  // BOTH of them, and the first version of this check only re-read the identity — which validates
  // the process fields while leaving out the one this commit exists for. A window replaced inside
  // ONE process gives two identical identity reads (same pid, same start time) around a class read
  // that captured the old window, so the sample passed the check carrying a class the handle no
  // longer has, `compareAimIdentity` answered "same", and the act went to the replacement (PR 側
  // codex on #608, second round). A consistency check has to cover every field the comparison
  // reads, or it certifies the sample against the wrong question.
  let after;
  try {
    after = reads.identity(hwnd);
  } catch {
    return undefined;
  }
  if (!after || after.pid === 0) return undefined;
  if (after.pid !== ident.pid || after.processStartTimeMs !== ident.processStartTimeMs) return undefined;
  if (readOrNothing(reads.className, hwnd) !== className) return undefined;
  return { hwnd, pid: ident.pid, processName: ident.processName, processStartTimeMs: ident.processStartTimeMs, className, titleFingerprint };
}

function readOrNothing(read: ((hwnd: bigint) => string) | undefined, hwnd: bigint): string | undefined {
  if (!read) return undefined;
  try {
    return read(hwnd) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * ADR-036 — whether the window behind the aim is still the one the aim was taken on.
 *
 * Returns `"same"`, `"changed"`, or `"unknown"`, and the third is not a polite form of the second.
 * `getWindowIdentity` answers a zeroed identity when it could not ask — no native binding, a
 * process already gone — and reading that as "changed" would refuse every action on a build that
 * cannot answer the question, about windows that are on screen. The same rule cost a round when it
 * was forgotten one file over: a null rectangle is not a gone window.
 */
export function compareAimIdentity(
  aim: Aim,
  now: WindowIdentity | undefined,
): "same" | "changed" | "unknown" {
  const then = aim.identity;
  if (!then || !now) return "unknown";
  if (now.pid === 0 || then.pid === 0) return "unknown";
  if (now.pid !== then.pid) return "changed";
  // Same pid can still be a different process: Windows reuses those too, and the start time is
  // what tells one generation of a pid from the next. Compared only when both sides have it,
  // because a zero there means the same "could not ask".
  if (then.processStartTimeMs !== 0 && now.processStartTimeMs !== 0
      && then.processStartTimeMs !== now.processStartTimeMs) {
    return "changed";
  }
  // And the same PROCESS can hand the same handle to a different window. Class is the cheapest
  // discriminator that is a property of the window rather than of its owner, and it is in the
  // specification's shape for that reason. Compared only when both sides have one — a missing
  // class is another unanswered question, not a mismatch.
  if (then.className !== undefined && now.className !== undefined
      && then.className !== now.className) {
    return "changed";
  }
  // What is left: one process destroying a window and creating another OF THE SAME CLASS before
  // the act. Pid, start time and class all match, and nothing readable here separates them —
  // telling those apart needs a per-window generation the native side does not expose. Recorded in
  // ADR-036 rather than papered over: the title is not it (documents rename themselves), and
  // guessing here would trade a silent wrong press for a noisy wrong refusal.
  return "same";
}
