/**
 * classify-cascade-order-invariant.test.ts — Round 10: machine-generated
 * cascade-order invariant for `_errors.ts::classify()`.
 *
 * Why this exists: rounds 7-9 kept hand-writing "collision" strings to pin the
 * substring-arm ordering (BrowserSearchTimeout above UiaTimeout,
 * KeyLockerSpawnFailed above SpawnFailed, …), and Codex found a same-shaped
 * vacuous pin three rounds in a row — a hand-written pin only verifies the
 * ordering if its message happens to contain a competing keyword. This file
 * replaces that per-string whack-a-mole with two invariants generated from the
 * classify source itself (same derive-from-source discipline as the
 * `suggestsKeys()` dictionary round-trip in oq8-failwith-suggest-routing).
 *
 * What is machine-derivable — and therefore pinned here:
 *
 *  1. LITERAL SELF-ROUTING (the intent teeth): every substring literal, fed in
 *     a cascade-reaching wrapper, must classify to its own arm's code. This is
 *     ORDER-INDEPENDENT intent: whenever one arm's literal contains another's
 *     ("keylockerspawnfailed" ⊃ "spawnfailed", "terminal window not found" ⊃
 *     "window not found", "browsersearchtimeout" ⊃ "timeout"), the container
 *     arm must sit above the contained arm or its literal is shadowed and this
 *     test fails. Every containment-class ordering constraint — the entire
 *     class rounds 7-9 were patching one string at a time — is pinned by this
 *     rule for current AND future arms, with no hand-kept list.
 *
 *  2. PAIRWISE EARLIER-ARM-WINS (the extraction-faithfulness guard): for every
 *     ordered pair of arms (E before L) and every literal combination, a
 *     synthesized message carrying both tokens must classify to E's code.
 *     Honesty note: because the pair order is re-derived from the source on
 *     every run, this rule alone cannot detect a swap of two arms whose
 *     literals have no containment relation (the extraction re-derives the
 *     swapped order and stays self-consistent — measured in Round 10's
 *     mutation runs). Its value is different: it proves the extracted model
 *     IS the implementation (a mis-parsed condition, a missed literal, or an
 *     unmodeled predicate surfaces as a failing pair), and combined with rule
 *     1 it fails loudly for every containment-violating reorder.
 *
 * What is deliberately NOT covered here, and where it lives instead:
 *   - Non-containment ordering intent (e.g. SpawnFailed placed ABOVE the
 *     generic "window not found" arm even though neither literal contains the
 *     other): that intent is positional and cannot be derived from the source
 *     without hand-encoding it — the cascade itself places OTHER code-token
 *     arms (TabDragBlocked and the flash family) AFTER the generic arms by
 *     design, so "code token beats generic keyword" is not a global truth of
 *     this cascade. Those few intent anchors stay as hand pins that carry a
 *     real competitor: phase7-f3-spawn-failed-typed-code.test.ts (case 6) and
 *     reachable-bounds.test.ts (both "wins over the generic arms" loops).
 *   - Production wording tripwires (a producer's prose must not grow a generic
 *     keyword while its arm sits below the generic arms):
 *     oq8-failwith-suggest-routing.test.ts pins the real producer strings.
 *   - The declared-code arm and the trailing leading-code arm: dictionary
 *     round-trip + adversarial-tail invariants in oq8 already cover both.
 *
 * Explicit extraction exclusions (silent omission is the failure mode this
 * file exists to kill, so each one is asserted, not assumed):
 *   - The compound `m.includes("browser") && (…)` arm (BrowserNotConnected):
 *     its literals only fire together, so single-literal semantics do not
 *     apply. The exclusion is pinned — a second compound arm fails the test
 *     and forces an explicit decision here.
 *   - `m.startsWith("guard failed")` and `m === "disabled"`: predicates that
 *     cannot fire on a wrapper-prefixed message (the wrapper defeats both), so
 *     they are ignored for generation; any OTHER non-includes predicate fails
 *     the leftover check below.
 *
 * Cost, measured at introduction: 62 arms → 61 included, 93 literals,
 * 4,245 pairwise messages; the whole file runs in ~0.5s (classify is pure
 * string scanning), so no pruning of the pair space was needed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { failWith } from "../../src/tools/_errors.js";

const render = (message: string) =>
  JSON.parse(failWith(new Error(message), "t").content[0]!.text) as {
    code: string;
    suggest?: string[];
  };

/**
 * Lowercase wrapper that reaches the substring cascade: it defeats the
 * declared-code arm (needs a leading PascalCase token + colon), the trailing
 * leading-code arm (needs a leading capital), `m.startsWith("guard failed")`
 * and `m === "disabled"`. No arm literal contains "wrapped".
 */
const WRAP = "wrapped: ";
/** Token separator no arm literal can span: no literal contains "~". */
const SEP = " ~ ";

interface Arm {
  code: string;
  literals: string[];
  condition: string;
}

interface Cascade {
  /** Single-literal-semantics arms, in source order. */
  arms: Arm[];
  /** Compound (&&) arms, excluded from generation — membership is pinned. */
  excluded: Arm[];
}

/** Substring arms of classify(), parsed from the source in occurrence order. */
function extractCascade(): Cascade {
  const src = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "tools", "_errors.ts"),
    "utf8",
  );
  // The substring cascade is everything between the lowercasing of the
  // message and the trailing leading-code arm.
  const start = src.indexOf("const m = message.toLowerCase();");
  const end = src.indexOf("const leadingCode");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const region = src.slice(start, end);

  const all: Arm[] = [];
  for (const match of region.matchAll(
    /if \(([\s\S]*?)\)\s*\{\s*return \{\s*code: "([A-Za-z0-9]+)"/g,
  )) {
    const condition = match[1]!;
    const code = match[2]!;
    const literals = [...condition.matchAll(/m\.includes\("([^"]+)"\)/g)].map((m) => m[1]!);
    all.push({ code, literals, condition });
  }

  // ── Extraction completeness — a silent miss is the one unacceptable bug ──
  // Every `return { code:` in the region must belong to a captured arm. An
  // arm whose body is not an immediate return would glue two arms into one
  // condition group and break this count.
  const returnCount = [...region.matchAll(/return \{\s*code: "/g)].length;
  expect(all.length, "every cascade return must be captured as an arm").toBe(returnCount);
  // Every `m.includes(` in the region must have been captured as a literal.
  const includesCount = [...region.matchAll(/m\.includes\(/g)].length;
  expect(
    all.reduce((n, a) => n + a.literals.length, 0),
    "every m.includes literal must be captured",
  ).toBe(includesCount);

  // Any predicate that is not m.includes(…) must be one of the two known,
  // wrapper-immune forms — a new predicate shape must be modeled or excluded
  // HERE, explicitly, not silently dropped.
  for (const arm of all) {
    if (arm.condition.includes("&&")) continue; // compound — handled below
    const leftovers = arm.condition
      .split("||")
      .map((p) => p.trim())
      .filter((p) => !/^m\.includes\("[^"]+"\)$/.test(p));
    for (const p of leftovers) {
      expect(
        ['m.startsWith("guard failed")', 'm === "disabled"'],
        `unmodeled predicate ${JSON.stringify(p)} in the ${arm.code} arm`,
      ).toContain(p);
    }
  }

  const excluded = all.filter((a) => a.condition.includes("&&"));
  const arms = all.filter((a) => !a.condition.includes("&&"));

  // The compound-arm exclusion is pinned by NAME: adding another compound arm
  // must fail here and force a decision about how to model it.
  expect(excluded.map((a) => a.code)).toEqual(["BrowserNotConnected"]);

  // Sanity floors (61 included arms / 93 literals when written): a drastic drop means
  // the arm regex stopped matching the source shape.
  expect(arms.length).toBeGreaterThanOrEqual(55);
  expect(arms.reduce((n, a) => n + a.literals.length, 0)).toBeGreaterThanOrEqual(80);

  return { arms, excluded };
}

const { arms, excluded } = extractCascade();

describe("classify substring cascade — structural preconditions", () => {
  it("literals are unique across arms and cannot fuse across the separator", () => {
    const owner = new Map<string, string>();
    for (const arm of arms) {
      for (const lit of arm.literals) {
        expect(owner.has(lit), `literal "${lit}" owned by both ${owner.get(lit)} and ${arm.code}`).toBe(false);
        owner.set(lit, arm.code);
        // The separator/wrapper guarantees: no literal can span a token
        // boundary or match inside the wrapper.
        expect(lit).not.toContain("~");
        expect(lit).not.toContain("wrapped");
      }
    }
  });

  it("the excluded compound arm cannot fire on any synthesized message", () => {
    // BrowserNotConnected needs "browser" AND ("not connected" | "econnrefused").
    // Included literals may contain "browser" (browsersearchtimeout, the CDP
    // delivery codes), so the compound arm stays dormant only as long as no
    // included literal carries one of the second-group tokens.
    for (const arm of arms) {
      for (const lit of arm.literals) {
        expect(lit).not.toContain("not connected");
        expect(lit).not.toContain("econnrefused");
      }
    }
  });

  it("whenever one arm's literal contains another arm's literal, the container's arm comes first", () => {
    // The containment lemma behind the pairwise rule: with containers placed
    // above containeds, a two-token message can never wake a THIRD arm, so
    // "earlier arm wins" is exact. Violations are also caught behaviorally by
    // the self-routing rule; this assertion names the offending pair directly.
    const violations: string[] = [];
    for (let i = 0; i < arms.length; i++) {
      for (let j = 0; j < i; j++) {
        // arms[j] precedes arms[i]; a literal of the LATER arm containing a
        // literal of the EARLIER arm means the later literal is shadowed.
        for (const container of arms[i]!.literals) {
          for (const contained of arms[j]!.literals) {
            if (container !== contained && container.includes(contained)) {
              violations.push(
                `"${container}" (${arms[i]!.code}, arm #${i}) contains "${contained}" (${arms[j]!.code}, arm #${j}) but comes AFTER it — the literal is shadowed`,
              );
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("classify substring cascade — literal self-routing (order-independent intent)", () => {
  it("every literal, wrapped to reach the cascade, classifies to its own arm with advice", () => {
    const misrouted: string[] = [];
    for (const arm of arms) {
      for (const lit of arm.literals) {
        const body = render(WRAP + lit);
        if (body.code !== arm.code || (body.suggest ?? []).length === 0) {
          misrouted.push(
            `"${WRAP + lit}" → code:${body.code} suggest:${(body.suggest ?? []).length} (expected ${arm.code})`,
          );
        }
      }
    }
    expect(
      misrouted,
      "an arm's own literal must reach its arm — a broader arm above it is shadowing the literal",
    ).toEqual([]);
  });
});

describe("classify substring cascade — pairwise earlier-arm-wins (extraction faithfulness)", () => {
  it("for every ordered arm pair, a message carrying both tokens resolves to the earlier arm", () => {
    const mismatches: string[] = [];
    let pairCount = 0;
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        for (const e of arms[i]!.literals) {
          for (const l of arms[j]!.literals) {
            pairCount++;
            const message = WRAP + e + SEP + l;
            const body = render(message);
            if (body.code !== arms[i]!.code) {
              mismatches.push(
                `"${message}" → ${body.code} (expected ${arms[i]!.code}: arm #${i} precedes #${j} ${arms[j]!.code})`,
              );
            }
          }
        }
      }
    }
    // Vacuity floor: ~3,900 pairs at introduction. A collapse here means the
    // extraction went blind, not that the cascade shrank tenfold.
    expect(pairCount).toBeGreaterThan(3000);
    expect(
      mismatches,
      "the extracted arm order diverged from the implementation, or a synthesized pair woke an unmodeled arm",
    ).toEqual([]);
  }, 30_000);
});
