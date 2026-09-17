// The recognizer half of `check:native-types`: read `#[napi(object)]` structs out of Rust
// source, and `export interface` shapes out of a TS declaration file.
//
// **It is split out so it can be fed spellings the repo does not contain yet.** Gate 2 on PR #668
// turned five ordinary Rust spellings — a multi-line `#[derive]`, a trailing comment on the
// attribute, `js_name` before `object`, a lone `}` inside a block comment, a field whose type wraps
// — into a struct or a field that was never compared, and the run still printed OK. Every one of
// them was invisible to that round's mutants, because the mutants edited the TS side: **they
// measured the comparison and never the recognizer** ([[a-recognizer-needs-its-inputs-from-elsewhere]]).
//
// **So the rule here is that nothing is skipped quietly.** Anything this parser does not understand
// is returned in `problems`, and the caller fails on it. A guard that exists to end "a struct nobody
// compares" may not itself drop a struct without saying so.

/**
 * A line that IS a `#[napi(object …)]` attribute, in any argument order, with an optional trailing
 * line comment.
 *
 * **Anchored, because prose says the same words.** `src/uia/types.rs`'s module doc says "All
 * structs use `#[napi(object)]`", and `l1_capture/ring.rs` documents a struct as deliberately
 * napi-FREE by naming the attribute — an unanchored match reads both as declarations and then
 * reports that the struct beneath them cannot be found.
 */
const NAPI_OBJECT_ATTR = /^\s*#\[napi\(([^\])]*)\)\]\s*(?:\/\/.*)?$/;

/** `js_name = "Foo"` inside that attribute — the name the addon actually emits. */
const JS_NAME = /js_name\s*=\s*"([^"]+)"/;

/**
 * Is the item whose attribute sits at `lines[i]` behind a cargo FEATURE gate?
 *
 * **A feature gate and a platform gate are not the same question, and this file used to answer
 * both with `#[cfg(`.** A feature gate means a second item of the same name exists for the other
 * build — `CapabilityProfile` has a `vision-gpu` shape and a stub — so comparing whichever one a
 * scan meets against a declaration written for the other reports drift that is not there.
 * A `#[cfg(windows)]` item is declared in `index.d.ts` like everything else, and treating it as
 * out of scope is how a Windows-only export could go undeclared with the check still green: the
 * #667 defect class, on the function side.
 */
export function isFeatureGated(lines, i) {
  for (let k = i - 1; k >= 0; k--) {
    const t = lines[k].trim();
    if (t === "" || t.startsWith("//")) continue;
    if (/^#\[cfg\((?:not\()?\s*feature\b/.test(t)) return true;
    if (t.startsWith("#[")) continue;
    break;
  }
  return false;
}

/**
 * Drop `#[...]` attributes from the front of a line, returning what follows.
 *
 * Bracket depth rather than the first `]`, because an attribute can carry one of its own
 * (`ts_type = "A[]"`). An unterminated attribute returns `""` — the line is all attribute.
 */
function stripLeadingAttributes(line) {
  let rest = line;
  while (rest.startsWith("#[")) {
    let depth = 0;
    let i = 1;
    for (; i < rest.length; i++) {
      if (rest[i] === "[") depth++;
      else if (rest[i] === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return "";
    rest = rest.slice(i + 1).trim();
  }
  return rest;
}

/** snake_case → camelCase (matches napi-rs's default rename). */
function snakeToCamel(s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Parse `#[napi(object)]` structs.
 *
 * Returns `{ structs, problems }` where `structs` maps the JS-visible name to
 * `{ rustName, fields: Map<name, isOption>, line }`, and `problems` names everything skipped.
 */
export function parseNapiObjectStructs(source, file) {
  const lines = source.split("\n");
  const structs = new Map();
  const problems = [];
  // **Counted independently of the parse.** The count is what makes a silent drop impossible:
  // if the parser understood fewer structs than the file declares, the difference is reported
  // even when nobody can say which construct confused it.
  let declared = 0;

  for (let i = 0; i < lines.length; i++) {
    const attr = lines[i].match(NAPI_OBJECT_ATTR);
    if (!attr || !/(^|[,\s(])object([,\s)]|$)/.test(attr[1])) continue;
    declared++;
    const at = `${file}:${i + 1}`;

    // A FEATURE gate means a second struct of the same name exists for the other build
    // (`CapabilityProfile` has a `vision-gpu` shape and a stub), so comparing whichever one this
    // scan meets against a declaration written for the other reports drift that is not there.
    // A PLATFORM gate is different: `#[cfg(windows)]` items are declared in `index.d.ts` like
    // everything else, and skipping them would drop most of this repo's surface out of the check.
    if (isFeatureGated(lines, i)) {
      declared--;
      continue;
    }

    // Walk to the `pub struct` line, over comments, blank lines, and attributes that span lines.
    let j = i + 1;
    let depth = 0;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (depth > 0) {
        depth += (t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length;
        j++;
        continue;
      }
      if (t === "" || t.startsWith("//")) {
        j++;
        continue;
      }
      if (t.startsWith("#[")) {
        depth = (t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length;
        j++;
        continue;
      }
      break;
    }

    const decl = (lines[j] ?? "").match(/^\s*pub struct (\w+)/);
    if (!decl) {
      problems.push(`${at}: could not find the \`pub struct\` line this attribute belongs to`);
      continue;
    }
    if (lines[j].includes("}")) {
      // `pub struct X { pub a: u32 }` — the field loop below would run past the closing brace and
      // harvest the NEXT struct's fields, which is how one collapsed line produced 26 findings,
      // every one of them naming the wrong struct.
      problems.push(`${at}: \`${decl[1]}\` is written on one line; this parser reads block bodies only`);
      continue;
    }

    const fields = new Map();
    let closed = false;
    let inBlockComment = false;
    for (let k = j + 1; k < lines.length; k++) {
      const line = lines[k].trim();
      if (inBlockComment) {
        if (line.includes("*/")) inBlockComment = false;
        continue;
      }
      if (line.startsWith("/*")) {
        if (!line.includes("*/")) inBlockComment = true;
        continue;
      }
      if (line === "}") {
        closed = true;
        break;
      }
      if (line === "" || line.startsWith("//")) continue;
      // **An attribute may sit on the same line as the field it decorates.** Skipping the whole
      // line drops the field with no trace — `#[cfg(windows)] pub dpi: u32,` was invisible.
      const rest = stripLeadingAttributes(line);
      if (rest === "") continue;
      const fm = rest.match(/^pub (\w+):\s*(.+?),?$/);
      if (fm) {
        fields.set(snakeToCamel(fm[1]), fm[2].startsWith("Option<"));
        continue;
      }
      // Anything else inside a struct body is a field this parser cannot read — a wrapped type, a
      // same-line `#[cfg]`, a nested brace. Reporting it is the whole point: a dropped field is
      // silent when TS also lacks it, and actively misleading when TS declares it (the message
      // then tells the reader to delete a correct declaration).
      problems.push(`${file}:${k + 1}: \`${decl[1]}\` has a line this parser cannot read as a field: ${line}`);
      closed = true;
      break;
    }
    if (!closed) {
      problems.push(`${at}: \`${decl[1]}\` has no closing brace this parser could find`);
      continue;
    }

    const jsName = attr[1].match(JS_NAME)?.[1] ?? decl[1];
    if (structs.has(jsName)) {
      // Two structs, one JS name. Whichever file is walked last used to win, silently — and the
      // `#[cfg(windows)]` / `#[cfg(not(windows))]` stub pair this repo already uses for functions
      // is exactly that shape.
      problems.push(
        `${at}: \`${jsName}\` is already declared at ${structs.get(jsName).at} — two structs cannot share one JS name`,
      );
      continue;
    }
    structs.set(jsName, { rustName: decl[1], fields, at });
  }

  // **No input reaches this today, and a mutant that deletes it kills no cell.** Every skip above
  // reports its own reason, so the arithmetic always balances. It is kept anyway because it guards
  // the NEXT edit, not this input: a `continue` added later without a `problems.push` turns a
  // struct into a silently smaller count, which is the exact failure this whole section exists to
  // end. Said out loud rather than left to look tested.
  if (structs.size + problems.length < declared) {
    problems.push(
      `${file}: ${declared} \`#[napi(object)]\` attributes, but only ${structs.size} structs were understood`,
    );
  }
  return { structs, problems };
}

/**
 * Parse `export interface X { … }` into `{ interfaces, problems }`, where each interface maps a
 * field name to whether it is declared optional (`field?:`).
 *
 * Interfaces this parser cannot read are REPORTED rather than skipped: an `extends`, a generic, or
 * a `type X = { … }` alias used to make one interface invisible, which on the `native-types.ts`
 * side silently disabled that whole half of the comparison.
 */
export function parseTsInterfaces(source) {
  const interfaces = new Map();
  const problems = [];
  const opens = [...source.matchAll(/^export (interface|type) (\w+)\b([^\n{]*)\{/gm)];
  for (const m of opens) {
    const [, kind, name, between] = m;
    const line = source.slice(0, m.index).split("\n").length;
    if (kind === "type" || between.trim() !== "") {
      problems.push(`index/native declaration ${name} (line ${line}) is not a plain \`export interface X {\``);
      continue;
    }
    const body = source.slice(m.index + m[0].length);
    const end = body.search(/^\}/m);
    if (end === -1) {
      problems.push(`interface ${name} (line ${line}) has no closing brace at column 0`);
      continue;
    }
    const fields = new Map();
    for (const raw of body.slice(0, end).split("\n")) {
      const t = raw.trim();
      if (t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      const fm = t.match(/^(\w+)(\??):/);
      if (fm) fields.set(fm[1], fm[2] === "?");
    }
    interfaces.set(name, fields);
  }
  return { interfaces, problems };
}
