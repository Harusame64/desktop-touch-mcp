/**
 * ## This tree's TypeScript, read by the compiler that ships with it
 *
 * Every reader under `scripts/lib/` has been a hand-written character scanner: regular expressions
 * and walks over a masked copy, deciding where a literal ends, where a comment ends, which `)`
 * closes a header, which property sits at depth one. **TypeScript is not a regular language, so
 * that line does not converge** — the defects found in #672, #674, #677, #678, #679 and #680 are
 * one lexing or syntax question each, and closing one opened the next. The repository's own note
 * for it is *enumerating spellings does not terminate*.
 *
 * `typescript` is a devDependency here and CI runs `npm ci` before these gates. The parser was in
 * `node_modules` the whole time; #679 even used `ts.createSourceFile` as the ORACLE that graded the
 * hand-written reader — twenty lines, exact over 2,124,147 characters, where the hand reader needed
 * four PRs and eight review rounds to reach the same answer. This module is that oracle promoted
 * from judge to reader.
 *
 * **What stays hand-written**: Rust and C# in `config-vocabulary.mjs`, and the PowerShell and JSON
 * embedded in string literals. There is no parser for those here, and that is where hand-written
 * grammar care is actually earned.
 *
 * ### Three rules this module keeps
 *
 * 1. **Syntax only — never `ts.createProgram` or the type checker.** One `createSourceFile` per
 *    file. A Program resolves `tsconfig`, type-checks, and costs seconds; it would answer the same
 *    questions while adding a new way to fail.
 * 2. **`createSourceFile` does not throw on broken input.** It returns a tree with fewer nodes and
 *    a `parseDiagnostics` list — which is the silent under-read this whole effort is against, one
 *    level up. Every entry point here reports it rather than returning a short answer quietly.
 * 3. **The lexing goes; the semantic rules stay.** "Which union does this template member draw
 *    from", "is this the helper forwarding its own parameter", "is this value one a caller can
 *    receive" are decisions about this tree, not about the language, and they are rewritten here at
 *    the same size they had.
 */
import ts from "typescript";

/**
 * Parse `source` as TypeScript, reporting a broken parse rather than answering short.
 *
 * `setParentNodes` is on because the semantic rules ask about ancestry — "is this call inside
 * `probeRoute`" is a walk up `parent`, where the hand reader balanced braces to find a function
 * body and got it wrong twice (#680 rounds 1 and 2).
 */
export function parseSource(source, fileName = "source.ts", problems = []) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const diagnostics = file.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const line = source.slice(0, first.start ?? 0).split("\n").length;
    problems.push(
      `${fileName} did not parse (${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}): ` +
        `line ${line}, ${ts.flattenDiagnosticMessageText(first.messageText, " ")} — everything read from it is a LOWER BOUND`,
    );
  }
  return file;
}

function scriptKindFor(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Every node in the file, parents first. */
export function* walk(node) {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}

/**
 * The exported `type <name> = …` declaration, or null.
 *
 * **Absent and unreadable are different answers**, and returning null for both is how a gate is
 * told an axis has no values instead of being told nothing. A declaration with this name that this
 * reader will not take — not exported, or written as an interface — is named before the null.
 */
function typeAliasNamed(file, name, problems = []) {
  let withheld = null;
  for (const statement of file.statements) {
    const isAlias = ts.isTypeAliasDeclaration(statement);
    if (!isAlias && !ts.isInterfaceDeclaration(statement)) continue;
    if (statement.name.text !== name) continue;
    if (!isAlias) {
      withheld ??= `${name} is declared as an interface here, and this reader reads type aliases — it is being read as ABSENT`;
      continue;
    }
    const exported = ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) return statement;
    withheld ??= `${name} is declared here but not exported, and this reader takes exported declarations only — it is being read as ABSENT`;
  }
  // Only the top-level statements are this file's exports. The same name declared inside a
  // `namespace` or a block is withheld too, and returning a bare null for it was the "absent" answer
  // to a question whose answer is "there, and not taken" (gate 2 on #681).
  if (withheld === null) {
    for (const node of walk(file)) {
      if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === name) {
        withheld = `${name} is declared here, but not at the top level of the file, and this reader takes top-level declarations only — it is being read as ABSENT`;
        break;
      }
    }
  }
  if (withheld !== null) problems.push(withheld);
  return null;
}

/**
 * The members of a union type, or the single type if it is not a union.
 *
 * **Parentheses are not a type**, they group one — `"a" | ("b" | "c")` has three members, and
 * `("b" | "c")` alone has two. Reading the `ParenthesizedTypeNode` as a member instead of what it
 * wraps dropped `b` and `c` while leaving `problems` empty, which is the silent under-read this
 * module exists to end (codex found it on the inline reader; the same node wrapping an object
 * member of the outer union lost a whole member the same way). The grammar says unwrap, so this
 * says unwrap, once, where every caller passes through.
 */
function unionMembers(node) {
  const members = [];
  const flatten = (n) => {
    // `(("b" | "c"))` is legal and means what `"b" | "c"` means. Unwrapping ONE level made the
    // rule depth-dependent, which is not what "parentheses group a type" says; a rule that holds
    // at depth one and not at depth two is a spelling, and spellings do not terminate here.
    let inner = n;
    while (ts.isParenthesizedTypeNode(inner)) inner = inner.type;
    if (ts.isUnionTypeNode(inner)) {
      for (const type of inner.types) flatten(type);
      return;
    }
    members.push(inner);
  };
  flatten(node);
  return members;
}

const stringLiteralType = (node) =>
  ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? node.literal.text : null;

/**
 * Is this member of a VALUE union the absence of a value — `undefined`, `null`, `never`?
 *
 * `why?: never` on one arm of a discriminated union, `why: "a" | undefined`, `why: "a" | null`
 * all say "no value here", and a vocabulary loses nothing by not listing them. Reporting them made
 * the gate red over a type that hides nothing (gate 2 on #681) — the same rule `carriesNoProperties`
 * keeps one level out. Deliberately NOT a numeric or boolean literal: `why: "a" | 1` is a value this
 * reader will not turn into a string, and that one is still named.
 *
 * **For a FIELD's union only.** A named union is also a template placeholder here —
 * `` `ground_disabled:${KeyboardGround}` `` — and inside a template `null` and `undefined` are
 * spelled out: `"ground_disabled:null"` is a value `tsc --strict` accepts. Dropping them from
 * `readUnion` answered short in silence, the defect this module exists to end, written by the fix
 * for the false red (gate 2 on #681, second pass). `readUnion` skips only `never`, which vanishes
 * in a template too.
 */
const holdsNoValue = (node) =>
  node.kind === ts.SyntaxKind.UndefinedKeyword ||
  node.kind === ts.SyntaxKind.NeverKeyword ||
  (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword);

/**
 * The quoted members of `export type <name> = "a" | "b" | …;`, expanding template members.
 *
 * Same contract as the hand-written reader it replaces: `null` when the declaration is absent, a
 * sorted unique array otherwise, and a `problems` entry for every member this parser will not turn
 * into a value — because **a shorter set is indistinguishable from a complete one**, which is the
 * failure the whole vocabulary exists to end.
 *
 * What the hand version needed and this does not: finding the declaration's end at a `;` "at brace
 * depth 0" on a masked copy, a thirty-nine character window onto the next declaration, and a
 * `[^;{}]` capture for the value. All three were defects (#679, and the re-read after it). Here the
 * declaration IS a node and its members ARE a list.
 */
export function readUnion(source, name, resolve = () => [], problems = [], fileName = "source.ts") {
  const file = parseSource(source, fileName, problems);
  const alias = typeAliasNamed(file, name, problems);
  if (alias === null) return null;

  const values = [];
  for (const member of unionMembers(alias.type)) {
    const literal = stringLiteralType(member);
    if (literal !== null) {
      values.push(literal);
      continue;
    }
    // `never` only — see `holdsNoValue` for why `null` and `undefined` are NOT the absence of a
    // value in a union that a template spells out.
    if (member.kind === ts.SyntaxKind.NeverKeyword) continue;
    // `` `ground_disabled:${KeyboardGround}` `` is a member, not decoration: expand it against the
    // union it names, or the count is short by however many that union has.
    if (ts.isTemplateLiteralTypeNode(member) && member.templateSpans.length === 1) {
      const span = member.templateSpans[0];
      const prefix = member.head.text;
      if (ts.isTypeReferenceNode(span.type) && ts.isIdentifier(span.type.typeName) && span.literal.text === "") {
        const referenced = span.type.typeName.text;
        const expanded = resolve(referenced);
        if (expanded.length === 0) problems.push(`${name}: cannot resolve the template member \`${prefix}\${${referenced}}\``);
        for (const suffix of expanded) values.push(`${prefix}${suffix}`);
        continue;
      }
    }
    problems.push(`${name}: member \`${memberText(file, member)}\` is not a quoted literal this parser reads`);
  }
  return [...new Set(values)].sort();
}

/** A member as it is written, for a message a reader can find in the file. */
function memberText(file, node) {
  return node.getText(file).trim();
}

/**
 * Every value of `field` across the members of `export type <typeName> = …`, at depth one.
 *
 * "Depth one" stops being a concept here: an object type's `members` ARE its depth-one properties,
 * so a `why` nested inside another member's object cannot be reached by accident. The hand version
 * counted braces on a masked copy to find the declaration's end and captured the value with
 * `[^;{}]`, and both were defects — a member holding `{` lost a value in silence, a member holding
 * `}` pulled in the next type's.
 */
export function readInlineFieldUnion(source, typeName, field, problems = [], fileName = "source.ts") {
  const file = parseSource(source, fileName, problems);
  const alias = typeAliasNamed(file, typeName, problems);
  if (alias === null) {
    problems.push(`${typeName} not found — the ${field} union it carries is not being read`);
    return [];
  }

  const values = [];
  let seen = false;
  for (const member of unionMembers(alias.type)) {
    if (!ts.isTypeLiteralNode(member)) {
      // **Not every skip is a silence.** A member that provably carries no properties contributes
      // no `field` and there is nothing to say about it. A member this parser cannot see INSIDE —
      // an intersection, a `Readonly<{…}>`, a reference to a type declared elsewhere — might carry
      // one, and skipping it quietly is how a denominator shrinks with the gate still green
      // (codex, round 2). It is named instead.
      if (!carriesNoProperties(member)) {
        problems.push(
          `${typeName}: member \`${memberText(file, member)}\` is not an object type this parser reads — ` +
            `any ${field} it carries is NOT in this answer`,
        );
      }
      continue;
    }
    for (const property of member.members) {
      // A call or construct signature — `(): void`, `new (): T` — has no name because it cannot
      // have one: it says how the object is called, and declares no property at all. Its emptiness
      // is a syntactic fact, the same kind `carriesNoProperties` keeps silent one level out, and
      // reporting it made the route gate red over a type that hides nothing (codex, round 3).
      if (ts.isCallSignatureDeclaration(property) || ts.isConstructSignatureDeclaration(property)) continue;
      // A name this parser cannot read is not a member it can rule out: an index signature has no
      // name at all, and a computed one is not a string here. Skipping those quietly is the same
      // silence as the member-level one, one level further in.
      const name = property.name === undefined ? null : propertyName(property.name);
      if (name === null) {
        problems.push(
          `${typeName}: a member of \`${memberText(file, member)}\` has a name this parser cannot read — ` +
            `any ${field} it carries is NOT in this answer`,
        );
        continue;
      }
      if (name !== field) continue;
      if (!ts.isPropertySignature(property) || property.type === undefined) {
        problems.push(`${typeName}.${field} is declared, but not as a property with a type this parser reads`);
        continue;
      }
      seen = true;
      for (const value of unionMembers(property.type)) {
        const literal = stringLiteralType(value);
        if (literal !== null) {
          values.push(literal);
          continue;
        }
        if (holdsNoValue(value)) continue;
        // The same contract `readUnion` keeps: a member this parser will not turn into a value is
        // named, because a shorter set and a complete one look alike from the gate's side.
        problems.push(`${typeName}.${field}: member \`${memberText(file, value)}\` is not a quoted literal this parser reads`);
      }
    }
  }
  if (!seen) {
    problems.push(`${typeName} has no ${field} field where one was expected`);
    return [];
  }
  if (values.length === 0) problems.push(`${typeName}.${field} read as empty — has it stopped being a union of literals?`);
  return [...new Set(values)].sort();
}

/**
 * Can this type be shown to hold no properties at all?
 *
 * Deliberately a short list of things whose emptiness is a syntactic fact — a quoted or numeric
 * literal, `true`/`false`/`null`, and the primitive keywords (`string`, `boolean`, `undefined`, …),
 * none of which is an object with fields. Everything else, including `any`, `unknown` and
 * `object`, answers NO: not because it necessarily carries the field, but because this
 * parser cannot say that it does not, and an unknown reported beats an unknown skipped.
 */
function carriesNoProperties(node) {
  if (ts.isLiteralTypeNode(node)) return true;
  // The primitive keywords are the literals' own types: `boolean` IS `true | false`, and reporting
  // the keyword while keeping the two literals silent was one fact with two answers (gate 2 on
  // #681). None of them is an object with fields.
  return PRIMITIVE_KEYWORDS.has(node.kind);
}

const PRIMITIVE_KEYWORDS = new Set([
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.SymbolKeyword,
]);

/** A property's name as written, whether it is an identifier or a quoted key. */
export function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  // `{ ["why"]: … }` is `{ why: … }` (gate 2 on #682: it was dropped in silence).
  if (ts.isComputedPropertyName(name)) {
    const key = skipParentheses(name.expression);
    if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  }
  return null;
}

// ── The road vocabulary ──────────────────────────────────────────────────────
//
// `readRoadVocabulary` in `route-vocabulary.mjs` answered this with regexes over comment-stripped
// text, a literal mask, a brace walk to find `probeRoute`'s body, a `[^{}]*` window for `landing`,
// and a file-wide regex for the one binding that forwards a refusal. Each was a position rule
// standing in for a fact the parse tree states outright. The design, its survey of the executor
// and win2's source check are in internal `docs/the-road-reader-on-the-parser.md`.
//
// **What an axis is, the pin already decided**: `rung`, `refused` and `why` are FIELD NAMES,
// collected wherever the executor writes them — the `act.identity` row's `rung`/`refused` and the
// `why` nested three levels inside `pointOwner` are pinned today (win2's B1/B2). Only `route` is
// scoped, because it is the field that names the road.

/** The producers whose arguments ARE the vocabulary, by position. */
const ROAD_PRODUCERS = {
  probeRoute: { route: 0 },
  probedStep: { rung: 0 },
  refusal: { rung: 0, refused: 1 },
  probeRefusal: { rung: 0, refused: 1 },
};
const ROW_FIELDS = new Set(["rung", "refused", "why"]);
const ROAD_FIELDS = new Set(["route", "rung", "refused", "why"]);
const VOCABULARY_WORD = /^[a-z0-9_]+$/;

/** A literal in this vocabulary's spelling, or null. */
function vocabularyLiteral(node) {
  if (node === undefined) return null;
  const inner = skipParentheses(node);
  if (!ts.isStringLiteral(inner) && !ts.isNoSubstitutionTemplateLiteral(inner)) return null;
  return VOCABULARY_WORD.test(inner.text) ? inner.text : null;
}

/**
 * The expression a value's wrappers hold. `"uia" as const`, `x!`, `(<T>x)` and `x satisfies T` are
 * the same value as `x`, and the scanner read `"w" as const` by its prefix — unwrapping only
 * parentheses reported it as a non-literal, a false red (gate 2 on #682).
 */
function skipParentheses(node) {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * The name a call is made BY: `refusal(…)` and `this.refusal(…)` are the same producer. The
 * scanner's `\brefusal\(` matched both; reading only a bare identifier dropped the method form in
 * silence (gate 2 on #682). An alias (`const go = probeRoute`) or `.call` is not followed — see the
 * PR for the surfaces this reader does not see.
 */
function calleeName(call) {
  const callee = skipParentheses(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return null;
}

const isAbsence = (node) => {
  const inner = skipParentheses(node);
  return inner.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(inner) && inner.text === "undefined");
};

/** The function a node sits in — a declaration, or an arrow/function expression. */
function enclosingFunction(node) {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionDeclaration(at) || ts.isArrowFunction(at) || ts.isFunctionExpression(at) || ts.isMethodDeclaration(at)) {
      return at;
    }
  }
  return null;
}

/** A function's name: its own, or — for `const refusal = (…) => …` — the binding's. */
function functionName(fn) {
  if (fn.name !== undefined && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}

const parameterNamed = (fn, name) =>
  fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name) ?? null;

/** Does the body of `fn` write to the name — `x = …`, `x ??= …`, `x++`? */
function assignedIn(fn, name) {
  for (const node of walk(fn.body ?? fn)) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(skipParentheses(node.left)) &&
      skipParentheses(node.left).text === name
    ) {
      return true;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      node.operand.text === name
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The variable declaration an identifier refers to, by block scope, up to its function's boundary;
 * null for a parameter, or for anything declared outside the function.
 */
function declarationOf(identifier) {
  for (let at = identifier.parent; at !== undefined; at = at.parent) {
    const statements =
      ts.isBlock(at) || ts.isSourceFile(at) || ts.isCaseClause(at) || ts.isDefaultClause(at) || ts.isModuleBlock(at) ? at.statements : null;
    if (statements !== null) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const d of statement.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === identifier.text) return d;
        }
      }
    }
    if (ts.isFunctionLike(at)) return null;
  }
  return null;
}

/** Every member of a type annotation, if all of them are vocabulary literals; otherwise null. */
function literalMembers(typeNode) {
  const members = unionMembers(typeNode);
  const values = members.map(stringLiteralType);
  return values.every((v) => v !== null && VOCABULARY_WORD.test(v)) ? values : null;
}

const oneLine = (file, node) => node.getText(file).replace(/\s+/g, " ").trim().slice(0, 60);
const lineOf = (file, node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

/**
 * The road vocabulary as the executor writes it — the same answer shape as the scanner's
 * `readRoadVocabulary`, read off the parse tree.
 *
 * `problems` carries anything that would make the extraction lie. Every rule below either reads a
 * value, recognises a forward whose values are read elsewhere, or says it could not.
 */
export function readRoadVocabulary(source, resolveUnion = () => [], fileName = "desktop-executor.ts") {
  const problems = [];
  const file = parseSource(source, fileName, problems);

  const route = new Set();
  const rung = new Set();
  const refused = new Set();
  const why = new Set();
  const sets = { route, rung, refused, why };
  const dynamicWhy = new Set();
  const landingLiteralWhy = new Set();
  let landingDrawsFromTheUnion = false;

  // ── Functions by name, and which of their parameters a producer forwards ──
  const functions = new Map();
  for (const node of walk(file)) {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const name = functionName(node);
      if (name !== null && !functions.has(name)) functions.set(name, node);
    }
  }

  /**
   * **Rule F — a forward.** An identifier standing for a road field is accepted iff it is a
   * PARAMETER of the function it sits in, and that function's values for the field are read
   * somewhere this reader looks: its call sites put the field in a position `ROAD_PRODUCERS` reads,
   * or the parameter's annotation is a union of vocabulary literals (collected here, for `why`).
   * Containment by the parse tree, keyed on the binding — not a brace walk, not a spelling.
   */
  const forwards = (identifier, field) => {
    const fn = enclosingFunction(identifier);
    if (fn === null) return false;
    const parameter = parameterNamed(fn, identifier.text);
    if (parameter === null) return false;
    // A parameter the body writes to is not what the caller passed: `refused = pickAny()` inside
    // `probeRefusal` made `{ rung, refused }` carry a value no call site spells (gate 2 on #682).
    if (assignedIn(fn, identifier.text)) return false;
    const name = functionName(fn);
    const positions = name === null ? undefined : ROAD_PRODUCERS[name];
    if (positions !== undefined && positions[field] === fn.parameters.indexOf(parameter)) return true;
    // **The annotation is read HERE, and only here** — as the values of a forward this rule has
    // just accepted. Reading every `why:` annotation in the file counted type DECLARATIONS as values
    // the executor writes (win2, internal `b660d03`: a type literal's field and an unrelated
    // parameter both came back as road whys, one of them silently).
    const members = parameter.type === undefined ? null : literalMembers(parameter.type);
    if (members === null) return false;
    for (const v of members) sets[field].add(v);
    return true;
  };

  /** Why a forward was refused, in the words the reader is looking for. */
  const refusedForward = (identifier, field) => {
    const fn = enclosingFunction(identifier);
    const parameter = fn === null ? null : parameterNamed(fn, identifier.text);
    if (parameter?.type !== undefined && ts.isUnionTypeNode(parameter.type)) {
      return `a ${field} union is not all quoted literals: ${oneLine(file, parameter.type)}`;
    }
    return null;
  };

  /**
   * `probedStep` hands `probeRefusal` a LOCAL `refused`, not a parameter, so Rule F cannot see it.
   * The grounds are read out of `adr029Refusal`'s body instead — which is only true while the local
   * IS `adr029Refusal(<identifier>)` and nothing else. A `const` declaration, in the same function;
   * an annotation is not a change of binding (win2, internal `f493bad`), and a `??`, `||`, ternary
   * or `let` lifts the exemption, because then the local holds something the body does not return.
   */
  let refusalBindingUsed = false;
  const bindsTheReadRefusal = (identifier) => {
    const fn = enclosingFunction(identifier);
    if (fn === null || identifier.text !== "refused") return false;
    // **The declaration this identifier REFERS to**, found by scope — not the first `refused` in
    // document order. A `const refused = adr029Refusal(err)` inside an `if` block, followed by an
    // outer `const refused = pickAnyGround(err)` passed on, was exempted by the name-matching
    // version (gate 2 on #682) — the spelling hole this reader was written to close.
    const declaration = declarationOf(identifier);
    if (declaration === null || enclosingFunction(declaration) !== fn) return false;
    if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
    const init = declaration.initializer === undefined ? undefined : skipParentheses(declaration.initializer);
    const binds =
      init !== undefined &&
      ts.isCallExpression(init) &&
      calleeName(init) === "adr029Refusal" &&
      init.arguments.length === 1 &&
      ts.isIdentifier(init.arguments[0]);
    if (binds) refusalBindingUsed = true;
    return binds;
  };

  /** Read a row field's value: a literal, a conditional of literals and absences, or a forward. */
  const readValue = (field, value, report) => {
    const inner = skipParentheses(value);
    const literal = vocabularyLiteral(inner);
    if (literal !== null) {
      sets[field].add(literal);
      return;
    }
    if (ts.isConditionalExpression(inner)) {
      // **Both branches.** The scanner's `?` rule read the literal after `?` only.
      for (const branch of [inner.whenTrue, inner.whenFalse]) {
        if (isAbsence(branch)) continue;
        readValue(field, branch, report);
      }
      return;
    }
    if (ts.isIdentifier(inner) && forwards(inner, field)) return;
    if (field === "why" && ts.isPropertyAccessExpression(inner) && inner.name.text === "why") {
      const owner = skipParentheses(inner.expression);
      const base = ts.isPropertyAccessExpression(owner) ? owner.name.text : ts.isIdentifier(owner) ? owner.text : null;
      // One dynamic `why` each, drawn from a named union the CALLER resolves (it has the files).
      if (base === "homing") return void dynamicWhy.add("homing.why");
      if (base === "owner") return void dynamicWhy.add("owner.why");
    }
    report(inner);
  };

  // ── Every node, once ──
  const inLanding = new Set();
  for (const node of walk(file)) {
    // The producers' positional arguments.
    const callee = ts.isCallExpression(node) ? calleeName(node) : null;
    if (callee !== null) {
      const positions = ROAD_PRODUCERS[callee];
      if (positions !== undefined) {
        for (const [field, index] of Object.entries(positions)) {
          const arg = node.arguments[index];
          if (arg === undefined) {
            problems.push(`${callee} is given a non-literal: (no ${field} argument)`);
            continue;
          }
          // The same reading a row field gets — a literal, a conditional of literals (both roads are
          // producible), or a forward — so the two places a value can be written obey one rule.
          let unreadable = false;
          readValue(field, arg, () => {
            unreadable = true;
          });
          if (!unreadable) continue;
          const inner = skipParentheses(arg);
          if (ts.isIdentifier(inner) && field === "refused" && bindsTheReadRefusal(inner)) continue;
          if (ts.isIdentifier(inner) && field === "refused" && inner.text === "refused") {
            const fn = enclosingFunction(inner);
            problems.push(
              `${(fn && functionName(fn)) ?? "a function"} no longer forwards \`const refused = adr029Refusal(err);\` — ` +
                "the grounds read out of that function are not the grounds written",
            );
          }
          const args = node.arguments.map((a) => a.getText(file)).join(", ").replace(/\s+/g, " ").slice(0, 60);
          problems.push(`${callee} is given a non-literal${index === 0 ? "" : ` ${field}`}: ${args}`);
        }
      }
      // `probeAim("act.route", { … })` — the road named on the row itself.
      if (callee === "probeAim" && node.arguments[0] !== undefined) {
        // `"act.route"`, `` `act.route` `` and `("act.route")` are one row kind (gate 2 on #682: the
        // two wrapped spellings dropped the row's road in silence). A kind held in a variable is not
        // read — see the PR for the surfaces this reader does not see.
        const first = skipParentheses(node.arguments[0]);
        if ((ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && first.text === "act.route") readActRoute(node);
      }
    }

    // `landing: { … }` — a different axis wearing the same field name. Its direct `why` is the
    // landing's; the subtree is marked so the road-why rule below skips it (scoped, where the
    // scanner subtracted globally and would have deleted a road why of the same spelling).
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "landing" && ts.isObjectLiteralExpression(skipParentheses(node.initializer))) {
      const object = skipParentheses(node.initializer);
      for (const inner of walk(object)) inLanding.add(inner);
      for (const property of object.properties) {
        // A shorthand `why` or a spread in a landing object carries a landing why this parser cannot
        // read, and it used to fall through both axes in silence (gate 2 on #682).
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === "why") {
          problems.push(`a landing why is not a literal: ${property.name.text} (shorthand)`);
          continue;
        }
        if (ts.isSpreadAssignment(property)) {
          problems.push(`a landing object spreads \`${oneLine(file, property.expression)}\` — a why in it is on neither axis`);
          continue;
        }
        if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== "why") continue;
        const value = skipParentheses(property.initializer);
        const literal = vocabularyLiteral(value);
        if (literal !== null) landingLiteralWhy.add(literal);
        else if (ts.isPropertyAccessExpression(value) && value.name.text === "why" && ts.isIdentifier(value.expression) && value.expression.text === "verdict") {
          landingDrawsFromTheUnion = true;
        } else problems.push(`a landing why is not a literal: ${oneLine(file, value)}`);
      }
      continue;
    }
    if (inLanding.has(node)) {
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && propertyName(node.name) === "why" && node.parent.parent !== undefined && !(ts.isPropertyAssignment(node.parent.parent) && propertyName(node.parent.parent.name) === "landing")) {
        problems.push(`a why nested inside a landing object is on neither axis: ${oneLine(file, node)}`);
      }
      continue;
    }

    // Row fields, wherever the executor writes them — an object's property, or an assignment to
    // one (`facts.why = …`, `row["rung"] = …`; gate 2 on #682: both were dropped in silence).
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = skipParentheses(node.left);
      const field = ts.isPropertyAccessExpression(target)
        ? target.name.text
        : ts.isElementAccessExpression(target) && (ts.isStringLiteral(target.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(target.argumentExpression))
          ? target.argumentExpression.text
          : null;
      if (field !== null && ROW_FIELDS.has(field)) {
        readValue(field, node.right, (inner) => problems.push(`a ${field} is not a literal: ${oneLine(file, inner)}`));
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const field = propertyName(node.name);
      if (field !== null && ROW_FIELDS.has(field)) {
        readValue(field, node.initializer, (inner) =>
          problems.push(`a ${field} is not a literal: ${oneLine(file, inner)}`),
        );
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const field = node.name.text;
      if (ROW_FIELDS.has(field) && !forwards(node.name, field) && !(field === "refused" && bindsTheReadRefusal(node.name))) {
        problems.push(
          refusedForward(node.name, field) ?? `a shorthand \`${field}\` is not a forward this parser can read: line ${lineOf(file, node)}`,
        );
      }
    }
  }

  function readActRoute(call) {
    const line = lineOf(file, call);
    const object = call.arguments[1] === undefined ? undefined : skipParentheses(call.arguments[1]);
    if (object === undefined || !ts.isObjectLiteralExpression(object)) {
      problems.push(`probeAim("act.route", …) at line ${line} is not given an object literal — its road is unknown, not absent`);
      return;
    }
    const own = object.properties.filter(
      (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propertyName(p.name) === "route",
    );
    if (own.length === 0) {
      problems.push(`probeAim("act.route", …) at line ${line} carries no \`route\` of its own — a nested one is not this call's road`);
      return;
    }
    for (const p of own) {
      if (ts.isShorthandPropertyAssignment(p)) {
        if (!forwards(p.name, "route")) problems.push(`probeAim("act.route", …) is given a non-literal road: ${p.name.text}`);
        continue;
      }
      const literal = vocabularyLiteral(p.initializer);
      if (literal !== null) route.add(literal);
      else if (!(ts.isIdentifier(skipParentheses(p.initializer)) && forwards(skipParentheses(p.initializer), "route"))) {
        problems.push(`probeAim("act.route", …) is given a non-literal road: ${oneLine(file, p.initializer)}`);
      }
    }
  }

  // ── `adr029Refusal`'s own returns — the grounds `probedStep` forwards ──
  const adr029 = functions.get("adr029Refusal");
  const readGround = (expression) => {
    const inner = skipParentheses(expression);
    if (isAbsence(inner)) return;
    const literal = vocabularyLiteral(inner);
    if (literal !== null) return void refused.add(literal);
    if (ts.isConditionalExpression(inner)) {
      readGround(inner.whenTrue);
      readGround(inner.whenFalse);
      return;
    }
    problems.push(`adr029Refusal returns a non-literal ground: ${oneLine(file, inner)}`);
  };
  if (adr029 !== undefined) {
    // An arrow with an EXPRESSION body has no return statement; its body is the one return (gate 2
    // on #682: `(err) => err instanceof A ? "ground_a" : undefined` read as no grounds, silently).
    if (adr029.body !== undefined && !ts.isBlock(adr029.body)) readGround(adr029.body);
    for (const node of walk(adr029.body ?? adr029)) {
      if (!ts.isReturnStatement(node) || enclosingFunction(node) !== adr029) continue;
      if (node.expression !== undefined) readGround(node.expression);
    }
  } else if (
    // Keyed on the exemption having been USED, not on a caller being named `probedStep`: renaming
    // the caller or importing `adr029Refusal` kept the exemption and read no grounds (gate 2 on #682).
    refusalBindingUsed ||
    [...walk(file)].some((n) => ts.isCallExpression(n) && calleeName(n) === "probedStep")
  ) {
    problems.push("adr029Refusal has moved: three refusal grounds are reachable only through it");
  }

  // ── Rule S — a spread comes last, so it overrides ──
  // `probeRoute(route, …, extra)` writes `{ route, …, ...extra }`: a `route` in the caller's extra
  // replaces the positional one, so the value read is not the value on the row (win2, internal
  // `cb0f6d6`: the scanner dropped the row's road in silence, and over-counted rung/refused).
  // Found from the producers' bodies, transitively through a producer that forwards its extra.
  // `overrides`: producer name → parameter index → the road fields a spread of it overrides. Keyed
  // by index because one function can spread two parameters; a single index per name flipped on
  // every pass and the fixed point never came (gate 2 on #682: `{ ...a, ...b }` hung the gate).
  // The sets only grow and are bounded by four fields, so the loop ends.
  const overrides = new Map();
  const overridden = (name, index) => overrides.get(name)?.get(index);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, fn] of functions) {
      for (const node of walk(fn.body ?? fn)) {
        if (!ts.isObjectLiteralExpression(node) || enclosingFunction(node) !== fn) continue;
        const before = new Set();
        for (const p of node.properties) {
          if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) {
            const parameter = parameterNamed(fn, p.expression.text);
            if (parameter === null) continue;
            const fields = new Set(before);
            // Transitively: this object is itself an argument in another producer's spread position.
            const parent = node.parent;
            if (ts.isCallExpression(parent)) {
              const outer = calleeName(parent) === null ? undefined : overridden(calleeName(parent), parent.arguments.indexOf(node));
              if (outer !== undefined) for (const f of outer) fields.add(f);
            }
            if (fields.size === 0) continue;
            const index = fn.parameters.indexOf(parameter);
            if (!overrides.has(name)) overrides.set(name, new Map());
            const known = overrides.get(name).get(index) ?? new Set();
            if ([...fields].some((f) => !known.has(f))) {
              overrides.get(name).set(index, new Set([...known, ...fields]));
              changed = true;
            }
          } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
            const key = propertyName(p.name);
            if (key !== null && ROAD_FIELDS.has(key)) before.add(key);
          }
        }
      }
    }
  }
  const checkExtra = (call, callee, index, fields, arg) => {
    const inner = skipParentheses(arg);
    if (ts.isConditionalExpression(inner)) {
      checkExtra(call, callee, index, fields, inner.whenTrue);
      checkExtra(call, callee, index, fields, inner.whenFalse);
      return;
    }
    if (isAbsence(inner)) return;
    if (!ts.isObjectLiteralExpression(inner)) {
      // A variable or a call in this position can carry a road field this parser cannot see, and
      // one there overrides the value read (gate 2 on #682: `const extra = { route: "mouse" }`).
      problems.push(
        `${callee}(…) at line ${lineOf(file, call)} passes \`${oneLine(file, inner)}\` where a ${[...fields].join("/")} in it would override the positional one — this parser cannot see into it`,
      );
      return;
    }
    for (const p of inner.properties) {
      if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) continue;
      const key = propertyName(p.name);
      if (key !== null && fields.has(key)) {
        problems.push(
          `${callee}(…) at line ${lineOf(file, call)} passes \`${key}\` in an object spread over the row AFTER the positional ${key} — the row carries this one, not the one read`,
        );
      }
    }
  };
  for (const node of walk(file)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = calleeName(node);
    const byIndex = callee === null ? undefined : overrides.get(callee);
    if (byIndex === undefined) continue;
    for (const [index, fields] of byIndex) {
      const arg = node.arguments[index];
      if (arg !== undefined) checkExtra(node, callee, index, fields, arg);
    }
  }

  for (const name of dynamicWhy) {
    const members = resolveUnion(name);
    if (members.length === 0) problems.push(`a why draws from ${name}, which could not be resolved`);
    for (const m of members) why.add(m);
  }

  return {
    landingWhyOnTheRow: [...landingLiteralWhy].sort(),
    landingWhyDrawsFromTheUnion: landingDrawsFromTheUnion,
    route: [...route].sort(),
    rung: [...rung].sort(),
    refused: [...refused].sort(),
    why: [...why].sort(),
    problems,
  };
}
