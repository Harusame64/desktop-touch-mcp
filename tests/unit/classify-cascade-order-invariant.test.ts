/**
 * classify-cascade-order-invariant.test.ts — Round 10: machine-generated
 * cascade-order invariant for `_errors.ts::classify()`. Round 11 (Codex P2):
 * compound (`&&`) arms are modeled instead of skipped — see the modeling
 * notes below.
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
 *  1. FIRING-SET SELF-ROUTING (the intent teeth): every firing set (a single
 *     literal, or the literal conjunction of a compound arm's disjunct), fed
 *     in a cascade-reaching wrapper, must classify to its own arm's code. This
 *     is ORDER-INDEPENDENT intent: whenever one arm's tokens complete an
 *     earlier arm's firing set ("keylockerspawnfailed" ⊃ "spawnfailed",
 *     "terminal window not found" ⊃ "window not found", "browsersearchtimeout"
 *     ⊃ "timeout"), the more-specific arm must sit above the poacher or its
 *     set is shadowed and this test fails. Every containment-class ordering
 *     constraint — the entire class rounds 7-9 were patching one string at a
 *     time — is pinned by this rule for current AND future arms, with no
 *     hand-kept list.
 *
 *  2. PAIRWISE EARLIER-ARM-WINS (the extraction-faithfulness guard): for every
 *     ordered pair of arms (E before L) and every firing-set combination, a
 *     synthesized message carrying both sets' tokens must classify to E's
 *     code. Honesty note: because the pair order is re-derived from the source
 *     on every run, this rule alone cannot detect a swap of two arms whose
 *     sets have no completion relation (the extraction re-derives the swapped
 *     order and stays self-consistent — measured in Round 10's mutation runs).
 *     Its value is different: it proves the extracted model IS the
 *     implementation (a mis-parsed condition, a missed literal, or an
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
 *     real competitor — all FOUR of them (Round 12: this list was dropping
 *     the fourth, and a stale enumeration misleads harder than prose):
 *       - SpawnFailed above the generic "window not found" arm →
 *         phase7-f3-spawn-failed-typed-code.test.ts (case 6)
 *       - CoordinateOutsideReachableBounds above the generic arms →
 *         reachable-bounds.test.ts ("wins over the generic classify arms" loop)
 *       - CursorPlacementBlocked above the generic arms →
 *         reachable-bounds.test.ts (its sibling "wins over…" loop)
 *       - ForegroundFlashFailed above the generic timeout arm →
 *         oq8-failwith-suggest-routing.test.ts ("keeps the timeout-bearing
 *         flash reason out of the generic UiaTimeout arm", which feeds the
 *         wrapper-prefixed "CDP: ForegroundFlashFailed: focus_wait_timeout"
 *         — a message that carries the competing "timeout" keyword).
 *   - Production wording tripwires (a producer's prose must not grow a generic
 *     keyword while its arm sits below the generic arms):
 *     oq8-failwith-suggest-routing.test.ts pins the real producer strings.
 *   - The declared-code arm and the trailing leading-code arm: dictionary
 *     round-trip + adversarial-tail invariants in oq8 already cover both.
 *
 * Modeling notes (silent omission is the failure mode this file exists to
 * kill, so every non-trivial condition shape is either modeled or fails the
 * extraction loudly):
 *   - Conditions are parsed by a tiny tokenizer + recursive-descent parser
 *     into disjunctive normal form: each arm becomes a list of FIRING SETS,
 *     where a set fires iff every token in it is present. `a || b` yields
 *     {a},{b}; `a && (b || c)` yields {a,b},{a,c}. Compound arms therefore
 *     participate in every rule below. Round 11 (Codex P2): the previous
 *     version skipped `&&` conditions wholesale, so grafting an independent
 *     `|| m.includes("browser offline")` disjunct onto the BrowserNotConnected
 *     arm sailed through every check — measured before this fix; the same
 *     mutation now fails the compound-shape pin below.
 *   - Compound arms are ADDITIONALLY pinned by exact shape (code → firing
 *     sets), not just modeled: conjunction semantics carry subtleties the
 *     singleton arms don't have (dormancy on other arms' synthesized
 *     messages, partial completion by a pair message), so ANY change to a
 *     compound arm — a new disjunct, a new compound arm, a de-compounded one —
 *     must fail here and force an explicit decision.
 *   - `m.startsWith("guard failed")` and `m === "disabled"`: wrapper-immune
 *     predicates (mechanically asserted in the preconditions — WRAP defeats
 *     both), accepted by the tokenizer ONLY in exactly these two spellings and
 *     ONLY as a whole disjunct; any other non-includes predicate, or an
 *     immune predicate conjoined into a `&&` set (where dropping it would
 *     silently erase the set from the model), fails the extraction loudly.
 *   - Tokenizer churn caution: the tokenizer has no comment syntax, so a
 *     comment written INSIDE an arm's condition parentheses is "unmodeled
 *     predicate syntax" and bails the whole suite. Deliberate strictness — a
 *     comment could hide an unmodeled predicate from the model — but it means
 *     future classify() edits must keep comments on the lines ABOVE the
 *     `if`, never inside the condition expression.
 *   - Extraction completeness is five counts over the region agreeing (arm
 *     regex, `return { code:`, `return {`, line-leading `return`, line-leading
 *     `if (`). Round 12 (mutation C, measured): a TAIL arm returning something
 *     other than an object literal — `return classify(…)`, a helper
 *     delegation, a constant — slipped through the first three counts and
 *     every rule below; the two line-anchored statement counts now catch it
 *     (mid-region the arm regex swallows the next arm's condition and the
 *     tokenizer bails, so the tail was the silent position). KNOWN LIMIT: an
 *     arm added OUTSIDE the region — above `const m = message.toLowerCase();`
 *     or below the `const leadingCode` marker — is invisible to every count
 *     here in principle; the two boundary markers are the trust anchor, and
 *     moving them moves what this file can see.
 *
 * Cost, measured at Round 11: 62 arms, 95 firing sets, 4,431 pairwise
 * messages; the whole file runs in ~0.6s (classify is pure string scanning),
 * so no pruning of the pair space was needed.
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
 * and `m === "disabled"`. No arm token contains "wrapped".
 */
const WRAP = "wrapped: ";
/** Token separator no arm token can span: no token contains "~". */
const SEP = " ~ ";

type Atom = { kind: "lit"; value: string } | { kind: "immune"; src: string };
type Tok = Atom | { kind: "open" | "close" | "and" | "or" };

interface Arm {
  code: string;
  /**
   * Disjunctive normal form of the arm's condition, restricted to the
   * wrapper-reachable disjuncts: the arm fires on a synthesized message iff
   * every token of SOME set is a substring of it.
   */
  sets: string[][];
  condition: string;
}

/** Loud extraction failure — thrown at module load, fails the whole suite. */
function bail(message: string): never {
  throw new Error(`classify-cascade extraction: ${message}`);
}

/**
 * Tokenize one arm condition. Every character must be consumed by a known
 * form — a new predicate shape (a regex test, a helper call, a renamed
 * variable) must be modeled or pinned HERE, explicitly, never silently
 * dropped. This is strictly stronger than Round 10's leftover check, which
 * never looked inside `&&` conditions at all.
 */
function tokenizeCondition(condition: string, code: string): Tok[] {
  const re =
    /\s+|m\.includes\("([^"]+)"\)|m\.startsWith\("guard failed"\)|m === "disabled"|&&|\|\||\(|\)/y;
  const toks: Tok[] = [];
  let pos = 0;
  while (pos < condition.length) {
    re.lastIndex = pos;
    const match = re.exec(condition);
    if (!match) {
      bail(
        `unmodeled predicate syntax in the ${code} arm at ${JSON.stringify(condition.slice(pos, pos + 60))}`,
      );
    }
    const text = match[0];
    if (match[1] !== undefined) toks.push({ kind: "lit", value: match[1] });
    else if (text.startsWith("m.") || text.startsWith("m ")) toks.push({ kind: "immune", src: text });
    else if (text === "&&") toks.push({ kind: "and" });
    else if (text === "||") toks.push({ kind: "or" });
    else if (text === "(") toks.push({ kind: "open" });
    else if (text === ")") toks.push({ kind: "close" });
    // else: whitespace — skipped.
    pos = re.lastIndex;
  }
  return toks;
}

/**
 * Recursive-descent `expr := term (|| term)*; term := factor (&& factor)*;
 * factor := atom | ( expr )` → DNF. `&&` distributes as the cross product of
 * the operand DNFs, so `a && (b || c)` becomes [{a,b},{a,c}].
 */
function parseFiringSets(toks: Tok[], code: string): Atom[][] {
  let pos = 0;
  const parseExpr = (): Atom[][] => {
    let sets = parseTerm();
    while (toks[pos]?.kind === "or") {
      pos++;
      sets = sets.concat(parseTerm());
    }
    return sets;
  };
  const parseTerm = (): Atom[][] => {
    let sets = parseFactor();
    while (toks[pos]?.kind === "and") {
      pos++;
      const right = parseFactor();
      sets = sets.flatMap((left) => right.map((r) => [...left, ...r]));
    }
    return sets;
  };
  const parseFactor = (): Atom[][] => {
    const t = toks[pos];
    if (t?.kind === "open") {
      pos++;
      const inner = parseExpr();
      if (toks[pos]?.kind !== "close") bail(`unbalanced parentheses in the ${code} arm condition`);
      pos++;
      return inner;
    }
    if (t?.kind === "lit" || t?.kind === "immune") {
      pos++;
      return [[t]];
    }
    bail(`unexpected token in the ${code} arm condition`);
  };
  const sets = parseExpr();
  if (pos !== toks.length) bail(`trailing tokens in the ${code} arm condition`);
  return sets;
}

/** Substring arms of classify(), parsed from the source in occurrence order. */
function extractCascade(): Arm[] {
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

  const arms: Arm[] = [];
  let literalTokenCount = 0;
  for (const match of region.matchAll(
    /if \(([\s\S]*?)\)\s*\{\s*return \{\s*code: "([A-Za-z0-9]+)"/g,
  )) {
    const condition = match[1]!;
    const code = match[2]!;
    const toks = tokenizeCondition(condition, code);
    literalTokenCount += toks.filter((t) => t.kind === "lit").length;

    const sets: string[][] = [];
    for (const set of parseFiringSets(toks, code)) {
      if (set.some((a) => a.kind === "immune")) {
        // A wrapper-immune predicate may only stand as a WHOLE disjunct: WRAP
        // defeats it (asserted mechanically in the preconditions), so the
        // disjunct contributes nothing to wrapper-reachable routing and is
        // dropped. Conjoined with literals it would erase those literals from
        // the model too — that shape must be decided here, not vanish.
        if (set.length !== 1) {
          bail(`immune predicate conjoined with other predicates in the ${code} arm`);
        }
        continue;
      }
      sets.push(
        set.map((a) => {
          if (a.kind !== "lit") bail("unreachable: immune atoms are handled above");
          return a.value;
        }),
      );
    }
    // An arm whose every disjunct dropped would be invisible to every rule
    // below — silent omission, the one unacceptable bug.
    if (sets.length === 0) bail(`the ${code} arm has no wrapper-reachable firing set`);
    arms.push({ code, sets, condition });
  }

  // ── Extraction completeness — a silent miss is the one unacceptable bug ──
  // Every `return { code: "…"` in the region must belong to a captured arm. An
  // arm whose body is not an immediate return would glue two arms into one
  // condition group and break this count.
  const returnCount = [...region.matchAll(/return \{\s*code: "/g)].length;
  expect(arms.length, "every cascade return must be captured as an arm").toBe(returnCount);
  // …and every `return {` must be that string-literal-code shape: a
  // `return { code: someConst }` arm would be invisible to BOTH counts above,
  // a symmetric blind spot (Round 11 sweep).
  const returnBraceCount = [...region.matchAll(/return \{/g)].length;
  expect(
    returnBraceCount,
    'every return in the region must be the `return { code: "…" }` shape',
  ).toBe(returnCount);
  // …and both brace-shaped counts must equal the STATEMENT-level counts: a
  // TAIL arm that returns something other than an object literal
  // (`return classify(…)`, `return SOME_CONST;`, a helper call) matches
  // neither the arm regex nor either `return {` count — measured in Round 12
  // (mutation C): such a tail arm sailed through all three counts above and
  // every rule below, 6/6 green. Line-anchored statement counts see every
  // `return` / `if (` the region contains, whatever the body shape. (The
  // anchors must be line-leading: a bare /\breturn\b/ would also count prose
  // inside comments.) See the header for the remaining out-of-region limit.
  const lineReturnCount = [...region.matchAll(/^\s*return\b/gm)].length;
  expect(
    lineReturnCount,
    "every line-leading return in the region must be a captured arm's `return { code: … }`",
  ).toBe(returnCount);
  const lineIfCount = [...region.matchAll(/^\s*if \(/gm)].length;
  expect(
    lineIfCount,
    "every line-leading `if (` in the region must open a captured arm",
  ).toBe(arms.length);
  // Every `m.includes(` in the region must have been captured as a literal
  // token (counted pre-DNF, since the cross product duplicates literals).
  const includesCount = [...region.matchAll(/m\.includes\(/g)].length;
  expect(literalTokenCount, "every m.includes literal must be captured").toBe(includesCount);

  // Sanity floors (62 arms / 96 literal tokens at Round 11): a drastic drop
  // means the arm regex stopped matching the source shape.
  expect(arms.length).toBeGreaterThanOrEqual(55);
  expect(literalTokenCount).toBeGreaterThanOrEqual(80);

  return arms;
}

const arms = extractCascade();

// ── Pure model of the extracted cascade ─────────────────────────────────────
const armFires = (arm: Arm, msg: string) => arm.sets.some((s) => s.every((t) => msg.includes(t)));
const modelRoute = (msg: string) => arms.find((a) => armFires(a, msg));
const setMessage = (set: string[]) => WRAP + set.join(SEP);
const pairMessage = (earlier: string[], later: string[]) =>
  WRAP + earlier.join(SEP) + SEP + later.join(SEP);

describe("classify substring cascade — structural preconditions", () => {
  it("tokens are unique across arms, cannot fuse across the separator, and WRAP defeats the immune predicates", () => {
    const owner = new Map<string, string>();
    for (const arm of arms) {
      // Dedupe per arm: a compound arm legitimately reuses its shared token
      // ("browser") across its own sets.
      for (const tok of new Set(arm.sets.flat())) {
        expect(
          owner.has(tok),
          `token "${tok}" owned by both ${owner.get(tok)} and ${arm.code}`,
        ).toBe(false);
        owner.set(tok, arm.code);
        // The separator/wrapper guarantees: no token can span a token
        // boundary or match inside the wrapper.
        expect(tok).not.toContain("~");
        expect(tok).not.toContain("wrapped");
      }
    }
    // Mechanical justification for dropping the two immune disjuncts during
    // extraction: every synthesized message is WRAP-prefixed, so
    // `m.startsWith("guard failed")` needs one string to prefix the other at
    // the message head, and `m === "disabled"` needs WRAP to prefix
    // "disabled". None holds.
    expect(WRAP.startsWith("guard failed")).toBe(false);
    expect("guard failed".startsWith(WRAP)).toBe(false);
    expect("disabled".startsWith(WRAP)).toBe(false);
  });

  it("compound (&&) arms are modeled AND their firing-set shapes are exactly pinned", () => {
    // Round 11 (Codex P2): membership-by-name was not enough — grafting an
    // independent `|| m.includes("browser offline")` disjunct onto the
    // existing compound arm kept the name list identical and escaped every
    // check (measured). Pinning the full firing-set shape makes ANY compound
    // change — new disjunct, new compound arm, de-compounded arm — fail here
    // and forces an explicit decision.
    const compound = arms.filter((a) => a.sets.some((s) => s.length > 1));
    expect(
      Object.fromEntries(compound.map((a) => [a.code, a.sets])),
      "a compound arm changed shape (or appeared/disappeared) — update this pin CONSCIOUSLY and re-check the dormancy reasoning above it",
    ).toEqual({
      BrowserNotConnected: [
        ["browser", "not connected"],
        ["browser", "econnrefused"],
      ],
    });
  });

  it("model well-posedness: every firing set's own message routes to its own arm (shadow lemma)", () => {
    // The generalization of Round 10's literal-containment lemma to firing
    // sets: an earlier arm firing on a later arm's own message means the set
    // is shadowed. For singleton sets this is exactly the old "container arm
    // must come first" rule; for compound sets it also proves partial tokens
    // ("browser" inside "browsersearchtimeout") do NOT wake the compound arm.
    // Violations are also caught behaviorally by the self-routing rule; this
    // assertion names the offending pair directly.
    const violations: string[] = [];
    for (const arm of arms) {
      for (const set of arm.sets) {
        const route = modelRoute(setMessage(set));
        if (route !== arm) {
          violations.push(
            `set [${set.join(" & ")}] of ${arm.code} routes to ${route?.code ?? "no arm"} in the model — an earlier arm shadows it`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("model well-posedness: no pair message wakes an arm ahead of its earlier operand", () => {
    // The containment lemma behind the pairwise rule, generalized: a two-set
    // message must resolve, IN THE MODEL, to the earlier operand — never to a
    // third arm completed by the combined tokens. This subsumes Round 10's
    // hand-written BrowserNotConnected dormancy pin (no other arm's token may
    // carry "not connected"/"econnrefused"): if any token combination from
    // two other arms completed a compound set sitting above them, it would
    // surface here with the culprit named.
    const violations: string[] = [];
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        for (const se of arms[i]!.sets) {
          for (const sl of arms[j]!.sets) {
            const msg = pairMessage(se, sl);
            const route = modelRoute(msg);
            if (route !== arms[i]) {
              violations.push(
                `"${msg}" routes to ${route?.code ?? "no arm"} in the model (expected ${arms[i]!.code}, arm #${i}, over #${j} ${arms[j]!.code})`,
              );
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("classify substring cascade — firing-set self-routing (order-independent intent)", () => {
  it("every firing set, wrapped to reach the cascade, classifies to its own arm with advice", () => {
    const misrouted: string[] = [];
    for (const arm of arms) {
      for (const set of arm.sets) {
        const body = render(setMessage(set));
        if (body.code !== arm.code || (body.suggest ?? []).length === 0) {
          misrouted.push(
            `"${setMessage(set)}" → code:${body.code} suggest:${(body.suggest ?? []).length} (expected ${arm.code})`,
          );
        }
      }
    }
    expect(
      misrouted,
      "an arm's own firing set must reach its arm — a broader arm above it is shadowing the set",
    ).toEqual([]);
  });
});

describe("classify substring cascade — pairwise earlier-arm-wins (extraction faithfulness)", () => {
  it("for every ordered arm pair, a message carrying both sets' tokens resolves to the earlier arm", () => {
    const mismatches: string[] = [];
    let pairCount = 0;
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        for (const se of arms[i]!.sets) {
          for (const sl of arms[j]!.sets) {
            pairCount++;
            const message = pairMessage(se, sl);
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
    // Vacuity floor: 4,431 pairs at Round 11. A collapse here means the
    // extraction went blind, not that the cascade shrank tenfold.
    expect(pairCount).toBeGreaterThan(3000);
    expect(
      mismatches,
      "the extracted arm order diverged from the implementation, or a synthesized pair woke an unmodeled arm",
    ).toEqual([]);
  }, 30_000);
});
