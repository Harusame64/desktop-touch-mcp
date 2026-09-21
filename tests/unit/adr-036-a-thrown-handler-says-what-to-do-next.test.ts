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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeCommitWrapper, type CommitL1Emitter } from "../../src/tools/_envelope.js";
import { getSuggestsForCode } from "../../src/tools/_errors.js";
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
 * The two sentences that must reach EVERY caller, quoted as substrings rather than whole lines so
 * that rewording around them does not fail this cell — what is pinned is the claim, not the prose.
 */
const UNCONDITIONAL = [
  "does NOT say the act was skipped",
  "do not repeat this call as a retry",
] as const;

function wrapThrowing(throwValue: unknown = new Error("induced handler throw")) {
  return makeCommitWrapper(
    async () => {
      throw throwValue;
    },
    "thrown_handler_probe",
    { getEnvValue: () => undefined, l1Emitter: NOOP_L1, getSessionId: () => "probe" },
  );
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

  it("keeps the two unconditional claims at every corner, because a {tool:} line drops WHOLE", async () => {
    // MUTATION 3: merging a placeholder-free sentence into a line that carries `{tool:…}`. The
    // resolver drops such a line entirely when this configuration cannot provide the tool
    // (`_advice-capability.ts`, numbered hazard 2 — still live), and it takes the
    // configuration-independent half with it. Nothing else in the tree would go red: the v2 corner
    // renders both halves and that is the corner the freeze is pinned to.
    for (const [corner, cfg] of Object.entries(CORNERS)) {
      const rendered = renderAdviceWith(getSuggestsForCode("Unknown"), cfg);
      for (const claim of UNCONDITIONAL) {
        expect(rendered.join("\n"), `${claim} — lost at ${corner}`).toContain(claim);
      }
      expect(rendered, `the floor was reached at ${corner}`).not.toContain(ADVICE_WITHHELD_FLOOR);
      expect(rendered.length, `advice emptied out at ${corner}`).toBeGreaterThanOrEqual(4);
    }
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
