/**
 * The one source the `landing {confirmed:false}` paragraph is written in.
 *
 * It ships twice — in `desktop_act`'s description and at the end of the server
 * instructions' `keyboard_target_unsafe` entry — and until now it was kept by hand in
 * both. Measured at `71d5a52` before this file existed, the two copies were 1,019 and
 * 1,008 characters with a 967-character identical run and **five** differences, all of
 * them in the opening clause and the final mark:
 *
 *   `A type/setValue` / `A type` · `ok=true` / `ok:true` · `'landing'` / `landing` ·
 *   a full stop / a semicolon
 *
 * So one template with two parameters reproduces both exactly, and the fixtures that pin
 * what `tools/list` serves do not move by a byte — which is the proof this refactor owes
 * and the reason it is worth doing: a claim that reached the caller twice could disagree
 * with itself, and did. The hint clause was hedged in the READMEs and unhedged in both of
 * these for a round, and a round before that only one of them said what a retry does.
 *
 * WHAT IS NOT GENERATED FROM HERE, measured at the same time: `README.md` shares 76% of
 * this text and `README.ja.md` shares 18%. The first is a shorter paraphrase written for a
 * reader rather than for a model; the second is a translation. Neither is a rendering of
 * this string, so neither is produced from it — they stay hand-written, and the cell in
 * `tests/unit/adr-036-desktop-state-value-absent.test.ts` pins THOSE TWO as fixed text, which
 * is what notices when a hand-written one drifts from this one. The two shipped copies are
 * pinned in the cell below it instead, against this generator and against a fixture — and the
 * assertion that actually protects "one source" is that the paragraph occurs in exactly one
 * file under `src/`, because a byte-identical copy inlined at a call site serves the same
 * `tools/list` string and no runtime comparison can tell (gate 2, 2026-09-15).
 */

/** How the sentence opens, which is the only part the two callers disagree about. */
export interface LandingAdviceVoice {
  /** `A type/setValue` in the tool description; `A type` in the v1 instructions. */
  readonly subject: string;
  /** `ok=true` where the description spells it that way, `ok:true` in the instructions. */
  readonly okSpelling: string;
  /** The instructions write `landing` bare; the description quotes it. */
  readonly landingQuote: string;
  /** A full stop ends a description; a semicolon continues the instructions' entry. */
  readonly terminator: string;
}

/**
 * The paragraph, in one voice or the other.
 *
 * It is a REPORT. It carries no imperative, because on this road the server has nothing to
 * offer: nothing in the response establishes whether the characters arrived, reading the
 * field back does not settle it, `diff.value_changed` has its baseline at the
 * `desktop_discover` snapshot rather than at the write, and retrying a nonempty write is
 * not a repeat. Fourteen rounds removed a claim each; the reasons live in
 * `src/tools/desktop-register.ts` beside the call, where they cost no tokens.
 */
export function landingAdvice(voice: LandingAdviceVoice): string {
  return (
    `${voice.subject} that answers ${voice.okSpelling} with ${voice.landingQuote}landing${voice.landingQuote} ` +
    "{confirmed:false, why} took the background write route but was not confirmed to have reached the field " +
    "named. THIS LANDING IS A REPORT, not a state that can be resolved here: nothing on this response " +
    "establishes whether the characters arrived; reading the field back does not settle it (`desktop_state` " +
    "answers about the FOREGROUND, from a sticky focus row that can name a field in another window with the " +
    "same title, and it may carry no value at all — `hints.focusedElementValueAbsent` names the road that " +
    "dropped it, `view_road_has_no_value` or `masked_on_this_road`, and NO hint is not evidence that a value " +
    "was there: on the UIA road a provider that serves none leaves an absent value with no hint); " +
    "`diff.value_changed` is not delivery either, its baseline being your `desktop_discover` snapshot rather " +
    "than the write; and retrying a nonempty write is not a repeat, because a background write lands at the " +
    `caret and replaces the selection exactly as typing does${voice.terminator}`
  );
}

/** The voice `desktop_act`'s description is written in. */
export const LANDING_ADVICE_TOOL_DESCRIPTION: LandingAdviceVoice = {
  subject: "A type/setValue",
  okSpelling: "ok=true",
  landingQuote: "'",
  terminator: ".",
};

/** The voice the v1 server instructions are written in. */
export const LANDING_ADVICE_SERVER_INSTRUCTIONS: LandingAdviceVoice = {
  subject: "A type",
  okSpelling: "ok:true",
  landingQuote: "",
  terminator: ";",
};
