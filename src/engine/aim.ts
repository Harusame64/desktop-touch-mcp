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
 * The aimed press would land outside the window it named.
 *
 * `assertPointIsInsideAim` refuses when the point taken from the entity's remembered rect is no
 * longer inside the aimed window — it moved, or it was minimised (rect at -32000). The refusal
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
  // The same question again, after the reads that could have straddled a handover. A pid or start
  // time that has moved means the class and title just read belong to a different window from the
  // process identity above them.
  let after;
  try {
    after = reads.identity(hwnd);
  } catch {
    return undefined;
  }
  if (!after || after.pid === 0) return undefined;
  if (after.pid !== ident.pid || after.processStartTimeMs !== ident.processStartTimeMs) return undefined;
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
