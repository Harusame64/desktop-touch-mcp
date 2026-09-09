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
      `The window this action was aimed at (hwnd ${hwnd}) now belongs to a different process: it was ` +
      `${then.processName || "an unnamed process"} (pid ${then.pid}) when the lease was taken and is ` +
      `${now?.processName || "an unnamed process"} (pid ${now?.pid ?? 0}) now. Windows reuses handles, so ` +
      `this is a different window wearing the same number — nothing was done to it. Run desktop_discover again.`,
    );
    this.name = "AimIdentityChangedError";
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
 * Held as the three fields `win32.getWindowIdentity` can actually answer, rather than the
 * specification's full shape: a field this cannot fill would be a hole wearing a name.
 * `className` and `titleFingerprint` are the obvious next two when something needs them.
 */
export interface WindowIdentity {
  readonly hwnd: bigint;
  readonly pid: number;
  readonly processName: string;
  readonly processStartTimeMs: number;
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
  return "same";
}
