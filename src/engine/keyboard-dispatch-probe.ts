/**
 * ADR-036 family 2, arm A — the `keyboard` tool says who received the characters.
 *
 * **Observation only.** Nothing here refuses, nothing here changes what is sent, and every row is
 * written only while `DESKTOP_TOUCH_AIM_PROBE=1`. The native reads cost a handful of calls per
 * dispatch, so they happen inside that gate and nowhere else.
 *
 * ## Why this road needed a row at all
 *
 * Measured on 2026-09-16 (win2, seven arms, then two more): a `keyboard` write into a window whose
 * thread has its focus in ANOTHER top-level window answers `ok:true`, and the record —
 * `logDispatchSink`, written BEFORE the send with `targetHwnd` = the window that was AIMED at — is
 * byte-identical to the record of a write that landed correctly. A plain sibling and an OWNED window
 * produce the same row as each other too. The characters' actual destination was never written down,
 * although `postCharsToHwnd` has returned it all along (`bg-input.ts`, `PostCharsResult.target`,
 * whose own docstring says "a caller that records where a keystroke went reads it here"). The
 * `desktop_act` rung has read it since #630. This road dropped it.
 *
 * ## What the rule says here, which is the point of the row
 *
 * `judgeKeyboardTarget` (`keyboard-target.ts`) is the family-2 rule, and it wants E — the named
 * CONTROL's own window. **This road never has one: the `keyboard` tool names a WINDOW.** So step 2
 * (the named control, or something inside it) can never match, step 3 refuses `other_window` only
 * "when E is usable" and therefore answers *cannot say* for exactly the case measured above, and
 * step 6 (`read_only`) is the only refusal it can reach. **The verdict is recorded and NOT acted
 * on**, so that "how often does the rule say it cannot say on this road" is a count taken before
 * anyone proposes refusing on it.
 *
 * ## Where this seam is NOT written, and what that means
 *
 * **No row at all means no dispatch happened** — not that a dispatch said nothing. A call refused
 * before it sends (`DestinationRequired` when no window was named, `AutoGuardBlocked` when the title
 * matched two) never reaches a rung, and the two refusals are the product's own record. Said here
 * because this seam's whole subject is recording absence instead of leaving it to be inferred, and a
 * reader counting rows would otherwise read a missing row as a silent rung.
 *
 * **And `desktop_act`'s keyboard rung does not write this seam.** It records the same fact — the
 * receiver — on its `act.route` row, in a richer shape: that road has an entity, so it carries the
 * whole of `KeyboardFacts` and the rule ACTS on the verdict there. The two roads share the reader and
 * the rule (`receiver-facts.ts`, `keyboard-target.ts`) and not the row, which means an analysis that
 * wants both has to read two shapes. Filed rather than unified here (`internal#116`): this PR is the
 * tool road, and changing `act.route`'s shape would move a row three measurement records point at.
 *
 * ## What a row does not tell you
 *
 * **Whether the characters ARRIVED.** `postCharsToHwnd` POSTS, so delivery depends on the target
 * thread's pump, and the same round saw three outcomes behind one `ok:true`: delivered promptly,
 * delivered about forty seconds after the call returned, and never delivered at all. `ok` on this
 * road is about the posting. Establishing arrival needs a read-back this product does not have
 * (spec gap ④), and this row must not be read as if it did.
 */

import { probeAim, aimProbeEnabled } from "./aim-probe.js";
import { readReceiverFacts, readOwnerChain, editReadOnlyOf, hwnd32, sameHwnd } from "./receiver-facts.js";
import { judgeKeyboardTarget, readKeyboardRungSwitch, type KeyboardFacts, type KeyboardVerdict } from "./keyboard-target.js";
import { getWindowRoot } from "./win32.js";

/** Which rung of the tool sent, named the way `logDispatchSink` names them. */
export type KeyboardRung =
  | "wm_char"
  | "clipboard_paste"
  | "foreground_flash"
  | "sendinput"
  | "rawkeyboard";

/**
 * Why a row carries no receiver. Two different absences, kept apart on purpose — this ADR's rule is
 * that absence is recorded rather than inferred, and "nobody asked" is not "nobody answered".
 */
export type NoReceiverWhy =
  /** The rung goes through the foreground: it posts to no handle, so there is no subject to name. */
  | "rung_has_no_receiver"
  /** The rung posts, but the primitive it uses returns a boolean and drops the handle it resolved. */
  | "primitive_does_not_report"
  /** The rung posts and reports, but the post could not say which handle it reached. */
  | "post_did_not_say";

export interface KeyboardDispatchRow {
  /** `keyboard:type` | `keyboard:press` | `keyboard:sequence`, as the sink log spells it. */
  tool: string;
  rung: KeyboardRung;
  /**
   * The window the tool resolved and addressed. **Null on the rungs that address none**: SendInput
   * and rawkeyboard are routed by the FOCUS, not to a handle, which is why `logDispatchSink` has
   * written `targetHwnd: null` for them since before this row existed.
   */
  windowHwnd: bigint | null;
  /** True when the caller named that window by handle rather than by title. */
  byHandle: boolean;
  /** The handle the characters actually went to, when the rung can say. */
  receiver: bigint | null;
  /** Why not, when it cannot. */
  noReceiverWhy?: NoReceiverWhy;
  payloadChars?: number;
}

/**
 * A handle as this record writes it: the shared 32-bit form (`receiver-facts.ts`), so that the
 * printed handles and the flags computed beside them use ONE rule, and so that a row here and a row
 * on `act.route` name the same window with the same string (gate 2, 2026-09-16).
 */
const dec = (h: bigint | null | undefined): string | null =>
  h === null || h === undefined ? null : hwnd32(h);

/**
 * Write one row. Never throws: a probe that can break the write it is watching is not an instrument.
 */
export async function probeKeyboardDispatch(row: KeyboardDispatchRow): Promise<void> {
  if (!aimProbeEnabled()) return;
  try {
    const base = {
      tool: row.tool,
      rung: row.rung,
      windowHwnd: dec(row.windowHwnd),
      byHandle: row.byHandle,
      ...(row.payloadChars !== undefined && { payloadChars: row.payloadChars }),
    };

    if (row.receiver === null) {
      // The absence, with its reason. `receiverKnown:false` is a fact about the RUNG, not about the
      // window — a reader who sees it must not conclude that nothing received the characters.
      probeAim("keyboard.dispatch", {
        ...base,
        receiverKnown: false,
        why: row.noReceiverWhy ?? "post_did_not_say",
      });
      return;
    }

    const facts = await readReceiverFacts(row.receiver);
    const lookupRoot = row.windowHwnd === null ? null : getWindowRoot(row.windowHwnd);
    // E is null and stays null: this road names a window, never a control. `aimRoot` is filled only
    // when the CALLER gave a handle, which is the same handle/title split the value road records —
    // the rule treats its own lookup as the last resort because a title takes the first window whose
    // caption contains the string.
    const ruleFacts: KeyboardFacts = {
      entityHwnd: null,
      entityRoot: null,
      originRoot: null,
      aimRoot: row.byHandle ? lookupRoot : null,
      lookupRoot,
      receiver: row.receiver,
      receiverRoot: facts.receiverRootHwnd,
      receiverAncestors: facts.receiverAncestors ?? [],
      ancestorsComplete: facts.ancestorsComplete,
      receiverReadOnly: editReadOnlyOf(facts.receiverClass, facts.receiverStyle),
      ownerChain: readOwnerChain(facts.receiverRootHwnd),
    };
    // THE SAME SWITCH THE ACTING ROAD HONOURS. `desktop_act`'s rung passes the disabled grounds to
    // the rule, and a round that turns one off (`DESKTOP_TOUCH_KEYBOARD_RUNG_UNCHECKED=read_only`)
    // would otherwise get one verdict on `act.route` and a different one here for identical facts —
    // on a row whose whole point is that the two roads can be compared (gate 2, 2026-09-16). The
    // state is written beside the verdict, so a reader knows which rule produced it.
    const rungSwitch = readKeyboardRungSwitch();
    const verdict: KeyboardVerdict = judgeKeyboardTarget(ruleFacts, rungSwitch.disabled);

    probeAim("keyboard.dispatch", {
      ...base,
      receiverKnown: true,
      receiver: {
        hwnd: hwnd32(row.receiver),
        rootHwnd: dec(facts.receiverRootHwnd),
        // The two are kept APART although one implies the other today: `isWindowItself` covers both
        // "the thread had no focus" and "the question could not be asked" (the rule's step 4 says so),
        // and the arm that would have merged "fell back and nothing happened" with "fell back and the
        // window took the text" COULD NOT BE BUILT — a posted WM_CHAR never reaches a top-level EDIT
        // on this machine, while a sent one does (win2, 2026-09-16, with the control run from outside
        // the server). So the row is built not to merge them.
        isWindowItself: facts.receiverRootHwnd !== null && sameHwnd(row.receiver, facts.receiverRootHwnd),
        className: facts.receiverClass,
        readOnly: ruleFacts.receiverReadOnly,
        inNamedWindow: lookupRoot !== null && facts.receiverRootHwnd !== null
          && sameHwnd(facts.receiverRootHwnd, lookupRoot),
        ancestorCount: facts.receiverAncestors?.length ?? null,
        ancestorsComplete: facts.ancestorsComplete,
        // The relation the receiver's own handle cannot carry: measured 2026-09-16, the receiver of
        // an owned window is that window's CHILD EDIT, one level deeper than the ownership.
        ownerChainLength: ruleFacts.ownerChain.length,
        ownerIsNamedWindow: lookupRoot !== null
          && ruleFacts.ownerChain.some((o) => sameHwnd(o, lookupRoot)),
      },
      // Recorded, not acted on.
      switchDisabled: [...rungSwitch.disabled],
      switchUnchecked: rungSwitch.unchecked,
      wouldJudge: verdict.kind === "refuse"
        ? { kind: "refuse", ground: verdict.ground, subject: verdict.subject, referenceFrom: verdict.referenceFrom }
        : { kind: "post", confirmed: verdict.confirmed, referenceFrom: verdict.referenceFrom,
            ...(verdict.confirmed === false && { why: verdict.why }) },
    });
  } catch {
    // Same contract as every other probe here: never throw into the path being measured.
  }
}

