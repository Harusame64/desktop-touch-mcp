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

/**
 * Every `#[… napi …]` attribute in a Rust source, found by BRACKET DEPTH and matched on its PATH.
 *
 * **The path is what three rounds of review kept getting through.** Rounds 1-3 rewrote the INSIDE of
 * this parser — spans lines, tolerates `)` in arguments, reads bodies by brace matching — while the
 * ENTRY stayed a literal `#[napi(`. This tree writes the attribute three ways (`#[napi]`,
 * `#[napi(…)]`, `#[napi_derive::napi(…)]`), and **the third is house style in `src/uia/`: 13 structs
 * sat outside the check with the run printing OK.** Respelling one struct turned a loud failure into
 * `OK`, and the only trace was two numbers moving in a line nobody diffs.
 *
 * So: any attribute whose path's LAST SEGMENT is `napi` counts, however it is qualified. A napi
 * attribute inside `cfg_attr` is NOT followed — and is reported, because a spelling this parser
 * cannot read may not leave through the same door as one it has read.
 *
 * Prose is excluded by the anchor: an attribute is a line that STARTS with `#[` after indentation.
 * `src/uia/types.rs` opens with "All structs use `#[napi(object)]`", and `l1_capture/ring.rs`
 * documents a struct as deliberately napi-FREE by naming it.
 */
export function scanNapiAttributes(source, file) {
  const text = source.replace(/\r\n/g, "\n");
  const attrs = [];
  const problems = [];
  const lineAt = (index) => text.slice(0, index).split("\n").length;

  for (const m of [...text.matchAll(/^[ \t]*#\[/gm)]) {
    const open = text.indexOf("[", m.index);
    const close = endOfBracketed(text, open, "[", "]");
    const startLine = lineAt(m.index);
    const at = `${file}:${startLine}`;
    if (close === -1) {
      problems.push(`${at}: an attribute never closes`);
      continue;
    }
    const inner = text.slice(open + 1, close - 1).trim();
    // An absolute path (`::napi_derive::napi`) is legal here too.
    const path = inner.match(/^(::\s*)?([A-Za-z_][A-Za-z0-9_]*(?:\s*::\s*[A-Za-z_][A-Za-z0-9_]*)*)/)?.[0] ?? "";
    const last = path.split("::").pop().trim();
    if (last === "cfg_attr") {
      if (/\bnapi\b/.test(inner)) {
        problems.push(`${at}: a napi attribute inside \`cfg_attr\` — this parser does not follow it`);
      }
      continue;
    }
    if (last !== "napi") continue;
    const rest = inner.slice(inner.indexOf(path) + path.length).trim();
    let args = "";
    if (rest.startsWith("(")) {
      const argsEnd = endOfBracketed(rest, 0, "(", ")");
      if (argsEnd === -1) {
        problems.push(`${at}: \`${path}(\` never closes`);
        continue;
      }
      args = rest.slice(1, argsEnd - 1);
    } else if (rest !== "") {
      problems.push(`${at}: \`${path}\` is followed by \`${rest}\`, which this parser does not read`);
      continue;
    }
    attrs.push({ at, args, path, endIndex: close, startLine });
  }
  return { attrs, problems };
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

  const { attrs, problems: attrProblems } = scanNapiAttributes(source, file);
  problems.push(...attrProblems);
  for (const attr of attrs) {
    const at = attr.at;
    if (!hasObjectArg(attr.args)) continue;
    // **Counted here**: everything below can fail, and the difference between this count and the
    // structs understood is itself reported.
    declared++;

    if (isFeatureGated(lines, attr.startLine - 1)) {
      // A FEATURE gate means a second struct of the same name exists for the other build
      // (`CapabilityProfile` has a `vision-gpu` shape and a stub), so comparing whichever one this
      // scan meets against a declaration written for the other reports drift that is not there.
      // A PLATFORM gate is different: `#[cfg(windows)]` items are declared like everything else.
      declared--;
      continue;
    }

    // Walk forward over further attributes, comments and blank lines to the `pub struct` line.
    let rest = text.slice(attr.endIndex);
    let consumed = attr.endIndex;
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
    consumed += text.slice(attr.endIndex).length - rest.length;

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

    const jsName = attr.args.match(/js_name\s*=\s*"([^"]+)"/)?.[1] ?? decl[1];
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
 * Every free `#[napi]` function, by the name JS sees, with the type of its single parameter when it
 * takes one.
 *
 * **The function scan used to have its own entry**, a line regex requiring the bare attribute alone
 * on its line — so `#[napi_derive::napi]`, `#[napi(js_name = "…")]` and a trailing comment each hid
 * an undeclared export with the run green (gate 2, third pass). It shares the path-aware scan now.
 *
 * The parameter type matters because **the argument shapes are declared INLINE in `index.d.ts`**
 * (`uiaClickElement(opts: { windowTitle: string; … })`), not as named interfaces — so a struct that
 * never pairs by name can still be compared, through the function that takes it.
 */
export function parseNapiFunctions(source, file) {
  const text = source.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const { attrs, problems } = scanNapiAttributes(source, file);
  const functions = new Map();

  for (const attr of attrs) {
    if (hasObjectArg(attr.args)) continue;
    // A constructor, getter or setter is a napi CLASS member, not a free export: `new` is not a
    // name `index.d.ts` declares as a function. The old line-regex entry excluded them by accident,
    // because it demanded the bare attribute alone on its line.
    if (/\b(constructor|getter|setter)\b/.test(attr.args)) continue;
    if (isFeatureGated(lines, attr.startLine - 1)) continue;
    // Walk to the item this attribute decorates, over further attributes and comments.
    let rest = text.slice(attr.endIndex);
    for (;;) {
      const before = rest;
      rest = rest.replace(/^[ \t]*\n/, "");
      rest = rest.replace(/^[ \t]*\/\/[^\n]*\n/, "");
      if (/^[ \t]*#\[/.test(rest)) {
        const open = rest.indexOf("[");
        const end = endOfBracketed(rest, open, "[", "]");
        if (end === -1) break;
        rest = rest.slice(end);
      }
      if (rest === before) break;
    }
    // **The signature is read to its closing paren, not to the end of the line.** A wrapper whose
    // parameter sits on its own line (`pub fn uia_click_element(\n    opts: …,\n)`) is the common
    // shape in `lib.rs` — reading one line found the parameter of 1 function in 22.
    const head = rest.match(/^\s*pub\s+fn\s+(\w+)\s*\(/);
    if (!head) continue;
    const parenStart = rest.indexOf("(", head.index);
    const parenEnd = endOfBracketed(rest, parenStart, "(", ")");
    if (parenEnd === -1) continue;
    const params = rest.slice(parenStart + 1, parenEnd - 1).trim();
    // Methods are napi class methods, not free exports.
    if (/^&(?:mut\s+)?self\b/.test(params)) continue;
    const m = [null, head[1], params];
    const jsName = attr.args.match(/js_name\s*=\s*"([^"]+)"/)?.[1] ?? snakeToCamel(m[1]);
    // The wrapper names the type through its module (`opts: uia::tree::GetElementsOptions`), and
    // the struct is keyed by its last segment — so take the last segment here too.
    const paramType =
      m[2]
        .replace(/,\s*$/, "")
        .match(/^\s*\w+\s*:\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*::\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/)?.[1]
        ?.split("::")
        .pop()
        .trim() ?? null;
    const debugOnly = (() => {
      for (let k = attr.startLine - 2; k >= 0; k--) {
        const t = lines[k].trim();
        if (t === "" || t.startsWith("//")) continue;
        if (/^#\[cfg\(debug_assertions\)\]/.test(t)) return true;
        if (t.startsWith("#[")) continue;
        return false;
      }
      return false;
    })();
    functions.set(jsName, { rustName: m[1], paramType, at: attr.at, debugOnly });
  }
  return { functions, problems };
}

/**
 * The inline object type of each `export declare function name(param: { … })` in a `.d.ts`.
 *
 * This is where the napi ARGUMENT shapes live: 13 of this repo's `#[napi(object)]` structs are
 * parameter types with no named interface anywhere, so until they were compared through here they
 * were the #667 class — a shape a caller must get right, that nothing checked — in the one
 * direction nobody had looked at.
 */
export function parseTsFunctionParams(source) {
  const text = source.replace(/\r\n/g, "\n");
  const out = new Map();
  for (const m of text.matchAll(/^export declare function (\w+)\s*\(\s*\w+\s*:\s*\{/gm)) {
    const brace = text.indexOf("{", m.index + m[0].length - 1);
    const end = endOfBracketed(text, brace, "{", "}");
    if (end === -1) continue;
    const fields = new Map();
    for (const part of text.slice(brace + 1, end - 1).split(";")) {
      const fm = part.trim().match(/^(\w+)(\??):/);
      if (fm) fields.set(fm[1], fm[2] === "?");
    }
    out.set(m[1], fields);
  }
  return out;
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
