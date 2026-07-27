/**
 * classify-cascade-order-invariant.test.ts — Round 10: machine-generated
 * cascade-order invariant for `_errors.ts::classify()`. Round 11 (Codex P2):
 * compound (`&&`) arms are modeled instead of skipped. Round 14 (Codex P2):
 * the extraction is an AST walk of the WHOLE classify() body (TypeScript
 * compiler API), not a regex over a marker-delimited region — see the
 * modeling notes below.
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
 *     real competitor — all SIX of them (Round 12: this list was dropping the
 *     fourth, and a stale enumeration misleads harder than prose; the last two
 *     arrived with the capture choke point):
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
 *       - RegionOutsideCapturableBounds above the generic arms →
 *         adr-031-capture-resolver.test.ts ("both codes win over the generic
 *         classify arms", which feeds "window not found" / "timed out" /
 *         "element not found" tails)
 *       - CaptureBackendFailed above the generic arms →
 *         adr-031-capture-resolver.test.ts (the same loop; its production
 *         message also carries the backend's own uncontrolled text)
 *   - Production wording tripwires (a producer's prose must not grow a generic
 *     keyword while its arm sits below the generic arms):
 *     oq8-failwith-suggest-routing.test.ts pins the real producer strings.
 *   - The declared-code arm and the trailing leading-code arm: dictionary
 *     round-trip + adversarial-tail invariants in oq8 already cover both.
 *
 * Modeling notes. Silent omission is the failure mode this file exists to
 * kill, and after four rounds of the same bug class the rule is now stated
 * once, as an invariant of the EXTRACTION itself: every piece of condition
 * syntax is (a) modeled, or (b) dropped from the routing model WITH an
 * owner-and-shape pin that fails when it moves, appears, or disappears, or
 * (c) bails the extraction loudly. Nothing leaves the model without a pin.
 * Concretely: literals → modeled; compound (&&) shapes → modeled AND
 * shape-pinned; wrapper-immune disjuncts → dropped AND ownership-pinned AND
 * behaviorally pinned on their own messages (Round 13 closed this, the last
 * unpinned drop); any other syntax → bail.
 *   - Round 14 (Codex P2, measured): the previous extraction was a regex +
 *     hand-rolled tokenizer over a marker-delimited source region, and its
 *     completeness guarantee was five REGEX COUNTS agreeing — a guarantee
 *     that only held for the formatting the regexes assumed. A tail arm
 *     written as `} else if (m.endsWith("legacy condition")) return
 *     classify("disabled");` has no line-leading `if`, no line-leading
 *     `return`, and no `return {` — it slipped past the arm regex AND all
 *     five counts, 8/8 green, while production rerouted the message. The
 *     extraction is now an AST WALK of classify() via the TypeScript
 *     compiler API: the PARSER enumerates every statement, so formatting can
 *     hide nothing, and the five counts are retired. What replaces them is a
 *     total statement model — every statement of the classify body is either
 *     (a) one of the four frame shapes, exact-pinned by position and shape
 *     (the `const declared` + declared-code guard arm, `const m =
 *     message.toLowerCase()`, the `const leadingCode` + leading-code guard
 *     arm, the final `return { code: "ToolError" … }`; the two guard arms'
 *     ROUTING behavior is separately pinned end-to-end by oq8's dictionary
 *     round-trip + adversarial-tail invariants), or (b) a cascade `if` /
 *     `else if` chain link captured as an arm (flattening is sound because
 *     every arm body is proven to be a lone return), or (c) a loud bail:
 *     unmodeled statement kinds (switch / for / a stray declaration), else
 *     branches that are not another `if`, arm bodies that are not a single
 *     `return { code: "…" }` object literal of plain properties (a spread
 *     could override `code` at runtime), and condition expressions outside
 *     the modeled grammar all fail the extraction by name.
 *   - Conditions are turned into disjunctive normal form from the AST
 *     expression nodes: each arm becomes a list of FIRING SETS, where a set
 *     fires iff every token in it is present. `a || b` yields {a},{b};
 *     `a && (b || c)` yields {a,b},{a,c}. Compound arms therefore participate
 *     in every rule below. Round 11 (Codex P2): the pre-DNF version skipped
 *     `&&` conditions wholesale, so grafting an independent
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
 *     both), accepted by the condition walk ONLY in exactly these two shapes
 *     and ONLY as a whole disjunct; any other non-includes predicate (any
 *     other startsWith argument included — that closes Round 12's mutation C
 *     at the grammar, not at a count), or an immune predicate conjoined into
 *     a `&&` set (where dropping it would silently erase the set from the
 *     model), fails the extraction loudly.
 *     Round 13 (Codex P2, measured): dropping the whole disjunct SILENTLY was
 *     itself a hole — grafting `|| m === "disabled"` onto the
 *     BrowserNotConnected arm (which already owns reachable firing sets) kept
 *     the compound-shape pin and all six routing rules green while production
 *     rerouted the real "disabled" message to BrowserNotConnected. Dropped
 *     disjuncts are therefore RECORDED per arm and exact-pinned to their
 *     owner arm in the preconditions, plus routed end-to-end on the very
 *     messages WRAP cannot synthesize ("disabled", "guard failed …").
 *   - Comments: the AST discards them, so a comment anywhere — including
 *     inside an arm's condition parentheses — can no longer hide anything
 *     from the model. This retires Round 13's tokenizer-churn caution (the
 *     string tokenizer had no comment syntax and bailed on them).
 *   - TRUST ANCHOR, moved and shrunk (Round 14): Round 12's known limit was
 *     that an arm added OUTSIDE the two string markers (`const m = …` /
 *     `const leadingCode`) was invisible in principle. The walk now starts at
 *     classify()'s FIRST statement and ends at its LAST, and every statement
 *     is modeled, frame-pinned, or bailed — so for the classify body that
 *     limit is RESOLVED: there is no position inside the function where a
 *     statement can sit unseen. What remains out of view is routing done
 *     OUTSIDE classify() — in failWith / errorFromMessage before classify
 *     runs, or a hypothetical second classifier — plus the SUGGESTS table
 *     contents themselves; the anchor is now the single FunctionDeclaration
 *     named `classify` in _errors.ts (the extraction bails if that name
 *     stops resolving to exactly one function with a body), and the seams
 *     around it belong to the oq8 end-to-end suites.
 *   - Extraction is LAZY (memoized `getArms()`), invoked first by a dedicated
 *     named test: in Round 12 it ran at module scope, so a break surfaced as
 *     a file-collection error ("no tests") instead of naming what broke
 *     (measured in the mutation C run). A bail now fails that named test with
 *     the assertion message, and every later test re-runs the (cheap)
 *     extraction and fails too — the all-tests-fail property of module scope
 *     is kept without its diagnostics loss.
 *
 * Cost, measured at Round 11: 62 arms, 95 firing sets, 4,431 pairwise
 * messages; the whole file runs in ~0.6s (classify is pure string scanning),
 * so no pruning of the pair space was needed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
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

interface Arm {
  code: string;
  /**
   * Disjunctive normal form of the arm's condition, restricted to the
   * wrapper-reachable disjuncts: the arm fires on a synthesized message iff
   * every token of SOME set is a substring of it.
   */
  sets: string[][];
  /**
   * Source spellings of the wrapper-immune disjuncts DROPPED from `sets`,
   * in occurrence order. A drop is never silent (Round 13): the ownership
   * precondition exact-pins which arm may carry which immune disjunct.
   */
  immune: string[];
  condition: string;
}

/** Loud extraction failure — thrown at module load, fails the whole suite. */
function bail(message: string): never {
  throw new Error(`classify-cascade extraction: ${message}`);
}

/** Human-readable node kind for bail messages. */
const kindName = (node: ts.Node): string => ts.SyntaxKind[node.kind] ?? String(node.kind);

/**
 * DNF of one arm condition, built from the AST expression nodes. Every node
 * must be a known form — a new predicate shape (a regex test, a helper call,
 * a renamed variable, a different `startsWith` argument) bails loudly, never
 * silently drops. `&&` distributes as the cross product of the operand DNFs,
 * so `a && (b || c)` becomes [{a,b},{a,c}]. `countLiteral` is invoked once
 * per SOURCE literal (pre-cross-product), feeding the sanity floor.
 */
function conditionToDnf(
  expr: ts.Expression,
  code: string,
  sf: ts.SourceFile,
  countLiteral: () => void,
): Atom[][] {
  if (ts.isParenthesizedExpression(expr)) {
    return conditionToDnf(expr.expression, code, sf, countLiteral);
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken) {
      return [
        ...conditionToDnf(expr.left, code, sf, countLiteral),
        ...conditionToDnf(expr.right, code, sf, countLiteral),
      ];
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = conditionToDnf(expr.left, code, sf, countLiteral);
      const right = conditionToDnf(expr.right, code, sf, countLiteral);
      return left.flatMap((l) => right.map((r) => [...l, ...r]));
    }
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(expr.left) &&
      expr.left.text === "m" &&
      ts.isStringLiteral(expr.right) &&
      expr.right.text === "disabled"
    ) {
      // Canonical spelling, not getText(): the ownership pin below must stay
      // formatting-independent too.
      return [[{ kind: "immune", src: 'm === "disabled"' }]];
    }
    bail(
      `unmodeled binary expression in the ${code} arm: ${expr.getText(sf).slice(0, 60)}`,
    );
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "m" &&
    expr.arguments.length === 1 &&
    ts.isStringLiteral(expr.arguments[0]!)
  ) {
    const method = expr.expression.name.text;
    const arg = (expr.arguments[0] as ts.StringLiteral).text;
    if (method === "includes") {
      countLiteral();
      return [[{ kind: "lit", value: arg }]];
    }
    if (method === "startsWith" && arg === "guard failed") {
      return [[{ kind: "immune", src: 'm.startsWith("guard failed")' }]];
    }
    bail(`unmodeled predicate m.${method}(${JSON.stringify(arg)}) in the ${code} arm`);
  }
  bail(
    `unmodeled ${kindName(expr)} in the ${code} arm condition: ${expr.getText(sf).slice(0, 60)}`,
  );
}

/**
 * The arm body must be a single `return { code: "…", … }` of plain property
 * assignments; the string code is returned. `return classify(…)` (Round 12's
 * mutation C, Round 14's mutation E), a helper delegation, a computed code, a
 * spread that could override `code` at runtime, or extra statements all bail.
 */
function armReturnCode(body: ts.Statement, sf: ts.SourceFile): string {
  let ret: ts.Statement = body;
  if (ts.isBlock(ret)) {
    if (ret.statements.length !== 1) {
      bail(
        `an arm body must be a single return statement, got ${ret.statements.length} statements: ${ret.getText(sf).slice(0, 80)}`,
      );
    }
    ret = ret.statements[0]!;
  }
  if (!ts.isReturnStatement(ret) || ret.expression === undefined) {
    bail(`an arm body must be a return statement, got ${kindName(ret)}: ${ret.getText(sf).slice(0, 80)}`);
  }
  const obj = ret.expression;
  if (!ts.isObjectLiteralExpression(obj)) {
    bail(
      `an arm must return an object literal, got ${kindName(obj)}: ${obj.getText(sf).slice(0, 80)}`,
    );
  }
  let code: string | undefined;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      bail(
        `non-plain property in an arm return (a spread could override "code" at runtime): ${prop.getText(sf).slice(0, 80)}`,
      );
    }
    if (prop.name.text === "code") {
      if (!ts.isStringLiteral(prop.initializer)) {
        bail(`an arm's code must be a string literal, got: ${prop.initializer.getText(sf).slice(0, 80)}`);
      }
      if (code !== undefined) bail(`duplicate code property in an arm return: ${obj.getText(sf).slice(0, 80)}`);
      code = prop.initializer.text;
    }
  }
  if (code === undefined) {
    bail(`an arm return carries no code property: ${obj.getText(sf).slice(0, 80)}`);
  }
  return code;
}

/** Single-declaration `const <name> = …` matcher for the frame statements. */
function singleConstNamed(s: ts.Statement | undefined, name: string): ts.VariableDeclaration | undefined {
  if (s === undefined || !ts.isVariableStatement(s)) return undefined;
  const decls = s.declarationList.declarations;
  if (decls.length !== 1) return undefined;
  const d = decls[0]!;
  return ts.isIdentifier(d.name) && d.name.text === name ? d : undefined;
}

/**
 * `if (<name> && Object.hasOwn(SUGGESTS, <name>)) { return …; }` — the two
 * frame guard arms (declared-code / leading-code). Only the frame SHAPE is
 * pinned here, so nothing else can stand in their position; their ROUTING
 * behavior is pinned end-to-end by oq8's dictionary round-trip and
 * adversarial-tail invariants.
 */
function expectSuggestsGuardArm(s: ts.Statement | undefined, name: string, sf: ts.SourceFile): void {
  const shapeOk = ((): boolean => {
    if (s === undefined || !ts.isIfStatement(s) || s.elseStatement !== undefined) return false;
    const c = s.expression;
    if (!ts.isBinaryExpression(c) || c.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) {
      return false;
    }
    if (!ts.isIdentifier(c.left) || c.left.text !== name) return false;
    const call = c.right;
    if (!ts.isCallExpression(call) || call.arguments.length !== 2) return false;
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "Object") return false;
    if (callee.name.text !== "hasOwn") return false;
    const dict = call.arguments[0]!;
    const key = call.arguments[1]!;
    if (!ts.isIdentifier(dict) || dict.text !== "SUGGESTS") return false;
    if (!ts.isIdentifier(key) || key.text !== name) return false;
    const body = s.thenStatement;
    return ts.isBlock(body) && body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!);
  })();
  if (!shapeOk) {
    bail(
      `the ${name} frame arm is not in its pinned shape at: ${(s?.getText(sf) ?? "<missing>").slice(0, 80)}`,
    );
  }
}

/**
 * Substring arms of classify(), walked from the AST in execution order. The
 * walk covers the ENTIRE function body: frame statements are exact-pinned by
 * position and shape, everything between `const m` and `const leadingCode`
 * must be a cascade arm chain, and anything else bails (see the header).
 */
function extractCascade(): Arm[] {
  const src = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "tools", "_errors.ts"),
    "utf8",
  );
  const sf = ts.createSourceFile("_errors.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classifyDecls = sf.statements.filter(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name !== undefined && s.name.text === "classify",
  );
  if (classifyDecls.length !== 1 || classifyDecls[0]!.body === undefined) {
    bail(
      `the trust anchor broke: expected exactly one classify() declaration with a body, found ${classifyDecls.length}`,
    );
  }
  const stmts = classifyDecls[0]!.body.statements;
  const at = (idx: number): ts.Statement | undefined => stmts[idx];

  // ── Frame head: `const declared` + its guard arm + `const m` — pinned by
  // position AND shape, so no routing statement can hide above the cascade.
  let i = 0;
  if (singleConstNamed(at(i), "declared") === undefined) {
    bail(`classify() must open with \`const declared = …\`, got: ${(at(i)?.getText(sf) ?? "<missing>").slice(0, 80)}`);
  }
  i += 1;
  expectSuggestsGuardArm(at(i), "declared", sf);
  i += 1;
  // `const m = message.toLowerCase();` — the model's lowercase assumption is
  // pinned structurally (a switch to a different normalization must bail).
  const mInit = singleConstNamed(at(i), "m")?.initializer;
  const mShapeOk =
    mInit !== undefined &&
    ts.isCallExpression(mInit) &&
    mInit.arguments.length === 0 &&
    ts.isPropertyAccessExpression(mInit.expression) &&
    ts.isIdentifier(mInit.expression.expression) &&
    mInit.expression.expression.text === "message" &&
    mInit.expression.name.text === "toLowerCase";
  if (!mShapeOk) {
    bail(`expected \`const m = message.toLowerCase();\`, got: ${(at(i)?.getText(sf) ?? "<missing>").slice(0, 80)}`);
  }
  i += 1;

  // ── The cascade: every statement until `const leadingCode` must be an arm
  // chain — the parser enumerates them, so formatting can hide nothing.
  const arms: Arm[] = [];
  let literalTokenCount = 0;
  const countLiteral = (): void => {
    literalTokenCount += 1;
  };
  for (; i < stmts.length && singleConstNamed(at(i), "leadingCode") === undefined; i += 1) {
    const stmt = at(i)!;
    if (!ts.isIfStatement(stmt)) {
      bail(`unmodeled ${kindName(stmt)} inside the cascade: ${stmt.getText(sf).slice(0, 80)}`);
    }
    // Flatten the if / else-if chain: because every arm body is proven to be
    // a lone return, `else if` is semantically identical to a sequential
    // `if` — and an else branch that is NOT another if (a block, a bare
    // statement, a delegation) is unmodeled and bails.
    let link: ts.Statement | undefined = stmt;
    while (link !== undefined) {
      if (!ts.isIfStatement(link)) {
        bail(`unmodeled else branch (${kindName(link)}) in the cascade: ${link.getText(sf).slice(0, 80)}`);
      }
      const code = armReturnCode(link.thenStatement, sf);
      const sets: string[][] = [];
      const immune: string[] = [];
      for (const set of conditionToDnf(link.expression, code, sf, countLiteral)) {
        const immuneAtom = set.find(
          (a): a is Extract<Atom, { kind: "immune" }> => a.kind === "immune",
        );
        if (immuneAtom) {
          // A wrapper-immune predicate may only stand as a WHOLE disjunct:
          // WRAP defeats it (asserted mechanically in the preconditions), so
          // the disjunct contributes nothing to wrapper-reachable routing and
          // is dropped from `sets`. Conjoined with literals it would erase
          // those literals from the model too — that shape must be decided
          // here, not vanish. Round 13 (Codex P2): the drop itself is
          // RECORDED, never silent — the ownership precondition exact-pins
          // where each immune disjunct may live, so grafting one onto any
          // other arm (a real production routing change, measured) fails
          // loudly there.
          if (set.length !== 1) {
            bail(`immune predicate conjoined with other predicates in the ${code} arm`);
          }
          immune.push(immuneAtom.src);
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
      arms.push({ code, sets, immune, condition: link.expression.getText(sf) });
      link = link.elseStatement;
    }
  }

  // ── Frame tail: `const leadingCode` + its guard arm + the ToolError
  // fallback — pinned by position AND shape, and nothing may follow.
  if (i >= stmts.length) {
    bail("the `const leadingCode` frame marker is missing from classify()");
  }
  i += 1; // the leadingCode declaration itself — routing pinned by oq8's adversarial-tail invariants.
  expectSuggestsGuardArm(at(i), "leadingCode", sf);
  i += 1;
  const fallback = at(i);
  if (fallback === undefined || !ts.isReturnStatement(fallback)) {
    bail(
      `classify() must end with the ToolError fallback return, got: ${(fallback?.getText(sf) ?? "<missing>").slice(0, 80)}`,
    );
  }
  const fallbackCode = armReturnCode(fallback, sf);
  if (fallbackCode !== "ToolError") {
    bail(`the fallback return's code is ${JSON.stringify(fallbackCode)}, expected "ToolError"`);
  }
  i += 1;
  if (i !== stmts.length) {
    bail(`unmodeled trailing statement after the ToolError fallback: ${at(i)!.getText(sf).slice(0, 80)}`);
  }

  // Sanity floors (62 arms / 96 literal tokens at Round 11): a drastic drop
  // means the walk landed on the wrong function, not that the cascade shrank.
  expect(arms.length).toBeGreaterThanOrEqual(55);
  expect(literalTokenCount).toBeGreaterThanOrEqual(80);

  return arms;
}

/**
 * Lazy + memoized extraction: Round 12 ran this at module scope, so a bail
 * failed the FILE COLLECTION ("no tests") instead of naming what broke.
 * Called first from the dedicated extraction test below; a failure re-throws
 * in every later test too (extraction is ~ms, so the unmemoized failure path
 * costs nothing), keeping the everything-fails property without the
 * diagnostics loss.
 */
let extracted: Arm[] | undefined;
const getArms = (): Arm[] => (extracted ??= extractCascade());

// ── Pure model of the extracted cascade ─────────────────────────────────────
const armFires = (arm: Arm, msg: string) => arm.sets.some((s) => s.every((t) => msg.includes(t)));
const modelRoute = (msg: string) => getArms().find((a) => armFires(a, msg));
const setMessage = (set: string[]) => WRAP + set.join(SEP);
const pairMessage = (earlier: string[], later: string[]) =>
  WRAP + earlier.join(SEP) + SEP + later.join(SEP);

describe("classify substring cascade — extraction", () => {
  it("walks the whole classify() AST with every statement modeled, frame-pinned, or bailed (named test so a bail is diagnosable, not a collection error)", () => {
    // The frame-shape pins, the total statement walk, every condition /
    // arm-body bail, and the sanity floors all run inside extractCascade();
    // first invocation is HERE so a break fails this test with the offending
    // bail message (Round 13 — Round 12's module-scope run reported mutation
    // C as "no tests").
    expect(getArms().length).toBeGreaterThanOrEqual(55);
  });
});

describe("classify substring cascade — structural preconditions", () => {
  it("tokens are unique across arms, cannot fuse across the separator, and WRAP defeats the immune predicates", () => {
    const arms = getArms();
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
    const compound = getArms().filter((a) => a.sets.some((s) => s.length > 1));
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

  it("wrapper-immune disjuncts are exact-pinned to their owner arms and route to them end-to-end", () => {
    // Round 13 (Codex P2, measured): the model DROPS immune disjuncts (WRAP
    // defeats them — justified mechanically above), so a mutation that grafts
    // `|| m === "disabled"` onto the BrowserNotConnected arm changed nothing
    // in the model: the compound-shape pin kept its shape, all six routing
    // rules stayed green — yet production rerouted the real "disabled"
    // message from ElementDisabled to BrowserNotConnected. The general rule
    // (see header): whatever the model drops must be pinned by owner and
    // shape. This map (owner code → immune spellings, per-arm occurrence
    // order) fails on ANY immune-disjunct add / move / removal / duplication
    // and forces a conscious classifier decision.
    const ownership = Object.fromEntries(
      getArms()
        .filter((a) => a.immune.length > 0)
        .map((a) => [a.code, a.immune]),
    );
    expect(
      ownership,
      "an immune disjunct moved arms (or appeared/disappeared) — this is a real routing change for the unwrapped message shapes; update this pin CONSCIOUSLY",
    ).toEqual({
      GuardFailed: ['m.startsWith("guard failed")'],
      ElementDisabled: ['m === "disabled"'],
    });
    // Behavioral teeth for the very shapes WRAP cannot synthesize: each immune
    // predicate's own message must reach its owner arm with advice. This is
    // the end-to-end behavior the mutation above actually regressed.
    const disabled = render("disabled"); // exactly `m === "disabled"` — no substring arm matches the bare word
    expect(disabled.code).toBe("ElementDisabled");
    expect((disabled.suggest ?? []).length).toBeGreaterThan(0);
    const guard = render("guard failed for lens"); // no colon, no "guardfailed" — only the startsWith disjunct fires
    expect(guard.code).toBe("GuardFailed");
    expect((guard.suggest ?? []).length).toBeGreaterThan(0);
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
    for (const arm of getArms()) {
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
    const arms = getArms();
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
    for (const arm of getArms()) {
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
    const arms = getArms();
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
