/**
 * internal #121 — the one response a caller cannot interpret must not also be the one that offers
 * no next step.
 *
 * `Unknown` is what `makeCommitWrapper` answers when a HANDLER THREW (site 6). Twenty-one tools sit
 * behind that wrapper and every one of them is a COMMIT tool — desktop, browser, terminal,
 * clipboard, excel — so a throw there can leave the world changed. What shipped was
 * `{"ok":false,"reason":"unknown","if_unexpected":{"most_likely_cause":"Unknown","try_next":[]}}`.
 *
 * THE EMPTY LIST WAS NOT A DEFECT NOBODY NOTICED. ADR-021's migration plan put it there on purpose
 * to keep the converter swap bit-equal, and named the follow-up in the same line (hazard B:
 * "handler crash に generic hint を付ける改善は deliberate な follow-up に分離"). This is that
 * follow-up, so these cells are written against the two ways it can be undone rather than against
 * the diff that did it.
 *
 * ── WHAT EACH CELL HERE IS AIMED AT ──────────────────────────────────────────────────────────
 * The frozen shape lives in `path-class-contract/to-failure-envelope-shape-snapshot.test.ts`; a
 * literal freeze catches a wording change but says nothing about WHY the wording is that way.
 * These cells hold the reasons, each against a mutation that a green freeze would not see:
 *
 *   1. re-adding the `tryNext: []` override at the callsite  → "a caller is given somewhere to go"
 *   2. deleting the `SUGGESTS.Unknown` entry                  → the converter's generic line ships,
 *                                                               which invites exactly the retry
 *                                                               this road must not invite
 *   3. merging the placeholder-free lines into a `{tool:}` one → they vanish at a corner, silently
 *   4. pointing every caller at the UIA tree                   → a browser caller is sent to an
 *                                                               instrument that cannot see its node
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeCommitWrapper, type CommitL1Emitter } from "../../src/tools/_envelope.js";
import { failWith, getSuggestsForCode, UNKNOWN_UNCONDITIONAL_CLAIMS } from "../../src/tools/_errors.js";
import {
  renderAdviceWith,
  captureAdviceConfiguration,
  resetAdviceConfiguration,
  ADVICE_WITHHELD_FLOOR,
  type AdviceConfiguration,
} from "../../src/tools/_advice-capability.js";

const NOOP_L1: CommitL1Emitter = { pushStarted: () => {}, pushCompleted: () => {} };

/** Every corner the advice resolver has. A line that survives all four survives the product. */
const CORNERS: Record<string, AdviceConfiguration> = {
  v2_default: { v2: true, credentialStore: true },
  v2_noLocker: { v2: true, credentialStore: false },
  killSwitch: { v2: false, credentialStore: true },
  killSwitch_noLocker: { v2: false, credentialStore: false },
};

/**
 * The two sentences that must reach EVERY caller. **Read from the producer, not copied here** —
 * a private copy would go stale against the table it describes, which is the same shape as a
 * frozen expectation nobody re-reads (gate 2, F1).
 */
const UNCONDITIONAL = UNKNOWN_UNCONDITIONAL_CLAIMS;

function wrapThrowing(throwValue: unknown = new Error("induced handler throw")) {
  return makeCommitWrapper(
    async () => {
      throw throwValue;
    },
    "thrown_handler_probe",
    { getEnvValue: () => undefined, l1Emitter: NOOP_L1, getSessionId: () => "probe" },
  );
}

/** Every `.ts` under a root, read once — the producer sweep's own instrument. */
function walkTs(dir: string, out: { file: string; text: string }[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.name.endsWith(".ts")) out.push({ file: full, text: readFileSync(full, "utf8") });
  }
  return out;
}

function parse(content: ReadonlyArray<{ type: string; text?: string }>): Record<string, unknown> {
  const block = content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

function adviceFrom(parsed: Record<string, unknown>): string[] {
  const unexpected = parsed["if_unexpected"] as { try_next?: { action: string }[] } | undefined;
  return (unexpected?.try_next ?? []).map((row) => row.action);
}

beforeEach(() => captureAdviceConfiguration(CORNERS["v2_default"]!));
afterEach(() => resetAdviceConfiguration());

describe("internal #121 — a thrown handler tells the caller where to go", () => {
  it("gives a caller somewhere to go, and the reason it cannot just be told to retry", async () => {
    // MUTATION 1: putting `tryNext: []` back at the callsite. It is a three-character edit that
    // reads like a no-op and re-suppresses every line below it.
    const parsed = parse((await wrapThrowing()({} as Record<string, unknown>)).content);
    const advice = adviceFrom(parsed);

    expect(parsed["reason"], "the compat projection must not move — only the advice fills").toBe(
      "unknown",
    );
    expect(advice.length).toBeGreaterThanOrEqual(4);
    for (const claim of UNCONDITIONAL) {
      expect(advice.join("\n"), `the caller is never told: ${claim}`).toContain(claim);
    }
  });

  it("does not hand over the converter's generic line, which invites the forbidden retry", async () => {
    // MUTATION 2: deleting `SUGGESTS.Unknown`. The callsite then falls through to
    // `toFailureEnvelope`'s own fallback — "Inspect the underlying error and retry with adjusted
    // args" — and a cell that only counted rows would stay green on it, because that fallback is
    // one row. It is wrong twice over here: the underlying error is deliberately NOT published on
    // this road (#121 §3), so there is nothing to inspect; and a throw can land AFTER the side
    // effect, so "retry" invites applying the act twice. A vague permission reads as permission.
    const advice = adviceFrom(parse((await wrapThrowing()({} as Record<string, unknown>)).content));
    expect(advice).not.toContain("Inspect the underlying error and retry with adjusted args");
    expect(advice.join("\n")).not.toMatch(/retry with adjusted args/);
    // The control that this cell is watching a live road and not an empty list: the same call must
    // be carrying real advice while the sentence above is absent.
    expect(advice.length).toBeGreaterThan(1);
  });

  it("never puts an unconditional claim on a line that can be dropped", async () => {
    // **MUTATION 3, AND THE CELL THAT ACTUALLY KILLS IT** (gate 2, F1). The property is structural,
    // not observational: the resolver drops a `{tool:…}` line WHOLE when the configuration cannot
    // provide that tool (`_advice-capability.ts`, numbered hazard 2 — still live), so a sentence
    // that must reach everyone may not ride on one.
    //
    // The first version of this cell swept the four corners instead, and **gate 2 measured that it
    // could not fail**: every line in this entry survives every corner, because the only capability
    // it uses has a provider everywhere. The sweep drew the same picture four times. mac's own
    // mutation round had "killed" it only by merging the claim into a `{tool:credential_store}`
    // line — a mutation chosen to fit the cell, not to fit the edit a person makes, which is to
    // fold the sentence into the line already sitting next to it.
    const lines = getSuggestsForCode("Unknown");
    expect(lines.length, "the entry must exist for this to mean anything").toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      if (!line.includes("{tool:")) continue;
      for (const claim of UNCONDITIONAL) {
        expect(line, `an unconditional claim rides on a droppable line: ${line}`).not.toContain(claim);
      }
    }
    // And each claim is somewhere, on a line that cannot be dropped.
    const undroppable = lines.filter((l) => !l.includes("{tool:")).join("\n");
    for (const claim of UNCONDITIONAL) {
      expect(undroppable, `${claim} is not on any undroppable line`).toContain(claim);
    }
  });

  it("CONTROL: the drop mechanism is real, and this entry simply never triggers it", async () => {
    // **The negative control the corner sweep was missing.** Without it, "all four corners keep
    // every line" reads as "the layout protects them", when the measured reason is that nothing
    // here is droppable at all: 6 kept, 0 dropped, at every corner. Only
    // `disambiguate_window_by_handle` and `credential_store` ever resolve to null.
    //
    // So the mechanism is shown on a synthetic line instead. If this stops dropping, the cell above
    // is guarding against something that no longer happens, and the reasoning in `_errors.ts`
    // should be revisited rather than trusted.
    const synthetic = ["Save it with {tool:credential_store}", "A line with no placeholder"];
    expect(renderAdviceWith(synthetic, CORNERS["v2_default"]!)).toHaveLength(2);
    const dropped = renderAdviceWith(synthetic, CORNERS["v2_noLocker"]!);
    expect(dropped, "the whole line goes, not just the placeholder").toEqual([
      "A line with no placeholder",
    ]);

    // With that established, the corner sweep is still worth running — as the statement that THIS
    // entry is not configuration-dependent, which is a fact about it rather than a guarantee.
    for (const [corner, cfg] of Object.entries(CORNERS)) {
      const rendered = renderAdviceWith(getSuggestsForCode("Unknown"), cfg);
      expect(rendered, `the floor was reached at ${corner}`).not.toContain(ADVICE_WITHHELD_FLOOR);
      expect(rendered.length, `advice emptied out at ${corner}`).toBe(getSuggestsForCode("Unknown").length);
    }
  });

  it("a producer cannot claim this code from a message, whatever the spelling", async () => {
    // **Gate 2 round 2's P1, and it was a REGRESSION this branch had shipped.** `SUGGESTS` is also
    // the registry `classify`'s two code-taking arms match against, so adding a key granted
    // producers the name — and `Unknown` is an ordinary English word. The first fix watched only
    // the colon form; the arm at the END of the cascade needs no colon, so `"Unknown error"` took
    // the key and shipped advice whose first line says the handler threw.
    //
    // Not hypothetical: `src/tools/ui-elements.ts` passes that exact string at two `failWith`
    // sites, and Node's own `Unknown encoding: …` reaches the ~30 `failWith(err, …)` sites inside
    // catch blocks. On `main` every one of these answered `ToolError` with no advice.
    //
    // **This cell is the behaviour, not the spelling.** The previous version swept `src` for one
    // literal — a list of spellings, which does not end, and which missed the whitespace form
    // entirely. What must hold is that this code is minted by the wrapper and by nothing else.
    for (const message of [
      "Unknown error",                      // src/tools/ui-elements.ts, two sites
      "Unknown encoding: not-an-encoding",  // Node, ERR_UNKNOWN_ENCODING
      "Unknown: the widget refused",        // the colon form the first fix watched
      "Unknown",                            // bare
      "  Unknown: leading space",
    ]) {
      const body = JSON.parse(failWith(new Error(message), "probe").content[0]!.text) as {
        code: string; suggest?: string[];
      };
      expect(body.code, `a message claimed the reserved code: ${message}`).not.toBe("Unknown");
      expect(
        (body.suggest ?? []).join("\n"),
        `handler-threw advice reached a producer's own refusal: ${message}`,
      ).not.toContain(UNKNOWN_UNCONDITIONAL_CLAIMS[0]);
    }

    // CONTROL, and it is the whole reason this is a reserved-name guard rather than two dead arms:
    // a NON-reserved key must still be claimable from a message, in both shapes.
    const colon = JSON.parse(failWith(new Error("WindowNotFound: no such window"), "probe").content[0]!.text) as { code: string };
    expect(colon.code, "the declared-code arm stopped working").toBe("WindowNotFound");
    const bare = JSON.parse(failWith(new Error("ForegroundFlashUnsupported"), "probe").content[0]!.text) as { code: string };
    expect(bare.code, "the leading-code arm stopped working").toBe("ForegroundFlashUnsupported");

    // And the wrapper's own road still mints it — otherwise the guard would have removed the code.
    const thrown = parse((await wrapThrowing()({} as Record<string, unknown>)).content);
    expect((thrown["if_unexpected"] as { most_likely_cause: string }).most_likely_cause).toBe("Unknown");
  });

  it("the claims this file checks against are the whole list, not a shrunk one", () => {
    // **Gate 2 round 2's P2.** Reading the claims from the producer removed one duplicate and
    // created another hazard: drop ONE element from the exported constant and every cell above
    // still passes, because each only asserts what remains. Measured — the dictionary untouched,
    // the oracle one shorter, all green.
    expect(UNKNOWN_UNCONDITIONAL_CLAIMS.length).toBe(2);
    // …and each is a real substring of the shipped table, so the constant cannot drift into
    // describing sentences the product does not say.
    const table = getSuggestsForCode("Unknown").join("\n");
    for (const claim of UNKNOWN_UNCONDITIONAL_CLAIMS) {
      expect(table, `the oracle names a claim the table does not make: ${claim}`).toContain(claim);
    }
  });

  it("the family breakdown in the comment adds up to the wrapper's real call sites", () => {
    // **Gate 2 round 2's P3**, and it is the shape F4 found, one paragraph over: a number written
    // in prose that nothing checks. The comment said "browser 6, terminal 1, clipboard 1, excel 1,
    // desktop 13" — which sums to 22, while `makeCommitWrapper(` has 21 call sites.
    const files = walkTs(fileURLToPath(new URL("../../src", import.meta.url)));
    const sites = files.flatMap(({ file, text }) =>
      [...text.matchAll(/makeCommitWrapper\(/g)].map(() => file),
    ).filter((f) => !f.endsWith("_envelope.ts"));
    expect(sites.length, "the wrapper's call-site count moved — the comment in _errors.ts states it").toBe(21);
    const count = (needle: string) => sites.filter((f) => f.includes(needle)).length;
    expect(count("browser.ts")).toBe(6);
    expect(count("terminal.ts")).toBe(1);
    expect(count("clipboard.ts")).toBe(1);
    expect(count("excel.ts")).toBe(1);
    // Everything else is the desktop family — named as a remainder so it cannot be miscounted.
    expect(sites.length - count("browser.ts") - count("terminal.ts") - count("clipboard.ts") - count("excel.ts")).toBe(12);
  });

  it("names an instrument per family, so a browser caller is not sent to the UIA tree", async () => {
    // MUTATION 4: collapsing the family lines into one desktop instrument. `ElementNotFound` above
    // already had to be split for this — a CSS selector matches no UIA name — and the wrapper's 21
    // tools include six browser ones, `terminal`, `clipboard` and `excel`. A true reason applied
    // where it does not hold is still a wrong answer.
    const advice = adviceFrom(parse((await wrapThrowing()({} as Record<string, unknown>)).content));
    const joined = advice.join("\n");
    expect(joined, "no browser instrument").toMatch(/browser_overview|browser_search/);
    expect(joined, "no terminal instrument").toMatch(/terminal\(action='read'\)/);
    // **clipboard was missing from both the lines and this cell** (gate 2, F4): the comment named
    // five families as the reason for splitting and only three had a line, so a clipboard caller
    // was told to observe with nothing named. `excel` deliberately has none — its actions are
    // `run_vba` and `check_access_vbom`, so there is no read to point at, and it rides the second
    // line. That is asserted too, so the claim and the check cannot drift apart.
    expect(joined, "no clipboard instrument").toMatch(/clipboard\(action='read'\)/);
    expect(joined, "excel has no read action — naming one would be advice that cannot be called").not.toMatch(/excel\(/);
    // The desktop line comes from the capability, so it is the PROVIDER's name that must appear,
    // not the placeholder — that is what says the line went through the resolver on its way out.
    expect(joined).toContain("desktop_discover");
    expect(joined, "a placeholder shipped raw").not.toContain("{tool:");
  });

  it("answers the same way for a throw that carries no Error at all", async () => {
    // Reachability, not shape: `throw undefined` and `Promise.reject(null)` are legal and were
    // already the subject of a Codex round on the sentinel that catches them
    // (`desktop-act-commit-wrapper.test.ts`). Those cells assert `most_likely_cause` and stop —
    // so the advice road on the value-free throws had nothing behind it until here.
    for (const value of [undefined, null]) {
      const advice = adviceFrom(parse((await wrapThrowing(value)({} as Record<string, unknown>)).content));
      expect(advice.length, `no advice for throw ${String(value)}`).toBeGreaterThanOrEqual(4);
      expect(advice.join("\n")).toContain(UNCONDITIONAL[0]);
    }
  });

  it("CONTROL: a handler that returns normally carries none of this", async () => {
    // The two answers have to look different. Without this cell, an advice list attached to every
    // response — the cheapest way to make all of the above pass — would read as a fix.
    const wrapped = makeCommitWrapper(
      async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] }),
      "returning_handler_probe",
      { getEnvValue: () => undefined, l1Emitter: NOOP_L1, getSessionId: () => "probe" },
    );
    const parsed = parse((await wrapped({} as Record<string, unknown>)).content);
    expect(parsed["ok"]).toBe(true);
    expect(adviceFrom(parsed)).toEqual([]);
  });
});
