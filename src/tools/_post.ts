/**
 * _post.ts — Post-state narration helper + action history ring buffer.
 *
 * Phase 2.1 of anti-fukuwarai-ideals-plan.md.
 * Adds a small `post` block to action tool responses so the LLM can decide
 * its next move without taking a confirmation screenshot.
 *
 * Phase 3.1 extension: focusedElement is now populated from UIA
 * (getFocusedAndPointInfo) instead of being hard-coded to null.
 * A short timeout (800 ms) prevents this from blocking fast actions.
 *
 * Also maintains a ring buffer of recent action posts. `get_history` is the tool that reads it —
 * and it is registered on NO corner: asked with `tools/list` on the four real servers, all four
 * answered NOT REGISTERED (win2, 2026-09-14, `45ff635`; Phase 4 privatised it and
 * `desktop-state.ts` keeps the handler as an internal export). So the ring is written on every
 * action and readable by no caller — which is a reach, not a safety property: it is still in the
 * server's memory, and anything that later prints it publishes what was in it.
 */

import { enumWindowsInZOrder, getWindowProcessId, getProcessIdentityByPid } from "../engine/win32.js";
import { getFocusedAndPointInfo } from "../engine/uia-bridge.js";
import type { ToolResult } from "./_types.js";
import type { RichBlock } from "../engine/uia-diff.js";
import type { PerceptionEnvelope, PostPerception } from "../engine/perception/types.js";
import { appendEvent } from "../engine/perception/target-timeline.js";
import { maybeAdvisory } from "./_advisory.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PostElementInfo {
  name: string;
  type: string;
  /**
   * Whether UIA exposes a value on the focused element (it may be empty). By default this bit is
   * all the post carries — ADR-036, the user's decision of 2026-09-11 (option c). Named for the
   * pattern, not `hasValue`: `browser_form` already says `hasValue` for a field holding a non-empty
   * value, and here an empty one counts, so one name would have meant two things (gate 2 on #625;
   * the maintainer chose the name).
   *
   * Why the value was carried: so an agent could check in one short cycle, without taking another
   * screenshot, what it had typed and where — at a time when input often failed to reach the
   * focused field (the user's account, 2026-09-11).
   *
   * Why it is withheld now: the focused element is whatever holds keyboard focus when the tool
   * returns, not the tool's target. Measured on a real machine, tools that never touched a field
   * (`clipboard`, `notification_show`, a `mouse_click` landing in the same window) carried that
   * field's whole value, up to 4,096 characters, and `scroll` carried another window's; a field
   * masked only by CSS came back in plain text, and a Chrome password as one bullet per character.
   * The one console measured gave no value at all — its focused element was a button — so for
   * terminal input the value did not serve that purpose there (internal
   * `dev/post-focusedelement/RESULTS.md`).
   */
  hasValuePattern: boolean;
  /**
   * The value itself — only when the focused element is in the window THIS CALL NAMED
   * (`valueBelongsToTheWindowActedOn`). Option (b) of the 2026-09-11 material, taken on
   * 2026-09-13 after the predicate was measured to split the arms cleanly.
   *
   * What that buys, and what it does not. It closes the cross-tool exposure above: the four tools
   * measured carrying a field they never touched — `clipboard` read and write,
   * `notification_show`, and a coordinate `mouse_click` — name no window at all and resolve none
   * internally, so the value never attaches to them (win2, on `f2b7241`, with the old switch on so
   * the arms were observable). It keeps the reason the value existed: `keyboard(type, windowTitle)`
   * still confirms its own write in one cycle.
   *
   * It does NOT make a value safe to read. A field the caller DID act on still comes back in full
   * (up to the 4,096 UIA cap), CSS-masked fields in cleartext, and a Chrome password as one bullet
   * per character whose count is the secret's length. Naming the window narrows WHOSE field, not
   * WHAT is in it.
   */
  value?: string;
  automationId?: string;
}

export interface PostState {
  focusedWindow: string | null;
  /** UIA-derived focused element info. Null when UIA is unavailable or timed out. */
  focusedElement: PostElementInfo | null;
  windowChanged: boolean;
  elapsedMs: number;
  /** UIA diff block injected by withRichNarration. Stripped before history storage. */
  rich?: RichBlock;
  /** RPG perception envelope injected via _perceptionForPost. Stripped before history storage. */
  perception?: PostPerception;
}

export interface HistoryEntry {
  tool: string;
  argsDigest: string;
  ok: boolean;
  errorCode?: string;
  post: Omit<PostState, "rich" | "perception">;
  tsMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// History ring buffer
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_MAX = 20;
const history: HistoryEntry[] = [];

export function recordHistory(entry: HistoryEntry): void {
  history.push(entry);
  while (history.length > HISTORY_MAX) history.shift();
}

export function getHistorySnapshot(n = 5): HistoryEntry[] {
  return history.slice(-Math.max(1, Math.min(n, HISTORY_MAX)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Capture the current foreground window. Cheap (~1 EnumWindows call). */
function snapshotFocus(): {
  title: string | null; hwnd: string | null; processName: string;
  /** The identity `identity-tracker.ts` uses, kept so "same window" is answerable later. */
  processPid: number; processStartTimeMs: number;
} {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    if (!fg) return { title: null, hwnd: null, processName: "", processPid: 0, processStartTimeMs: 0 };
    const pid = getWindowProcessId(fg.hwnd);
    const ident = getProcessIdentityByPid(pid);
    return {
      title: fg.title, hwnd: String(fg.hwnd), processName: ident.processName,
      processPid: ident.pid ?? 0, processStartTimeMs: ident.processStartTimeMs ?? 0,
    };
  } catch {
    return { title: null, hwnd: null, processName: "", processPid: 0, processStartTimeMs: 0 };
  }
}

/**
 * Which arguments name a window FOR THIS TOOL. The same two keys `RichNarrationOptions` declares,
 * threaded down so the post layer reads the tool's own argument rather than a fixed pair of names.
 */
export interface PostWindowArgKeys {
  /** Arg holding the target window title — `title` for `focus_window` / `window_dock`. */
  windowTitleKey?: string;
  /** Arg holding the target window handle. */
  hwndKey?: string;
  /**
   * Args that decide the target INSTEAD of the window arguments, so the window arguments are not a
   * naming of anything. `terminal`'s `paneId` is the one today: the schema says it takes precedence,
   * and the handler branches on `paneId !== undefined` before it looks at `windowTitle` at all.
   */
  supersedingKeys?: string[];
  /**
   * Does a `fixId` on THIS call retarget the handler? Same question, same default and same source
   * as `RichNarrationOptions.fixRetargets` — the registration answers it, because which variants
   * adopt a fix is known there and nowhere else.
   */
  fixRetargets?: (args: Record<string, unknown>) => boolean;
}

/**
 * What a tool that declares nothing gets: the names most of the schemas use. Resolved HERE rather
 * than at the call site, so the fallback has one home and a caller can pass the options object it
 * already has, holes and all.
 */
const DEFAULT_WINDOW_TITLE_KEY = "windowTitle";
const DEFAULT_HWND_KEY = "hwnd";

/**
 * WHY the value is not in the post, when it is not — the four roads by which the predicate below
 * says no, named rather than left as an absence.
 *
 * An absence cannot be read. `value` can be missing for reasons that have nothing to do with this
 * rule: no element has focus, UIA did not answer, the field has no value at all. A caller that
 * addressed the wrong window sees the same nothing as a caller whose field is empty, and it will
 * read it as the commonest of those — which is exactly how `desktop_state`'s view road was
 * misread on the measuring side before `hints.focusedElementSource` separated them (2026-09-14).
 * So the withholding says its own name.
 *
 * WHERE IT IS PUBLISHED, and why not on the element: `hints`. The element is a projection of what
 * is focused; this is a statement about the server's decision, and the two do not belong in one
 * shape — the same separation PR #618 had to make between refusing and saying nothing about it.
 * `hints` is also the root-hoisted key that survives every response shape, and it is already where
 * "how this answer was produced" lives (`focusedElementSource`, `verifyDelivery.channel`), both of
 * which are the columns that caught a misreading on the measuring side this week.
 *
 * IT IS NOT AN ORACLE ABOUT THE CONTENT. Published whenever the focused element has a value
 * pattern at all — empty field included — so its presence never distinguishes an empty field from
 * a full one in a window the call did not name. `hasValuePattern` already says a value exists;
 * this must not add a bit saying whether it is worth having.
 */
export type PostValueWithheldReason =
  /** The call named no window: `clipboard`, `notification_show`, a coordinate `mouse_click`, `@active`. */
  | "call_named_no_window"
  /** A window was named and focus ended in a different one — including the modal-popup road. */
  | "not_the_window_you_named"
  /** A selector the handler prefers decided the target: `paneId`, `selector`/`target`, an adopted `fixId`. */
  | "target_came_from_elsewhere"
  /** The foreground changed identity while the element read was in flight. */
  | "foreground_moved_during_read"
  /**
   * The server could not tell WHERE focus was, so it withheld rather than guess: the foreground
   * enumeration answered nothing, or the process identity could not be read (an elevated window
   * answers that way to a server that is not). Distinct from the four above on purpose — each of
   * those asserts something about the caller's aim, and asserting one of them here would be a
   * confident wrong diagnosis, which is worse for a caller than an admitted one. The value is
   * withheld either way; only the sentence differs.
   */
  | "could_not_verify_the_window";

/** The predicate's answer: carry it, or do not and say which road said no. */
type PostValueVerdict = { carry: true } | { carry: false; why: PostValueWithheldReason };

/**
 * Did THIS call name the window the focus ended up in?
 *
 * The predicate option (b) rests on, and it was measured before it was written (win2, `f2b7241`,
 * with `DESKTOP_TOUCH_POST_FOCUSED_VALUE=1` so the arms were observable):
 *
 * | arm | tool | names a window | focus after | predicate |
 * |---|---|---|---|---|
 * | B | `clipboard(read)` / `clipboard(write)` | no | the untouched field's window | false |
 * | B | `notification_show` | no | same | false |
 * | B | `mouse_click(x,y)` | no | same | false |
 * | A | `keyboard(type, windowTitle)` | yes | that window | TRUE |
 *
 * The four leaking arms name no window and resolve none internally, so the predicate splits
 * exactly where the exposure is. `DESKTOP_TOUCH_POST_FOCUSED_VALUE` is gone with this: it existed
 * as the way back to carrying the value everywhere, and what it was a way back TO is the row set
 * above.
 *
 * The two ways the first form of this predicate then said "no window" about a call that HAD named
 * one were measured on the same machine before the fix (on `7480ce1`, internal
 * `dev/pr639-post-value-named-window` `e6074a3`): `hwnd:"0x20a4a"`, `hwnd:"  133706  "` and
 * `hwnd:"000133706"` each returned `ok:true` with the keystrokes delivered and no value, and so
 * did `focus_window({title})`. Each of those arms really did write — the arithmetic says so rather
 * than the `ok` flag: the fixture field's length counts the needles that arrived, and the three
 * handle spellings added theirs.
 *
 * A REFUSED CALL PUBLISHES NO VALUE — and that sentence had to be made true rather than written.
 * Two refusal shapes were measured, and they are not the same: `WindowNotFound` publishes no
 * `post` block at all, while `AutoGuardBlocked` publishes one with `focusedElement: null` (win2).
 * The measured fact is about the RESPONSE: an `AutoGuardBlocked` reply carries no focused element.
 * The snapshot below is taken before either branch runs, so the ring was recording, for a refused
 * call, exactly the field the refusal withheld — including for a handle `refuseIfExcludedTarget`
 * rejected, which is the key locker's window (gate 2 on `447698f`; the spelling fix widened which
 * arguments reach that path). The ring now follows the response. No caller could read it either
 * way — see the header: `get_history` is registered on no corner — so this closed a store, not a
 * leak. It was worth closing because the store is what a future reader would publish. What is still unconditional is
 * the UIA read itself: `getFocusedAndPointInfo` asks the FOREGROUND, whatever the call targeted,
 * and has no exclusion gate of its own — older than this change, filed, not closed here.
 *
 * CONSERVATIVE ON PURPOSE, in the direction where being wrong is cheap. Withholding costs a
 * read-back the caller can still get from `desktop_state`; attaching costs a field the caller never
 * asked about. So:
 *
 *   - THE ARGUMENT NAMES ARE THE ONES THE TOOL DECLARED, not the literal `windowTitle` / `hwnd`.
 *     `focus_window` calls its destination `title` (`window_dock` too), so reading only
 *     `windowTitle` withheld the value from the two tools whose whole purpose is to name a window
 *     — as explicit a naming as this codebase has, and the predicate could not see it (gate on
 *     `7480ce1`, 2026-09-13). The keys come from `RichNarrationOptions`, the table every other
 *     layer already reads them from; a second table here would be a second place to forget a tool.
 *     A tool that declares no key keeps the defaults, which is why `notification_show({title})` —
 *     whose `title` is a message heading and not a window — is still read as naming nothing.
 *   - THE HANDLE IS COMPARED AS A NUMBER, through the same `BigInt` that ACCEPTED it
 *     (`_resolve-window.ts` case 1). An exact string compare was the first form, and it withheld
 *     the value from calls that had named the window unambiguously: the schemas take `hwnd` as
 *     `z.string()` with no decimal rule, `BigInt` takes `"0x1092"`, `"004242"` and whitespace, and
 *     the foreground snapshot always writes decimal — so every spelling but one lost its own value
 *     (gate on `7480ce1`, 2026-09-13). Enumerating the spellings does not end; sharing the parser
 *     with the side that accepted the argument does, and it cannot widen WHICH window matches,
 *     only how that one window may be written. A handle neither side can parse names nothing.
 *   - `windowTitle` must be contained in the focused window's title, case-folded and nothing more,
 *     and it is the ARGUMENT that is compared — never a window the server chose on the caller's
 *     behalf. `resolveWindowTarget` PREFERS THE ACTIVE POPUP when the named window is blocked by
 *     its own modal, so `click_element(hwnd=<owner>)` with a dialog up acts on the DIALOG; the
 *     handle in the argument then matches nothing and the value is withheld. Deliberate, and the
 *     more careful side of a fork: the caller named the owner, and a modal that took focus is
 *     exactly the class of window — a credential prompt, a save dialog — whose field nobody asked
 *     for. The gate raised it on `447698f` and it is filed rather than changed — and then
 *     measured, with the two controls that make it mean something (win2, 2026-09-14, `b218767`):
 *     naming the owner while its dialog is up returns `ok:true` with `parent_disabled_prefer_popup`
 *     and no value; naming the DIALOG carries one; naming the owner after the dialog closes carries
 *     one. Either control alone leaves an alternative reading alive ("the popup road never
 *     carries", "this owner's handle never carries"); together they say only where focus landed
 *     decides.
 *   - Borrowing the guard's title matching is still refused, but NOT because it is looser: asked
 *     directly, with the fixture window open, `findPlainTopLevelWindowsByTitle` returned zero
 *     matches for a padded title and for dash variants, and agreed with this predicate on case —
 *     the two matchings are not known to differ on any axis measured (win2, 2026-09-14,
 *     `dev/pr639-post-value-named-window` `1258868`, after two rounds that read a `scroll` call
 *     with `ok:true` as evidence of the opposite; `hints.verifyDelivery.channel` said
 *     `wheel_send_input`, i.e. no window had been resolved at all). The reason to keep a rule of
 *     its own is that the guard's exists to DECIDE a target and may be loosened for that job —
 *     and a predicate that borrows it would loosen with it, silently.
 *   - `"@active"` counts as naming NOTHING. It means "whatever is in front", which is the same
 *     thing every leaking arm above was pointed at by accident. A caller who really wants the
 *     value of the foreground field can ask `desktop_state` for it — SOMETIMES. It answers while
 *     naming no window, so this is a change in WHO HAS TO ASK for a field rather than a reduction
 *     in what can be read; `desktop_state`'s own caveat is where that is written down. But it
 *     answers only from the UIA road: `desktop_state` prefers the perception view's focus, and
 *     `buildElementInfoFromView` has no `value` field at all, so once this server's own writing has
 *     filled that window's view the read-back returns the element WITH NO VALUE — which a caller
 *     cannot tell from an empty field. Measured 24/24 with a value on the UIA road and 0/8 without
 *     on the view road, the element's name identical in all four conditions and
 *     `hints.focusedElementSource` the only column that moved (win2, 2026-09-14, `a4802dd`). So
 *     the recommendation above is at its weakest exactly where it is most wanted: immediately
 *     after a write.
 *     The field's IDENTITY is not narrowed here either: `name`, `automationId`, `type` and
 *     `hasValuePattern` still come back for a window this call never named. Three of those four
 *     are what the success-path advisory (ADR-022) decides from — `buildHint` reads `type`,
 *     `hasValuePattern` and `automationId`, and never `name`, so `name` travels for the caller's
 *     benefit alone (gate 2 on `447698f`, correcting this sentence's first form).
 */
function valueBelongsToTheWindowActedOn(
  args: Record<string, unknown>,
  after: { title: string | null; hwnd: string | null },
  keys: PostWindowArgKeys,
): PostValueVerdict {
  // A SELECTOR THE HANDLER PREFERS MEANS THE WINDOW ARGUMENTS NAMED NOTHING. `terminal(action:
  // 'send', paneId, windowTitle)` never reads that title — and a background send does not move the
  // foreground, so a stale title that happens to match whatever is in front would have attached
  // that untouched window's field. Same for a `fixId` that retargets: the handler acts on the
  // stored fix's window and these arguments describe the call the caller wrote, not the one that
  // ran. Withholding is the recoverable direction; the rich path answers this identically.
  if (keys.supersedingKeys?.some((k) => args[k] !== undefined && args[k] !== "")) {
    return { carry: false, why: "target_came_from_elsewhere" };
  }
  if (args["fixId"] && (keys.fixRetargets ?? (() => true))(args)) {
    return { carry: false, why: "target_came_from_elsewhere" };
  }
  const hwnd = args[keys.hwndKey ?? DEFAULT_HWND_KEY];
  if (typeof hwnd === "string" && hwnd !== "") {
    // A FOREGROUND THAT COULD NOT BE READ IS NOT A MISMATCH. `snapshotFocus` answers all-null when
    // the enumeration throws, and UIA can still produce an element through its own road — so the
    // comparison below has nothing to compare, and saying `not_the_window_you_named` would tell
    // the caller their aim was wrong when the server simply could not look (gate on `968f9cb`).
    if (after.hwnd === null) return { carry: false, why: "could_not_verify_the_window" };
    return isTheSameHandle(hwnd, after.hwnd)
      ? { carry: true }
      : { carry: false, why: "not_the_window_you_named" };
  }
  const title = args[keys.windowTitleKey ?? DEFAULT_WINDOW_TITLE_KEY];
  if (typeof title !== "string" || title === "" || title === "@active") {
    return { carry: false, why: "call_named_no_window" };
  }
  if (after.title === null) return { carry: false, why: "could_not_verify_the_window" };
  return after.title.toLowerCase().includes(title.toLowerCase())
    ? { carry: true }
    : { carry: false, why: "not_the_window_you_named" };
}

/**
 * One handle, however it was spelled. `BigInt` is the parser `resolveWindowTarget` uses to accept
 * the argument, so the two sides cannot disagree about what a handle IS; anything it refuses is
 * not a name and gets no value.
 */
function isTheSameHandle(arg: string, afterHwnd: string | null): boolean {
  if (afterHwnd === null) return false;
  try {
    return BigInt(arg) === BigInt(afterHwnd);
  } catch {
    return false;
  }
}

/**
 * Best-effort: call getFocusedAndPointInfo with a tight timeout.
 * Returns null on timeout or error — never throws.
 */
async function snapshotFocusedElement(carryValue: boolean): Promise<PostElementInfo | null> {
  try {
    // #352 follow-up (ADR-022 §5.5): pass includeUnnamed=true so an UNNAMED UIA
    // text input (Edit/Document with ValuePattern but an empty Name) survives the
    // bridge's name-empty guard and can reach the success-path advisory gate. This
    // opt-in is scoped to the post/advisory path only — `desktop_state` /
    // `_mouse-verify` / perception do NOT pass the flag, so they stay byte-equal.
    const { focused } = await getFocusedAndPointInfo(0, 0, false, 800, true);
    // Drop only when there is no focused element at all (the bridge already dropped
    // degenerate no-name-no-controlType rows under includeUnnamed). A name-empty
    // editable element flows through with name:"" so the #352 advisory can fire.
    if (!focused) return null;
    // Whether there is a value, and by default not what it is (see `PostElementInfo.hasValuePattern`). The
    // history ring stores this same object, so it holds a value only under the switch as well.
    const info: PostElementInfo = { name: focused.name, type: focused.controlType, hasValuePattern: focused.value != null };
    if (focused.automationId) info.automationId = focused.automationId;
    if (carryValue && focused.value != null) info.value = focused.value;
    return info;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// withPostState
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an action handler so its response is augmented with a `post` block.
 * Records a history entry as a side effect.
 *
 * windowChanged compares the foreground BEFORE the handler ran with AFTER —
 * so it reflects whether the action itself moved focus, not background drift.
 *
 * ── Field-level writer ownership (ADR-021 PR-P2-1, OQ-2(a)) ──────────────────
 * Pinned in `tests/unit/path-class-contract/post-writer-ownership.test.ts` so the
 * PR-P2-3 `failWith` → presenter codemod cannot silently sever post-perception
 * recovery (§5 R1).
 *
 *   - `obj.post` (container) + `obj.post.{focusedWindow, focusedElement,
 *      windowChanged, elapsedMs}`        → withPostState ONLY (built from this
 *        wrapper's before/after focus snapshot; a handler or failure presenter
 *        has no such snapshot, so it structurally cannot write these).
 *   - `obj.post.perception`              → withPostState ONLY (moved from the
 *        root `_perceptionForPost` marker, then the marker is `delete`d — on
 *        BOTH the success and failure branches).
 *   - `obj.advisory` (root, success ONLY) → withPostState ONLY (ADR-022 / #352).
 *        Built by `maybeAdvisory(toolName, args, post.focusedElement)` from the
 *        already-captured focused-element snapshot (no handler input, no marker,
 *        no UIA call). Absent when no better path applies; never written on the
 *        failure branch.
 *   - `obj.post.rich`                    → COORDINATED two writers, NOT
 *        single-writer: withPostState moves it from the root `_richForPost`
 *        marker (browser CDP, success path, takes precedence); `spliceRich`
 *        (`_narration.ts`, via `withRichNarration` which wraps THIS fn) fills it
 *        from the UIA diff, but only on success AND only when `post.rich` is
 *        still unset (its `post.rich !== undefined` no-overwrite guard). So
 *        `_richForPost` wins and the UIA diff is the fallback.
 *   - root temp markers (all hoisted to the response ROOT via ROOT_HOISTED_KEYS,
 *     NEVER under `context` — that root placement is the load-bearing contract
 *     this wrapper depends on; a codemod that nested a marker under `context`
 *     would silently drop post.perception):
 *        · `_perceptionForPost` — written by the HANDLER (success) or
 *          `toToolFailure` / `failWith` (failure). Consumed + `delete`d on BOTH
 *          branches → a second move is impossible.
 *        · `_richForPost` — written by browser handlers (success only today).
 *          Consumed + `delete`d on the SUCCESS branch ONLY, and only when it has
 *          an array `appeared` field (the RichBlock shape guard); the failure
 *          branch leaves it untouched (latent, currently unreachable — browser
 *          handlers attach the array-shaped block on `ok:true` alone).
 *        · `hints` (the third ROOT_HOISTED_KEY) — hoisted to root by the failure
 *          producers but intentionally NOT consumed/moved here; it stays at the
 *          response root on both branches (issue #181 success/failure symmetry).
 */
export function withPostState<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<ToolResult>,
  windowArgKeys: PostWindowArgKeys = {}
): (args: T) => Promise<ToolResult> {
  return async (args: T) => {
    const startedAt = Date.now();
    const before = snapshotFocus();
    const result = await handler(args);
    try {
      const after = snapshotFocus();
      const verdict = valueBelongsToTheWindowActedOn(args as Record<string, unknown>, after, windowArgKeys);
      const focusedElement = await snapshotFocusedElement(verdict.carry);
      /** Set when a value was withheld from an element that HAD one. Published in `hints`. */
      let valueWithheld: PostValueWithheldReason | undefined =
        verdict.carry ? undefined : verdict.why;
      // THE PERMISSION AND THE ELEMENT ARE READ AT DIFFERENT MOMENTS, and between them is an
      // asynchronous UIA call with its own 800 ms budget. `carryValue` was decided against the
      // foreground at `after`; the element comes from whatever holds focus when UIA answers. If
      // the user alt-tabbed, or the app raised a dialog, that is a DIFFERENT window — and the
      // value the caller was authorised to see for the window they named would be published from
      // the window that took focus instead. Re-read the foreground and drop the value if it
      // moved; withholding is the recoverable direction, and the read costs one enumeration only
      // on the calls that were going to carry a value anyway (gate on `a2a9376`, P1).
      //
      // `post.focusedWindow` keeps its `after` reading rather than being re-derived here: it is
      // the foreground the action left behind, which is the question it answers. The element and
      // the window CAN disagree in that window of time — they could before this change too, for
      // every call, value or no value — and binding them properly needs the owning HWND, which
      // `NativeUiaFocusInfo` does not carry. Filed rather than faked.
      if (verdict.carry && focusedElement && focusedElement.value !== undefined) {
        const settled = snapshotFocus();
        // IDENTITY, NOT THE NUMBER — and identity is the PAIR, not the name. A handle is
        // recyclable: the named window can exit during the lookup and Windows can hand its number
        // to whatever takes focus next, so `settled.hwnd === after.hwnd` alone is true about a
        // different window (gate on `93e39ef`). Comparing the process NAME does not close it
        // either: a second instance of the same executable — the second Notepad — answers the same
        // name, and a user with two of anything open is not a corner case (gate on `6f33565`).
        // `getProcessIdentityByPid` already returns what `identity-tracker.ts` compares, pid and
        // process start time, and `snapshotFocus` was throwing both away. An unreadable identity
        // (start time 0, which is also what the failure path returns) withholds.
        // AND THE SAME DISTINCTION ON THE WAY OUT. An identity that could not be READ is not an
        // identity that CHANGED: `getProcessIdentityByPid` answers `processStartTimeMs: 0` for a
        // protected process and for a transient failure, and reporting movement there is a
        // confident wrong diagnosis of something that did not happen (gate on `968f9cb`). The
        // value is withheld in both cases — only the sentence differs.
        const unreadable = settled.hwnd === null ||
          settled.processStartTimeMs === 0 || after.processStartTimeMs === 0;
        const sameWindow = !unreadable && settled.hwnd === after.hwnd &&
          settled.processPid === after.processPid &&
          settled.processStartTimeMs === after.processStartTimeMs;
        if (!sameWindow) {
          delete focusedElement.value;
          valueWithheld = unreadable ? "could_not_verify_the_window" : "foreground_moved_during_read";
        }
      }
      // NOTHING WAS WITHHELD IF THERE WAS NOTHING TO GIVE. A field with no value pattern has no
      // value for any caller, named or not, and a reason attached there would read as "a value was
      // kept from you" (win2, measured on the CDP round: a paragraph carrying only a `tabindex`
      // answers exactly like a masked field does). The element being absent altogether — every
      // refusal road — is likewise not a withholding: `ok:false` is the answer to that question.
      //
      // Published for an EMPTY field as well as a full one. The reason answers the rule, not the
      // contents; suppressing it for `value:""` would make its presence mean "the field you cannot
      // see is not empty", which is a bit about a window the caller never named and one that
      // `hasValuePattern` does not already give.
      if (!focusedElement?.hasValuePattern) valueWithheld = undefined;
      const windowChanged = !!after.hwnd && !!before.hwnd && after.hwnd !== before.hwnd;
      const post: PostState = {
        focusedWindow: after.title,
        focusedElement,
        windowChanged,
        elapsedMs: Date.now() - startedAt,
      };

      // Splice post into the JSON text block of the result — but ONLY for success
      // shapes. Failures keep their { ok:false, code, suggest } shape pristine.
      let okFlag = true;
      let errorCode: string | undefined;
      const block = result.content[0];
      if (block && block.type === "text") {
        let parsed: unknown;
        try { parsed = JSON.parse(block.text); } catch { /* not JSON, skip */ }
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          if (obj.ok === false) {
            okFlag = false;
            errorCode = typeof obj.code === "string" ? obj.code : undefined;
            // Attach post.perception on failure if handler set _perceptionForPost.
            // This lets LLMs recover from guard blocks using post.perception.next.
            if (obj._perceptionForPost !== null && typeof obj._perceptionForPost === "object") {
              const failurePost: PostState = {
                focusedWindow: after.title,
                focusedElement: null,
                windowChanged: !!after.hwnd && !!before.hwnd && after.hwnd !== before.hwnd,
                elapsedMs: Date.now() - startedAt,
                perception: obj._perceptionForPost as PostPerception,
              };
              obj.post = failurePost;
              delete obj._perceptionForPost;
              block.text = JSON.stringify(obj, null, 2);
            }
          } else {
            obj.post = post;
            // The withholding says its own name, in `hints` — MERGED, never assigned: `hints` is a
            // root-hoisted key the handler may already have written, and this wrapper owns exactly
            // one field of it.
            //
            // SUCCESS ONLY. A failure publishes no focused element at all, so "why is the value
            // missing" is answered by `ok:false` and not by this rule; writing a reason there
            // would name a withholding that did not happen.
            if (valueWithheld) {
              const existing = obj.hints;
              obj.hints = {
                ...(existing !== null && typeof existing === "object" ? existing as Record<string, unknown> : {}),
                postValueWithheld: valueWithheld,
              };
            }
            // ADR-022 / issue #352: success-path advisory. Reuses the
            // focused-element snapshot already taken above (post.focusedElement) —
            // zero extra UIA cost. `_advisory.ts` owns the per-tool logic; this
            // wrapper stays generic. Additive root field `advisory` (sibling of
            // `hints`); absent when no better path applies.
            const advisory = maybeAdvisory(toolName, args as Record<string, unknown>, post.focusedElement, after.processName);
            if (advisory) obj.advisory = advisory;
            // If the handler injected a CDP-sourced rich block via _richForPost,
            // move it into post.rich and remove the temporary key.
            // Convention: browser handlers set result._richForPost = RichBlock before returning.
            if (
              obj._richForPost !== null &&
              typeof obj._richForPost === "object" &&
              Array.isArray((obj._richForPost as Record<string, unknown>).appeared)
            ) {
              post.rich = obj._richForPost as RichBlock;
              delete obj._richForPost;
            }
            // RPG perception envelope — handlers set _perceptionForPost on success.
            if (obj._perceptionForPost !== null && typeof obj._perceptionForPost === "object") {
              post.perception = obj._perceptionForPost as PerceptionEnvelope;
              delete obj._perceptionForPost;

              // D-4: Emit action_succeeded and optionally foreground_changed timeline events
              const percAny = post.perception as unknown as Record<string, unknown>;
              const targetStr = typeof percAny.target === "string" ? percAny.target : null;
              if (targetStr) {
                appendEvent({ targetKey: targetStr, identity: null, source: "post_check", semantic: "action_succeeded", tool: toolName, result: "ok", summary: `${toolName} succeeded` });
              }
            }
            // D-4: foreground_changed when window focus moved between actions
            if (windowChanged && before.hwnd && after.hwnd) {
              // Use the after-window title as the target key approximation
              const afterKey = after.title ? `window:${after.title.toLowerCase().trim()}` : null;
              if (afterKey) {
                appendEvent({ targetKey: afterKey, identity: null, source: "post_check", semantic: "foreground_changed", tool: toolName, summary: `Focus moved to ${after.title}` });
              }
            }
            block.text = JSON.stringify(obj, null, 2);
          }
        }
      }

      // Strip rich and perception blocks from history to avoid bloating the ring buffer — and the
      // focused element on a refusal, because the response does not publish one (the failure
      // branch above writes `focusedElement: null`, and a failure with no perception marker
      // publishes no `post` at all). Keeping it here meant a refused call still stored the field
      // the refusal was withholding.
      const { rich: _rich, perception: _perception, ...postFields } = post;
      const postForHistory = okFlag ? postFields : { ...postFields, focusedElement: null };
      recordHistory({
        tool: toolName,
        argsDigest: digest(args),
        ok: okFlag,
        ...(errorCode ? { errorCode } : {}),
        post: postForHistory,
        tsMs: Date.now(),
      });
    } catch {
      // Don't let post-narration failure leak.
    }
    return result;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function digest(args: Record<string, unknown>): string {
  try {
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string" && v.length > 60) trimmed[k] = v.slice(0, 60) + "…";
      else if (v !== null && typeof v === "object") trimmed[k] = "<object>";
      else trimmed[k] = v;
    }
    return JSON.stringify(trimmed);
  } catch {
    return "<args>";
  }
}
