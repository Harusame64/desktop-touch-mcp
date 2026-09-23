/**
 * keyboard-target.ts — ADR-036 family 2: may the keyboard rung post here?
 *
 * The keyboard rung of `desktop_act` posts WM_CHAR to whatever holds the focus of the window's thread.
 * It used to answer `ok:true` without asking whether that was the field the caller named, and win2
 * measured the result: a type aimed at a read-only field went into the field beside it, and a type
 * into a dialog's owner went into the dialog (internal #74, #85).
 *
 * The user's contract (2026-09-11): "拒む、ただしその根拠が明確なとき" — refuse, but only when the
 * grounds are clear — and "分からないときは2": when the facts cannot say, post anyway and mark the
 * success. This file is that decision, whole and in one place (internal `dev/fam2-refusal/DESIGN.md`
 * §3, read twice by gate 2). It is pure. The executor reads the facts, this judges them, and the
 * executor posts or throws.
 *
 * Where it departs from the specification: the spec says to fail closed for actions and names this
 * guard `safe.keyboardTarget`. The "cannot say" branch posts anyway, by the user's decision, and the
 * route check's spec-side table records that as a waiver. Only the refusals below implement the guard.
 */
import type { CallerFacingRefusal } from "./aim.js";

/** The grounds the rule refuses on. Each is stated from facts the rung reads before posting. */
export type KeyboardGround = "other_window" | "read_only" | "other_control" | "disabled";
export const KEYBOARD_GROUNDS: readonly KeyboardGround[] = ["other_window", "read_only", "other_control", "disabled"];

/** Which window the rule took to be the named control's (see {@link judgeKeyboardTarget}). */
export type ReferenceFrom = "entity" | "origin" | "aim" | "lookup" | "none";

/** Why a post could not be confirmed. Written on the success it marks. */
export type LandingWhy =
  | "receiver_unknown"
  | "reference_unknown"
  | "receiver_in_owned_window"
  | "receiver_in_other_window"
  | "receiver_is_window"
  | "entity_windowless"
  | "entity_handle_stale"
  | "parents_unread"
  | `ground_disabled:${KeyboardGround}`;

/**
 * Whom a refusal is about, so its sentence does not blame the wrong control. `window` is the window
 * the entity was captured in, for a `disabled` refusal about a control with no window of its own.
 */
export type RefusalSubject = "named" | "focused_inside_named" | "focused" | "window";

/**
 * How the act named its window. The way back differs: a text field has no UIA invoke, so the click
 * that moves the focus to it is only reached on the title road, where the ladder downgrades to a
 * checked press. On the handle road that click ends as `aim_route_failed` with nothing pressed, so a
 * sentence that tells such a caller to click the field is a dead end (gate 2).
 */
export type KeyboardRoad = "handle" | "title";

/**
 * The facts §3 reads. Every handle is compared in its unsigned low 32 bits: UIA writes the named
 * control's handle that way, while `GetFocus` hands the receiver over widened to 64.
 */
export interface KeyboardFacts {
  /** E — the named control's own window (`locator.uia.nativeWindowHandle`). Null when it has none. */
  entityHwnd: bigint | null;
  /**
   * GA_ROOT(E). Null when E is null, or when E is dead: a destroyed or recreated handle has no root.
   * `isWindowGone` is not the test, because it answers "not gone" when it cannot ask.
   */
  entityRoot: bigint | null;
  /** GA_ROOT of the window the entity was captured in (`entity.origin`). Null when absent or closed. */
  originRoot: bigint | null;
  /** GA_ROOT of the window the act named by handle. Null when it named none, or it has closed. */
  aimRoot: bigint | null;
  /** GA_ROOT of the window the rung looked up to write to. */
  lookupRoot: bigint | null;
  /** T — the handle the characters will be posted to. */
  receiver: bigint | null;
  /** GA_ROOT(T). */
  receiverRoot: bigint | null;
  /** T's parents, nearest first, not including its root. May be partial: see `ancestorsComplete`. */
  receiverAncestors: readonly bigint[];
  /** Whether the parent walk reached T's root. A partial walk still counts as evidence of "inside". */
  ancestorsComplete: boolean;
  /** True only for an Edit-family class with ES_READONLY. Null when the facts cannot say. */
  receiverReadOnly: boolean | null;
  /**
   * The owners of T's root, nearest first (GW_OWNER, bounded). The walk ends at a null, and
   * `getWindowOwner` answers null both for "no owner" and for "the call failed", so a walk that did
   * not meet the reference window proves nothing.
   */
  ownerChain: readonly bigint[];
  /**
   * Whether E's own window AND its top-level window take input (`IsWindowEnabled` on both). Null when
   * E has no window, or the OS could not be asked. `false` only when it was read.
   */
  entityTakesInput: boolean | null;
  /** The same about the window the entity was captured in (`entity.origin`). Null when absent or unread. */
  originTakesInput: boolean | null;
  /** Whether the value road, just before, failed because UI Automation said the element is disabled. */
  valueRoadSaidDisabled: boolean;
  /**
   * Internal #167 — whether the value road, just before, failed because UI Automation said the
   * element is READ-ONLY. Optional so a caller that predates it says nothing (read as false).
   */
  valueRoadSaidReadOnly?: boolean;
}

export type KeyboardVerdict =
  | { kind: "post"; confirmed: true; referenceFrom: ReferenceFrom }
  | { kind: "post"; confirmed: false; why: LandingWhy; referenceFrom: ReferenceFrom }
  | { kind: "refuse"; ground: KeyboardGround; subject: RefusalSubject; referenceFrom: ReferenceFrom };

function same(a: bigint, b: bigint): boolean {
  return BigInt.asUintN(32, a) === BigInt.asUintN(32, b);
}

/**
 * The rule. The first step that matches decides.
 *
 * R, the reference window, is the window the named control lives in. It is the first of these that
 * is alive: GA_ROOT(E); the window the entity was captured in; the window the act named; the window
 * the rung looked up. The rung's own lookup is the last resort, because on the title road it takes
 * the first window whose title contains the string, and that can be a same-titled sibling.
 *
 * 0. The field does not take input: E is usable and its window (or E's top-level window) is
 *    disabled → refuse `disabled`. Measured before this step existed (win2, internal `07a597a`): a
 *    field disabled after discover answered `ok:true` with nothing typed on three of four arms, and
 *    on the fourth was refused as `other_control` — the focus had simply left the disabled field. E's
 *    own state was disabled on all four; the receiver's was on one. It comes first so that fourth arm
 *    is named for what it is, and its way back is not "click the field". The user's decision,
 *    2026-09-19.
 *    With no usable E, the window the entity was captured in is evidence only together with the value
 *    road's own "disabled": that window is the root of the READ, and an owned dialog's fields are read
 *    through their owner — which the dialog itself disables — so the captured window alone refused a
 *    write into the dialog that step 3 would have posted (gate 2). Never the aim's or the looked-up
 *    window: either can be a same-titled sibling. Not asked is not evidence.
 * 1. T or its root cannot be read → cannot say.
 * 2. E is usable, and T is E, or E is among T's parents (a partial walk counts), or E is T's root:
 *    the named control or a window inside it. Refuse `read_only` if T does not take typing;
 *    otherwise post, confirmed. This comes first, so a field in an owned dialog, found through its
 *    owner's tree, is confirmed before any window comparison could refuse it.
 * 3. T's root is not R: refuse `other_window` when E is usable. Otherwise cannot say, whether or not
 *    T's window is owned by R. This comes before step 4, so a receiver that is itself another
 *    top-level window is refused rather than read as "the window itself".
 * 4. T is R itself → cannot say. The native side answers this both when the thread has no focus and
 *    when it could not ask. WPF lands here.
 * 5. E is usable and T's parent walk reached its root without meeting E → refuse `other_control`.
 *    This comes before step 6, so a read-only neighbour is named as another control.
 * 6. E is not usable and T is read-only → refuse `read_only`. The characters are dropped whichever
 *    element was named.
 * 7. Otherwise → cannot say.
 *
 * `disabled` is the switch's per-ground form. A disabled ground's step still decides; it answers a
 * marked success instead of the refusal, and does not fall through to a later step. **Except step 0**:
 * it is a ground about the field, and the steps after it are about the receiver, so switching
 * `disabled` off runs them — a refusal they make stands, and a post is marked `ground_disabled:disabled`.
 * Deciding there would have switched off `other_control` and `other_window` with it (gate 2).
 */
export function judgeKeyboardTarget(
  f: KeyboardFacts,
  disabled: ReadonlySet<KeyboardGround> = new Set(),
): KeyboardVerdict {
  const eUsable = f.entityHwnd !== null && f.entityRoot !== null;
  const [reference, referenceFrom]: [bigint | null, ReferenceFrom] =
    eUsable ? [f.entityRoot, "entity"]
    : f.originRoot !== null ? [f.originRoot, "origin"]
    : f.aimRoot !== null ? [f.aimRoot, "aim"]
    : f.lookupRoot !== null ? [f.lookupRoot, "lookup"]
    : [null, "none"];
  const cannotSay = (why: LandingWhy): KeyboardVerdict => ({ kind: "post", confirmed: false, why, referenceFrom });

  // 0.
  if (eUsable ? f.entityTakesInput === false : f.valueRoadSaidDisabled && f.originTakesInput === false) {
    if (!disabled.has("disabled")) return { kind: "refuse", ground: "disabled", subject: eUsable ? "named" : "window", referenceFrom };
    const rest = judgeTheReceiver(f, disabled, eUsable, reference, referenceFrom);
    return rest.kind === "refuse" ? rest : cannotSay("ground_disabled:disabled");
  }
  // Internal #167 — the named control told the value road it does not take a value. Measured on real
  // hardware (win2, 2026-09-23, internal `c56ec5c`): Notepad's status-bar field (`Edit`,
  // `IsReadOnly=true`, no window of its own) answered the value road `element_read_only`, the rung
  // then could not compare handles, said `entity_windowless`, posted — and the characters landed in
  // the focused body, under `ok:true`. Keystrokes cannot write a field that refuses a value, so
  // wherever they go it is not the field the caller named. The existing `read_only` ground, said of
  // the named control: no new word.
  //
  // **Only for a field with no window of its own** (gate 2). The value road's answer is about "the
  // element the route matched", which the by-handle scripts pick by name containment — not always
  // the named control. When the named control HAS a window, the rule below reads that window
  // directly, and a receiver that is the named control and takes text is a confirmed write whatever
  // the value road said. Without a window there is no such fact to prefer: the value road's success
  // would have been believed as "the field was written", so its read-only failure is believed too.
  if (f.valueRoadSaidReadOnly === true && !eUsable) {
    if (!disabled.has("read_only")) return { kind: "refuse", ground: "read_only", subject: "named", referenceFrom };
    const rest = judgeTheReceiver(f, disabled, eUsable, reference, referenceFrom);
    return rest.kind === "refuse" ? rest : cannotSay("ground_disabled:read_only");
  }
  return judgeTheReceiver(f, disabled, eUsable, reference, referenceFrom);
}

/** Steps 1–7: where the characters would go, against the named control. */
function judgeTheReceiver(
  f: KeyboardFacts,
  disabled: ReadonlySet<KeyboardGround>,
  eUsable: boolean,
  reference: bigint | null,
  referenceFrom: ReferenceFrom,
): KeyboardVerdict {
  const cannotSay = (why: LandingWhy): KeyboardVerdict => ({ kind: "post", confirmed: false, why, referenceFrom });
  const refuse = (ground: KeyboardGround, subject: RefusalSubject): KeyboardVerdict =>
    disabled.has(ground) ? cannotSay(`ground_disabled:${ground}`) : { kind: "refuse", ground, subject, referenceFrom };

  // 1.
  if (f.receiver === null || f.receiverRoot === null) return cannotSay("receiver_unknown");
  const receiver = f.receiver;
  const receiverRoot = f.receiverRoot;

  // 2.
  if (eUsable) {
    const named = f.entityHwnd as bigint;
    const isNamed = same(receiver, named);
    if (isNamed || same(receiverRoot, named) || f.receiverAncestors.some((a) => same(a, named))) {
      if (f.receiverReadOnly === true) return refuse("read_only", isNamed ? "named" : "focused_inside_named");
      return { kind: "post", confirmed: true, referenceFrom };
    }
  }
  if (reference === null) return cannotSay("reference_unknown");

  // 3.
  if (!same(receiverRoot, reference)) {
    if (eUsable) return refuse("other_window", "named");
    return cannotSay(f.ownerChain.some((o) => same(o, reference)) ? "receiver_in_owned_window" : "receiver_in_other_window");
  }

  // 4.
  if (same(receiver, receiverRoot)) return cannotSay("receiver_is_window");

  // 5.
  if (eUsable && f.ancestorsComplete) return refuse("other_control", "named");

  // 6.
  if (!eUsable && f.receiverReadOnly === true) return refuse("read_only", "focused");

  // 7.
  if (f.entityHwnd === null) return cannotSay("entity_windowless");
  if (!eUsable) return cannotSay("entity_handle_stale");
  return cannotSay("parents_unread");
}

/**
 * `DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED`, read at call time. The user asked for room to change
 * course on later measurements, and this is it.
 *   - `1`, `all` or `true`: today's path exactly — no check, and a bare `"keyboard"`.
 *   - a comma-separated list of grounds: those grounds answer a marked success instead of a refusal.
 *   - anything else, unset included: the rule runs whole. A misspelt value keeps the check on.
 */
export interface KeyboardRungSwitch {
  unchecked: boolean;
  disabled: ReadonlySet<KeyboardGround>;
}

export function readKeyboardRungSwitch(env: NodeJS.ProcessEnv = process.env): KeyboardRungSwitch {
  const raw = (env.DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "all" || raw === "true") return { unchecked: true, disabled: new Set() };
  const disabled = new Set<KeyboardGround>();
  for (const part of raw.split(",")) {
    const ground = part.trim();
    if ((KEYBOARD_GROUNDS as readonly string[]).includes(ground)) disabled.add(ground as KeyboardGround);
  }
  return { unchecked: false, disabled };
}

/** A handle written as a decimal string (UIA's `nativeWindowHandle`), or null when it cannot be read. */
export function parseHandle(value: string | undefined): bigint | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const h = BigInt.asUintN(32, BigInt(value));
  return h === 0n ? null : h;
}

/**
 * The way back on a window this act addresses by handle, in one place because both grounds end here.
 *
 * A text field has no UIA invoke, so the click that would move the focus to it answers
 * `aim_route_failed` with nothing pressed — only the title road downgrades to a checked press (gate 2,
 * first read). And the by-title escape hatch closes for a common dialog: a title that resolves to one
 * is pinned to its handle, so re-discovering by title lands on this same road, which would send the
 * caller round in a circle (gate 2, third read). Saying there is no route is the honest end; adding a
 * focus route is a change to the rung's contract and the maintainer's to decide.
 */
const BY_HANDLE_WAY_BACK =
  "This act addresses its window by handle — a title that resolves to a common dialog (Save As, Open) is pinned to one too — " +
  "and a text field cannot be clicked through UI Automation, so that click answers aim_route_failed. Re-run desktop_discover " +
  "by the window's title and click the field from there; for a common dialog, which resolves to the same handle, nothing here " +
  "can move the focus to its text field yet.";

function callerSentence(ground: KeyboardGround, subject: RefusalSubject, road: KeyboardRoad): string {
  const byHandle = road === "handle";
  switch (ground) {
    case "other_window":
      return "Nothing was typed (other_window): the focus is in a different window from the field this act named, so the characters would have gone there. " +
        (byHandle
          ? `Bring the field's window forward (focus_window) and retry — it comes forward with the focus it last had. ${BY_HANDLE_WAY_BACK}`
          : "Click the field this act named, or bring its window forward (focus_window), and retry.");
    case "other_control":
      return "Nothing was typed (other_control): the focus is on a different control in the same window, so the characters would have gone there. " +
        (byHandle
          ? BY_HANDLE_WAY_BACK
          : "Click the field this act named (desktop_act action='click' on the same entity), then type again.");
    case "disabled":
      return (subject === "window"
        ? "Nothing was typed (disabled): UI Automation reported the field disabled, and the window it was read from does not take input now. "
        : "Nothing was typed (disabled): the field this act named does not take input now — it, or its window, is disabled. ") +
        "Answer or wait out whatever disabled it (a form being submitted, a dialog, a step not yet done), then re-run desktop_discover and type again. " +
        "desktop_discover does not list a disabled field, so until it is enabled it is missing there — missing then means still disabled, not gone.";
    case "read_only":
      return subject === "named"
        ? "Nothing was typed (read_only): the field this act named is read-only and does not take typed text."
        : subject === "focused_inside_named"
          ? "Nothing was typed (read_only): the control holding the focus, inside the one this act named, is read-only and does not take typed text."
          : "Nothing was typed (read_only): the control holding the focus is read-only and does not take typed text.";
  }
}

/**
 * The keyboard rung refused to post, on a ground the rule could state. Thrown by the executor before
 * any character is posted, and carried through the type ladder untouched: the ladder's catch would
 * otherwise flatten it into `aim_route_failed` or `executor_failed`, and the latter's advice is to
 * type through the foreground — into the very control this refused.
 *
 * The caller sees only `callerDetail`, which names the ground and never a window's text (item 13).
 */
export class KeyboardTargetUnsafeError extends Error implements CallerFacingRefusal {
  readonly ground: KeyboardGround;
  readonly callerDetail: string;
  constructor(ground: KeyboardGround, subject: RefusalSubject, road: KeyboardRoad, message: string) {
    super(message);
    this.name = "KeyboardTargetUnsafeError";
    this.ground = ground;
    this.callerDetail = callerSentence(ground, subject, road);
  }
}
