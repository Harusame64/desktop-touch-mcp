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

/** The exported `type <name> = …` declaration, or null. */
function typeAliasNamed(file, name) {
  for (const statement of file.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) continue;
    if (statement.name.text !== name) continue;
    const exported = ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) return statement;
  }
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
    const inner = ts.isParenthesizedTypeNode(n) ? n.type : n;
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
  const alias = typeAliasNamed(file, name);
  if (alias === null) return null;

  const values = [];
  for (const member of unionMembers(alias.type)) {
    const literal = stringLiteralType(member);
    if (literal !== null) {
      values.push(literal);
      continue;
    }
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
  const alias = typeAliasNamed(file, typeName);
  if (alias === null) {
    problems.push(`${typeName} not found — the ${field} union it carries is not being read`);
    return [];
  }

  const values = [];
  let seen = false;
  for (const member of unionMembers(alias.type)) {
    if (!ts.isTypeLiteralNode(member)) continue;
    for (const property of member.members) {
      if (!ts.isPropertySignature(property) || property.name === undefined) continue;
      if (propertyName(property.name) !== field || property.type === undefined) continue;
      seen = true;
      for (const value of unionMembers(property.type)) {
        const literal = stringLiteralType(value);
        if (literal !== null) {
          values.push(literal);
          continue;
        }
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

/** A property's name as written, whether it is an identifier or a quoted key. */
export function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}
