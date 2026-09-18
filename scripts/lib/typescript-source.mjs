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
  return null;
}
