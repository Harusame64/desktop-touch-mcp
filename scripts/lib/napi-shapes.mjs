// The recognizer half of `check:native-types`: read `#[napi(object)]` structs out of Rust source,
// and `export interface` shapes out of a TS declaration file.
//
// **It is split out so it can be fed spellings the repo does not contain yet.** Two review rounds
// on PR #668 turned ordinary spellings into a struct or a field that was never compared while the
// run printed OK — first a multi-line `#[derive]`, a trailing `//`, `js_name` before `object`, a
// lone `}` in a block comment, a wrapped field type; then, after those were fixed one at a time, a
// trailing `/* */`, a wrapped ATTRIBUTE, an attribute sharing its line with the struct, a
// `readonly` field on the TS side. **The second round is the lesson: the first fix enumerated
// spellings where it needed a grammar.**
//
// So the shape of this file is:
//
// 1. **Attributes and interfaces are found by a bracket-aware scan, not by a line regex.** An
//    attribute may span lines and may carry `)` or `]` inside its arguments.
// 2. **What is COUNTED is independent of what is PARSED.** `declared` is incremented as soon as an
//    attribute is recognised as `#[napi(… object …)]`, before anything else can fail — the first
//    version incremented it inside the branch its own regex guarded, so a struct the regex could
//    not read was never counted and the arithmetic always balanced. The comment claimed the count
//    made a silent drop impossible; it did not ([[a-comment-is-a-claim-not-a-check]]).
// 3. **Nothing is skipped quietly, on either side.** Anything unreadable is returned in `problems`
//    and the caller fails on it. A guard that exists to end "a struct nobody compares" may not drop
//    one without saying so — and the TS half reported nothing at all until the second round.

/** snake_case → camelCase (matches napi-rs's default rename). */
function snakeToCamel(s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Consume a bracketed run starting at `text[start]` (which must be the opener), returning the index
 * just past its match, or -1 when it never closes. Depth-counted, so nested `(`/`[` inside an
 * attribute's arguments are handled.
 */
function endOfBracketed(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Strip `#[…]` attributes and `/* … *​/` comments from the front of a line; `""` when nothing follows. */
function stripLeadingNoise(line) {
  let rest = line.trim();
  for (;;) {
    if (rest.startsWith("#[")) {
      const end = endOfBracketed(rest, 1, "[", "]");
      if (end === -1) return "";
      rest = rest.slice(end).trim();
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end === -1) return "";
      rest = rest.slice(end + 2).trim();
      continue;
    }
    return rest;
  }
}

/** Does this attribute's argument list carry `object` as an argument (in any position)? */
function hasObjectArg(args) {
  return args
    .split(",")
    .map((a) => a.trim())
    .some((a) => a === "object");
}

/**
 * Parse `#[napi(object)]` structs.
 *
 * Returns `{ structs, problems }` where `structs` maps the JS-visible name (`js_name` when present,
 * the Rust name otherwise) to `{ rustName, fields: Map<name, isOption>, at }`.
 */
export function parseNapiObjectStructs(source, file) {
  const text = source.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const structs = new Map();
  const problems = [];
  let declared = 0;

  // Offsets of every line start, so a character index can be named as `file:line`.
  const lineAt = (index) => text.slice(0, index).split("\n").length;

  // `#[napi(` at the start of a line (after indentation) — prose that mentions the attribute begins
  // with `///`, `//!` or text, and must not be read as a declaration. Both `src/uia/types.rs` (a
  // module doc saying "All structs use `#[napi(object)]`") and `l1_capture/ring.rs` (a struct
  // documented as deliberately napi-FREE) were read as declarations before this was anchored.
  const attrStart = /^[ \t]*#\[napi\(/gm;
  for (const m of [...text.matchAll(attrStart)]) {
    const openParen = text.indexOf("(", m.index);
    const closeParen = endOfBracketed(text, openParen, "(", ")");
    const at = `${file}:${lineAt(m.index)}`;
    if (closeParen === -1) {
      problems.push(`${at}: \`#[napi(\` never closes`);
      continue;
    }
    const args = text.slice(openParen + 1, closeParen - 1);
    if (!hasObjectArg(args)) continue;

    const closeBracket = text.indexOf("]", closeParen - 1);
    if (closeBracket === -1) {
      problems.push(`${at}: \`#[napi(object …)\` is never followed by \`]\``);
      continue;
    }
    // **Counted here**: everything below can fail, and the difference between this count and the
    // structs understood is itself reported.
    declared++;

    const startLine = lineAt(m.index);
    if (isFeatureGated(lines, startLine - 1)) {
      // A FEATURE gate means a second struct of the same name exists for the other build
      // (`CapabilityProfile` has a `vision-gpu` shape and a stub), so comparing whichever one this
      // scan meets against a declaration written for the other reports drift that is not there.
      // A PLATFORM gate is different: `#[cfg(windows)]` items are declared like everything else.
      declared--;
      continue;
    }

    // Walk forward over further attributes, comments and blank lines to the `pub struct` line.
    let rest = text.slice(closeBracket + 1);
    let consumed = closeBracket + 1;
    for (;;) {
      const before = rest;
      rest = rest.replace(/^[ \t]*\n/, "");
      rest = rest.replace(/^[ \t]*\/\/[^\n]*\n/, "");
      const attr = rest.match(/^[ \t]*#\[/);
      if (attr) {
        const open = rest.indexOf("[");
        const end = endOfBracketed(rest, open, "[", "]");
        if (end === -1) break;
        rest = rest.slice(end);
      }
      const block = rest.match(/^[ \t]*\/\*/);
      if (block) {
        const end = rest.indexOf("*/");
        if (end === -1) break;
        rest = rest.slice(end + 2);
      }
      if (rest === before) break;
    }
    consumed += text.slice(closeBracket + 1).length - rest.length;

    const decl = rest.match(/^[ \t]*pub struct (\w+)[^\n{]*\{/);
    if (!decl) {
      problems.push(`${at}: could not find the \`pub struct\` line this attribute belongs to`);
      continue;
    }
    const bodyStart = consumed + rest.indexOf("{", decl.index) + 1;
    const bodyEnd = endOfBracketed(text, bodyStart - 1, "{", "}");
    if (bodyEnd === -1) {
      problems.push(`${at}: \`${decl[1]}\` has no closing brace this parser could find`);
      continue;
    }

    const fields = new Map();
    let broken = false;
    let inBlockComment = false;
    for (const [offset, raw] of text.slice(bodyStart, bodyEnd - 1).split("\n").entries()) {
      const where = `${file}:${lineAt(bodyStart) + offset}`;
      let line = raw.trim();
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end === -1) continue;
        line = line.slice(end + 2).trim();
        inBlockComment = false;
      }
      if (line === "" || line.startsWith("//")) continue;
      // An attribute or a closed block comment may share the line with the field it decorates;
      // throwing the whole line away drops the field with no trace.
      const stripped = stripLeadingNoise(line);
      if (stripped === "") {
        if (line.includes("/*") && !line.includes("*/")) inBlockComment = true;
        continue;
      }
      const fm = stripped.match(/^pub (\w+):\s*(.+?),?$/);
      if (fm) {
        // `Option<…>` and `std::option::Option<…>` are the same thing to napi: the key is OMITTED
        // for `None`.
        fields.set(snakeToCamel(fm[1]), /(^|::)Option</.test(fm[2]));
        continue;
      }
      problems.push(`${where}: \`${decl[1]}\` has a line this parser cannot read as a field: ${stripped}`);
      broken = true;
      break;
    }
    if (broken) continue;

    const jsName = args.match(/js_name\s*=\s*"([^"]+)"/)?.[1] ?? decl[1];
    if (structs.has(jsName)) {
      // Two structs, one JS name. Whichever file is walked last used to win, silently — and the
      // `#[cfg(windows)]` / `#[cfg(not(windows))]` stub pair this repo already uses for functions
      // is exactly that shape.
      problems.push(`${at}: \`${jsName}\` is already declared at ${structs.get(jsName).at}`);
      continue;
    }
    structs.set(jsName, { rustName: decl[1], fields, at });
  }

  if (structs.size + problems.length < declared) {
    problems.push(
      `${file}: ${declared} \`#[napi(object)]\` attributes, but only ${structs.size} structs were understood`,
    );
  }
  return { structs, problems };
}

/**
 * Is the item whose attribute block contains `lines[i]` behind a cargo FEATURE gate?
 *
 * **A feature gate and a platform gate are not the same question**, and this file used to answer
 * both with `#[cfg(`. A feature gate means a second item of the same name exists for the other
 * build; a `#[cfg(windows)]` item is declared in `index.d.ts` like everything else, and treating it
 * as out of scope is how a Windows-only export could go undeclared with the check still green.
 *
 * The walk goes UP from the attribute over the item's whole attribute block — including multi-line
 * attributes and block doc comments, which used to stop it — and `feature` is looked for anywhere
 * inside the `cfg` predicate, because `all(windows, feature = "x")` is one.
 */
export function isFeatureGated(lines, i) {
  let depth = 0;
  for (let k = i - 1; k >= 0; k--) {
    const t = lines[k].trim();
    if (t === "" || t.startsWith("//")) continue;
    // Walking upwards, a line ENDING a multi-line attribute or block comment opens a run to skip.
    if (depth > 0) {
      depth += (t.match(/\]/g) ?? []).length - (t.match(/\[/g) ?? []).length;
      continue;
    }
    if (t.endsWith("*/")) {
      // Skip up to the comment's opener.
      let k2 = k;
      while (k2 >= 0 && !lines[k2].trim().startsWith("/*")) k2--;
      k = k2 < 0 ? 0 : k2;
      continue;
    }
    if (t.endsWith("]") && !t.startsWith("#[")) {
      depth = (t.match(/\]/g) ?? []).length - (t.match(/\[/g) ?? []).length;
      if (depth > 0) continue;
    }
    if (t.startsWith("#[")) {
      if (/^#\[cfg\(/.test(t) && /\bfeature\s*=/.test(t)) return true;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Parse `export interface X { … }` into `{ interfaces, problems }`, each interface mapping a field
 * name to whether it is declared optional (`field?:`).
 *
 * **Declarations are counted before they are parsed**, and anything unreadable — an `extends`, a
 * generic, a `type X = {…}` alias, an index signature, a quoted key, a nested object literal — is
 * reported. The first version matched only `^export interface X {` and pushed nothing for a body
 * line it could not read, which on the `native-types.ts` side (where an unpaired struct is skipped
 * by design) silently removed a shape from the comparison.
 */
export function parseTsInterfaces(source) {
  const text = source.replace(/\r\n/g, "\n");
  const interfaces = new Map();
  const problems = [];
  const lineAt = (index) => text.slice(0, index).split("\n").length;

  for (const m of [...text.matchAll(/^export (?:declare )?(interface|type) (\w+)/gm)]) {
    const [, kind, name] = m;
    const where = `line ${lineAt(m.index)}`;
    const brace = text.indexOf("{", m.index);
    const nextExport = text.indexOf("\nexport ", m.index + 1);
    if (kind === "type" || brace === -1 || (nextExport !== -1 && brace > nextExport)) {
      problems.push(`${name} (${where}) is not a plain \`export interface X { … }\``);
      continue;
    }
    const head = text.slice(m.index + m[0].length, brace).trim();
    if (head !== "") {
      problems.push(`${name} (${where}) carries \`${head}\`, which this parser does not follow`);
      continue;
    }
    const end = endOfBracketed(text, brace, "{", "}");
    if (end === -1) {
      problems.push(`${name} (${where}) has no closing brace`);
      continue;
    }
    if (interfaces.has(name)) {
      problems.push(`${name} (${where}) is declared twice`);
      continue;
    }
    const fields = new Map();
    let broken = false;
    let inBlockComment = false;
    for (const raw of text.slice(brace + 1, end - 1).split("\n")) {
      let line = raw.trim();
      if (inBlockComment) {
        const close = line.indexOf("*/");
        if (close === -1) continue;
        line = line.slice(close + 2).trim();
        inBlockComment = false;
      }
      if (line === "" || line.startsWith("//") || line.startsWith("*")) continue;
      if (line.startsWith("/*")) {
        if (!line.includes("*/")) {
          inBlockComment = true;
          continue;
        }
        line = line.slice(line.indexOf("*/") + 2).trim();
        if (line === "") continue;
      }
      // A METHOD signature is understood and carries no field: `NativeDirtyRectSubscription`
      // describes a napi CLASS, not an object struct, and a `#[napi(object)]` field can never be
      // one. Recognised rather than skipped, so the line below still catches what is neither.
      if (/^(?:readonly\s+)?\w+\s*(?:<[^>]*>)?\(/.test(line)) continue;
      const fm = line.match(/^(?:readonly\s+)?(\w+)(\??):/);
      if (fm) {
        fields.set(fm[1], fm[2] === "?");
        continue;
      }
      problems.push(`${name} (${where}) has a line this parser cannot read as a field: ${line}`);
      broken = true;
      break;
    }
    if (!broken) interfaces.set(name, fields);
  }
  return { interfaces, problems };
}
