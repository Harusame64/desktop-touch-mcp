// ADR-036 — the CONFIGURATION axis of the completion grid, read out of the source.
//
// The gate's denominator is "the vocabulary extracted from the code × configuration × result"
// (the user's decision, 2026-09-11). The road axis got its extractor in #669; this is the second
// of the three. Same rule: **extracted, not hand-listed**, so a switch added in code cannot quietly
// become a dimension nobody counted.
//
// **What makes this one hard is that a switch has no single reading site and no type.** Counted on
// `06a66999`, the product reads 79 of them from six places in FOUR LANGUAGES, and the obvious sweep
// — `process.env.NAME` under `src/` — finds 41. Each of the five shapes below was found by widening
// the sweep, never by remembering a name:
//
//  1. `process.env.NAME` and `process.env["NAME"]`
//  2. `env.NAME` on an INJECTED environment. Half the engine is written this way
//     (`readKeyboardRungSwitch(env: NodeJS.ProcessEnv = process.env)`) precisely so cells can drive
//     it — which is why the sweep that misses this shape misses exactly the testable switches.
//  3. `process.env[CONST]` where `const CONST = "NAME"` sits elsewhere in the file.
//  4. `std::env::var("NAME")` in Rust, in any of its spellings.
//  5. `Environment.GetEnvironmentVariable("NAME")` in the C# side tools, which ship as executables
//     the server spawns.
//
// **Two rules this file is built on, both bought with defects:**
//
// **An identifier named `env` is not an environment.** The first version matched `env.NAME`
// wherever it appeared, and `guarded-touch.ts` has `private readonly env: TouchEnvironment` — a
// dependency bag. Thirteen of its METHOD NAMES were being read as switches. They were invisible
// only because a `DESKTOP_TOUCH_|DTM_` prefix filter threw them away, so the prefix was quietly
// load-bearing for CORRECTNESS while it was documented as classification. The prefix is gone; an
// injected environment is now recognised by its TYPE (`NodeJS.ProcessEnv`), the way the road axis
// learned to key its own exemption on a binding rather than on a spelling.
//
// **Membership is not a naming convention.** `bin/launcher.js` reads `GITHUB_TOKEN` and `GH_TOKEN`
// to authenticate its download (win2, 2026-09-17): product switches by function, dropped by
// spelling. What separates a switch from the operating system's own environment is a DECISION, so
// it is pinned in the fixture where the decision is visible — not inferred from a prefix.

/** Strip `//` and block comments, keeping every line's index — and leaving string literals alone. */
export function stripComments(source) {
  return stripCommentsWithMask(source).text;
}

/**
 * The same strip, plus a mask saying which characters sit inside a string literal.
 *
 * The caller needs it to tell a read from PROSE THAT SPELLS ONE. A tool description saying
 * "…cannot divert keystrokes. DTM_BG_AUTO=1 enables BG globally" has the shape of a property
 * access across the sentence boundary, and three of them were being reported as unreadable holders.
 */
function stripCommentsWithMask(source) {
  const text = source.replace(/\r\n/g, "\n");
  let out = "";
  const mask = [];
  const push = (chars, within) => {
    out += chars;
    for (let k = 0; k < chars.length; k++) mask.push(within ? 1 : 0);
  };
  let i = 0;
  let quote = null;
  // Templates currently open, innermost last. `{ template: true }` is quoted text; `{ template:
  // false, depth }` is that template's `${…}`, which is CODE — see the note on the backtick branch.
  const stack = [];
  while (i < text.length) {
    const ch = text[i];
    const top = stack[stack.length - 1];
    if (quote === null && top !== undefined && top.template) {
      if (ch === "\\" && i + 1 < text.length) {
        push(ch, true);
        push(text[i + 1], true);
        i += 2;
        continue;
      }
      if (ch === "`") {
        push(ch, false);
        stack.pop();
        i++;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        push(ch, false);
        push("{", false);
        stack.push({ template: false, depth: 0 });
        i += 2;
        continue;
      }
      push(ch, true);
      i++;
      continue;
    }
    if (quote) {
      push(ch, true);
      if (ch === "\\" && i + 1 < text.length) {
        push(text[i + 1], true);
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    // **A `//` inside a string is not a comment.** `fetch("http://host", { h: process.env.TOKEN })`
    // lost its switch to the line-comment rule, silently, in the first version of this file and in
    // the road extractor it was copied from.
    // **A template's `${…}` is code, so the strip has to go in there.** Taking the whole template as
    // one quoted run left a `/* … */` inside an interpolation unstripped, and the prose in it was
    // then read as source: `` `${/* process.env.DTM_GHOST */ 1}` `` put DTM_GHOST in the
    // configuration axis, beside the real switches (gate 2 on #679, round 3, measured here). The
    // same rule the road module's strip and `literalSpans` learned in this PR.
    if (ch === "`") {
      push(ch, false);
      stack.push({ template: true, depth: 0 });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      push(ch, false);
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      // **A block comment separates two tokens; deleting it joins them** — `foo/**/bar` came out
      // as `foobar` (gate 2 on #679, round 2). The separator is kept, and the newlines still land
      // where they did, because the contract here is the line index, not the column.
      push(" ", false);
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      for (let j = i; j < end; j++) if (text[j] === "\n") push("\n", false);
      i = end;
      continue;
    }
    // **After BOTH comment checks, never between them.** Inserting this branch between the `//`
    // and `/*` tests made `const x = /* … */ 5;` read as a regex literal, so the comment was never
    // stripped and its prose entered the axis as code — and a multi-line one desynced the string
    // mask, hiding a real switch. The fix for a regex defect introduced a comment defect one line
    // above it (gate 2 on #674, round 4, finding 6; `browser.ts:2490` hits the first form today).
    // **A regex literal's `\/\/` is not a comment either.** The same defect as the string case
    // above, one grammar rule further in: `/^https?:\/\//i` in `engine/cdp-bridge.ts:582` lost the
    // rest of its line — including the `{` that opens the `if` — so every brace-matching read after
    // it walked into the wrong block, silently. Measured on 2026-09-18 while the road extractor was
    // being fixed for the same thing; this file kept its own copy of the strip and so kept the
    // defect. A regex is entered only where a value may begin.
    if (ch === "/" && /(?:[=(,[!&|?:;{}+\-*%^~<>]|\breturn|\btypeof|\bcase|\bin|\bof|\bdo|\belse|\bvoid|\bdelete|\binstanceof|\bnew|\byield|\bawait)\s*$/.test(out)) {
      push(ch, false);
      i++;
      let inClass = false;
      while (i < text.length) {
        const c = text[i];
        push(c, false);
        i++;
        if (c === "\\") {
          push(text[i] ?? "", false);
          i++;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
      }
      continue;
    }
    if (top !== undefined && !top.template) {
      if (ch === "{") top.depth++;
      else if (ch === "}") {
        if (top.depth === 0) {
          push(ch, false);
          stack.pop();
          i++;
          continue;
        }
        top.depth--;
      }
    }
    push(ch, false);
    i++;
  }
  return { text: out, inString: mask };
}

/**
 * The identifiers in this source that hold a process environment.
 *
 * `process.env` always is one. A parameter or variable is one when it is TYPED as one, or assigned
 * from one — never because it is spelled `env`.
 */
function environmentIdentifiers(text) {
  const names = new Set();
  // Annotated. Four sites take an environment with no default and say so in the type.
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:NodeJS\.)?ProcessEnv\b/g)) names.add(m[1]);
  // **Defaulted from `process.env`** — the binding, not the type. Eight sites spell the type
  // structurally (`env: Record<string, string | undefined> = process.env`), and a rule that asked
  // for `NodeJS.ProcessEnv` dropped both of the switches those sites read. The three `{ ...process
  // .env }` spreads are environments being BUILT for a child process, which is where the writes are.
  //
  // **The `(?![.[])` is the whole rule.** Without it `const raw = process.env.FOO` makes `raw` an
  // environment, and then `raw.trim()` and `raw.length` enter the axis as switches — which is what
  // happened, and which is the same shape as the `TouchEnvironment` bag this rule exists to reject.
  //
  // **Scanned, not matched.** The regex form let the annotation run through the COMMA inside
  // `Record<string, string | undefined>` and swallow the parameter before it, so
  // `resolveCaptureFile(captureId: string, env: NodeJS.ProcessEnv = process.env)` made `captureId`
  // an environment and put `length` in the axis. Walk left from the `=` instead, stopping at the
  // separator that really ends a binding — a `(`, `{`, `;`, a newline, or a comma at bracket depth
  // zero — and take the identifier that opens what is left.
  for (const m of text.matchAll(/=\s*(?:\{\s*\.\.\.)?process\.env\s*(?![.[])/g)) {
    const name = bindingNameBefore(text, m.index);
    if (name !== null) names.add(name);
  }
  // **An environment under construction is an environment.** `injector.ts` builds one for a child
  // process — `const env: Record<string, string> = { DTM_LOCKER_PIPE: …, DTM_ASKPASS_TICKET: … }` —
  // and then adds to it. Recognised by the BINDING again: a string map whose literal already holds
  // a switch-shaped key. Without this the adds read as "a switch from a holder we cannot confirm",
  // which is true and useless; with it they land where they belong, in the WRITTEN set.
  for (const m of text.matchAll(/=\s*\{\s*(?:DESKTOP_TOUCH|DTM)_[A-Z0-9_]+\s*:/g)) {
    const name = bindingNameBefore(text, m.index);
    if (name !== null) names.add(name);
  }
  // A plain `.js` file has no annotation to read. `bin/launcher.js` and the bench scripts use
  // `process.env` directly, so nothing is lost; an untyped injected environment would be REPORTED
  // by the dynamic-key rule below rather than read, which is the safe direction.
  return names;
}

/**
 * Every regular-expression metacharacter, escaped — not the subset that came to mind.
 *
 * **Exported so a cell can reach it, because no caller can.** The only source of holder names is a
 * character class that already excludes every metacharacter, so reverting this to the `$`-only
 * version it started as leaves all 22 cells green and the real tree unchanged — a branch no mutant
 * can kill. CodeQL was right that the sanitization was incomplete (`js/incomplete-sanitization`,
 * high, #670); what it could not say is that nothing reaches it today. Both facts belong next to
 * each other: this is defence in depth against a future caller that reads names some other way,
 * and the cell pins the FUNCTION rather than pretending to pin a path.
 */
export function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The identifier a binding declares, found by walking left from its `=`. */
function bindingNameBefore(text, equalsIndex) {
  let depth = 0;
  let start = 0;
  for (let i = equalsIndex - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "<" || ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) {
        start = i + 1;
        break;
      }
      depth--;
    } else if (depth === 0 && (ch === "," || ch === ";" || ch === "\n")) {
      start = i + 1;
      break;
    }
  }
  const fragment = text.slice(start, equalsIndex);
  const m = fragment.match(/^\s*(?:const|let|var|public|private|readonly|\s)*?([A-Za-z_$][\w$]*)\s*(?::|$)/);
  return m ? m[1] : null;
}

/**
 * Every switch a TypeScript or JavaScript source READS, and every one it WRITES.
 *
 * The axis is what the product can be configured WITH, so an assignment is not a read:
 * `injector.ts` sets `env.DTM_GIT_USERNAME` for a child process, and counting that as a read put a
 * switch in the grid at a site that never looks at it — while its real reader, a C# file, was
 * outside the walk entirely.
 *
 * `problems` collects a lookup whose key this parser cannot name. `allowDynamic` is the pinned set
 * of `file:identifier` pairs a human has looked at and accepted — an exemption that is WRITTEN
 * DOWN rather than pattern-matched, because the first version recognised the one legitimate case
 * by the text of its line and swallowed anything else that line happened to look like.
 */
export function readSwitchesFromScript(source, file = "<source>", problems = [], allowDynamic = []) {
  const { text, inString } = stripCommentsWithMask(source);
  const envIdents = environmentIdentifiers(text);
  const read = new Set();
  const written = new Set();

  // **Escape all of it, not the character that came to mind.** These names are read out of source
  // text this parser does not control, and the first version escaped `$` alone — the one metacharacter
  // a JS identifier can legally carry. CodeQL called it (`js/incomplete-sanitization`, high) on #670,
  // and it is the same family as every other finding this week: a rule narrowed to the case its author
  // pictured. A fragment carrying `.` or `(` would have built a regex that matches something else
  // entirely, silently, and the axis would come back wrong rather than short.
  const holder = "(?:process\\.env|" + [...envIdents].map(escapeForRegExp).join("|") + ")";
  const holderRe = envIdents.size > 0 ? holder : "process\\.env";

  // `NAME` after the holder, and the `=` that follows decides read or write. `==` and `=>` are not
  // assignments; `===` is not either.
  for (const m of text.matchAll(new RegExp(`\\b${holderRe}\\.([A-Za-z_][A-Za-z0-9_]*)\\b\\s*(=[^=>]|$|[^=])`, "g"))) {
    (m[2]?.startsWith("=") ? written : read).add(m[1]);
  }
  for (const m of text.matchAll(new RegExp(`\\b${holderRe}\\[\\s*["']([^"']+)["']\\s*\\]\\s*(=[^=>]|$|[^=])`, "g"))) {
    (m[2]?.startsWith("=") ? written : read).add(m[1]);
  }

  // A key held in a constant. The name is still a literal, just not at the lookup.
  const bound = new Map();
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*["']([^"']+)["']\s*;/g)) {
    bound.set(m[1], m[2]);
  }
  for (const m of text.matchAll(new RegExp(`\\b${holderRe}\\[\\s*([A-Za-z_$][\\w$]*)\\s*\\]`, "g"))) {
    const resolved = bound.get(m[1]);
    if (resolved !== undefined) {
      read.add(resolved);
      continue;
    }
    if (allowDynamic.includes(`${file}:${m[1]}`)) continue;
    problems.push(`${file}: a switch is read through a key this parser cannot name: env[${m[1]}]`);
  }

  // **The one loss this rule could still take in silence.** Recognising an environment by its
  // binding means an UNTYPED, UNDEFAULTED holder is not one — correct, and it is how the
  // `TouchEnvironment` bag is rejected. But `someBag["DESKTOP_TOUCH_X"]` would then contribute
  // nothing and say nothing. So a name SHAPED like one of ours, read from a holder this parser
  // cannot confirm, is reported. The prefix is a heuristic for a WARNING here, never for
  // membership — `GITHUB_TOKEN` is a switch and carries no prefix, which is why membership is
  // pinned in the fixture instead.
  const shaped = /\b(?:DESKTOP_TOUCH|DTM)_[A-Z0-9_]+\b/;
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\.\s*((?:DESKTOP_TOUCH|DTM)_[A-Z0-9_]+)|\[\s*["']((?:DESKTOP_TOUCH|DTM)_[A-Z0-9_]+)["']\s*\])/g)) {
    if (inString[m.index]) continue;
    // An assignment is a write, and the write set is pinned separately.
    if (/^\s*=[^=>]/.test(text.slice(m.index + m[0].length))) continue;
    const holderName = m[1];
    const name = m[2] ?? m[3];
    if (holderName === "env" && envIdents.has("env")) continue;
    if (envIdents.has(holderName) || holderName === "process") continue;
    if (read.has(name) || written.has(name)) continue;
    if (!shaped.test(name)) continue;
    problems.push(`${file}: ${name} is read from \`${holderName}\`, which this parser cannot confirm is an environment`);
  }

  return { read: [...read].sort(), written: [...written].sort() };
}

/**
 * Every switch a Rust source reads.
 *
 * These carry the axis's one lattice constraint: **a switch only the addon reads cannot be
 * exercised in a build with no addon**, so it is not a free dimension to multiply by.
 *
 * Spelled four ways, because `use std::env;` is one refactor away from the 21 fully-qualified call
 * sites in the tree and the version that anchored on `std::env::var` would have gone silent for
 * every one of them.
 */
export function readSwitchesFromRust(source, file = "<source>", problems = []) {
  const { text, inString } = stripRustComments(source);
  const names = new Set();
  const call = /\b(?:std::)?env::var(?:_os)?\s*\(|(?<![:\w])var(?:_os)?\s*\(/g;
  const bareImported = /\buse\s+std::env::(?:var|\{[^}]*\bvar\b[^}]*\})/.test(text);
  for (const m of text.matchAll(call)) {
    // **A call quoted inside a string is prose.** An error message telling the user what to set is
    // exactly that shape, and its escaped quotes made the literal unreadable — so it raised a
    // problem that never went away, and `--update` could never re-pin again. A gate that cannot be
    // re-pinned is a gate somebody deletes.
    if (inString[m.index]) continue;
    const isBare = !m[0].includes("env::");
    if (isBare && !bareImported) continue;
    const rest = text.slice(m.index + m[0].length);
    const literal = rest.match(/^\s*"([^"]+)"\s*\)/);
    if (literal) {
      names.add(literal[1]);
      continue;
    }
    problems.push(`${file}: a switch is read through a key this parser cannot name: ${m[0].trim()}${rest.trim().slice(0, 30)}`);
  }
  return [...names].sort();
}

/**
 * Rust's comments, including the trailing and block forms — and not inside a string literal.
 *
 * Returns the stripped text and a mask saying which of its characters sit inside a string, because
 * the caller needs to tell a call from a call QUOTED IN PROSE.
 */
/**
 * A Rust raw-string opener at `i`, or `null`: `r"`, `r#"`, `br##"`, … with any number of `#`.
 *
 * Counted rather than matched inside a fixed slice. Rust permits up to 255 `#`, and the count is
 * what the closing delimiter has to match, so an opener this reader declines to recognise is a
 * literal it then walks INTO — where a `"` is a delimiter again and every following quote is
 * counted with the wrong parity.
 */
function readRustRawOpener(text, i) {
  let k = i;
  if (text[k] === "b") k++;
  if (text[k] !== "r") return null;
  k++;
  const from = k;
  while (text[k] === "#") k++;
  if (text[k] !== '"') return null;
  return { hashes: text.slice(from, k), openEnd: k + 1 };
}

function stripRustComments(source) {
  const text = source.replace(/\r\n/g, "\n");
  let out = "";
  const mask = [];
  const push = (chars, within) => {
    out += chars;
    for (let k = 0; k < chars.length; k++) mask.push(within ? 1 : 0);
  };
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      push(ch, true);
      if (ch === "\\" && i + 1 < text.length) {
        push(text[i + 1], true);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    // **A raw string, which this reader did not know existed.** `r"…"`, `r#"…"#`, `r##"…"##` and the
    // byte forms `b`/`br`: inside one, a `\` is an ordinary character and the run ends only at a
    // `"` followed by the SAME number of `#`. Entering it as a normal string desyncs on any odd
    // number of quotes inside — `r#"a " b"#` swallowed the rest of the file and the switch after it
    // was lost (win2, 2026-09-18, reproduced here).
    //
    // **And mac's own sweep had called this shape safe**, because the example it fired
    // (`r#"say "hi" here"#`) happens to hold an EVEN number of quotes, so the state came back in
    // sync by luck. A shape that was not fired looks exactly like a shape that passed.
    // **The `#` run is counted, not windowed.** This was `/^(?:b?r)(#*)"/` against `slice(i, i + 12)`,
    // which recognises ten `#` for `r` and nine for `br` — Rust permits 255. Past the window the
    // opener stops being an opener, the literal is entered as an ordinary string, and the first
    // unpaired `"` inside it desynchronises the scan for the rest of the file. `problems` stays
    // empty: measured by win2 at exactly the arithmetic bound (`r` survives `#`×10 and dies at 11,
    // `br` survives 9 and dies at 10, the prefix eating one character of the window).
    //
    // **A bound whose grounds are not written down is a bound nobody can check.** Where this file
    // does keep one — the three characters for a C# verbatim prefix below — the grammar guarantees
    // it, and the comment says so. Twelve was not that; it was a number that fit the examples.
    const raw = readRustRawOpener(text, i);
    if (raw !== null && !/[A-Za-z0-9_]/.test(text[i - 1] ?? "")) {
      const close = `"${raw.hashes}`;
      const openEnd = raw.openEnd;
      const at = text.indexOf(close, openEnd);
      const end = at === -1 ? text.length : at + close.length;
      for (let j = i; j < end; j++) push(text[j], j >= openEnd - 1 && j < end - raw.hashes.length);
      i = end;
      continue;
    }
    if (ch === '"') {
      inString = true;
      push(ch, false);
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    // **No regex-literal rule here: Rust has none.** This branch was copied in from the TypeScript
    // strip on 2026-09-18 while fixing that one, and a `/` in Rust is division. It was inert — the
    // scan pushes the characters it walks and stops at the newline, so nothing was lost — and inert
    // is the point: **a rule from another language's grammar sitting in this reader is the drift the
    // per-language readers exist to prevent.** Removed, with a cell that shoots division here and a
    // regex literal at the TypeScript reader.
    if (ch === "/" && text[i + 1] === "*") {
      // The separator, for the same reason as the other three strippers — Rust's block comments
      // nest, which is the only part of this branch that differs.
      push(" ", false);
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (text[j] === "*" && text[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          if (text[j] === "\n") push("\n", false);
          j++;
        }
      }
      i = j;
      continue;
    }
    push(ch, false);
    i++;
  }
  return { text: out, inString: mask };
}

/**
 * Every switch a C# side tool reads.
 *
 * `tools/key-askpass/Program.cs` ships as an executable the server SPAWNS, and it reads three
 * switches that appear nowhere in TypeScript or Rust. The first version of this walk had no `.cs`
 * in its extension list, so two of them (`DTM_LOCKER_PIPE`, `DTM_ASKPASS_TICKET`) were dimensions
 * the grid did not count at all, and a third (`DTM_GIT_USERNAME`) was pinned at a TypeScript site
 * that only WRITES it.
 */
/**
 * C#'s comments — and its two string forms, which are not TypeScript's.
 *
 * **C# was being read with the TypeScript strip**, and the rule that differs is the one that bit: in
 * a VERBATIM string (`@"…"`) a backslash is an ordinary character and the run ends at a `"` (doubled
 * `""` escapes one). TypeScript's rule treats the `\` as an escape, so `@"C:\dir\"` did not end
 * where it ends — and the real `//` comment after it was never stripped, which made a
 * COMMENTED-OUT switch name count as a live switch (win2, 2026-09-18; reproduced here, the answer
 * was `["DTM_SENTINEL_LAYER", "SWALLOWED"]`).
 *
 * The two languages' errors point opposite ways from the same cause: Rust's missing raw string LOSES
 * a switch, C#'s misread verbatim string INVENTS one.
 */
function stripCSharpComments(source) {
  const text = source.replace(/\r\n/g, "\n");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // `@"…"` / `$@"…"` / `@$"…"` — no escapes, `""` is one quote.
    const verbatim = /^(?:@\$?|\$@)"/.exec(text.slice(i, i + 3));
    if (verbatim !== null) {
      out += text.slice(i, i + verbatim[0].length);
      i += verbatim[0].length;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          out += '""';
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i];
        out += c;
        i++;
        if (c === "\\") {
          out += text[i] ?? "";
          i++;
          continue;
        }
        if (c === quote || c === "\n") break;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      // **A block comment separates two tokens; deleting it joins them** — `foo/**/bar` came out
      // as `foobar` (gate 2 on #679, round 2). The separator is kept, and the newlines still land
      // where they did, because the contract here is the line index, not the column.
      out += " ";
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      for (let j = i; j < end; j++) if (text[j] === "\n") out += "\n";
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function readSwitchesFromCSharp(source, file = "<source>", problems = []) {
  const text = stripCSharpComments(source);
  const names = new Set();
  for (const m of text.matchAll(/\bEnvironment\.GetEnvironmentVariable\s*\(\s*([^)]*)\)/g)) {
    const literal = m[1].trim().match(/^"([^"]+)"$/);
    if (literal) names.add(literal[1]);
    else problems.push(`${file}: a switch is read through a key this parser cannot name: GetEnvironmentVariable(${m[1].trim().slice(0, 30)})`);
  }
  return [...names].sort();
}

/**
 * The switches a README names, split into the ones it documents and the ones it BURIES.
 *
 * A removed switch keeps its name on purpose: a user whose config still sets it needs to be told it
 * does nothing. A sweep that cannot tell a tombstone from a live entry reports every tombstone as a
 * lie, and a gate that cries wolf on day one is a gate somebody turns off.
 *
 * `headings` is the list of spellings that mark one. **The Japanese page writes `削除済み:`**, and a
 * fix found in one language does not propagate by itself — with only the English spelling the ja
 * page's tombstone could never match, so a switch buried there would read as documented-but-unread
 * forever.
 *
 * **`pattern` is a naming convention, and here that is legitimate.** Membership in the AXIS cannot
 * be decided by a prefix — `GITHUB_TOKEN` is a switch and does not carry one. But this function
 * answers a different question: "does the prose make a claim about one of OUR switches?" A README
 * mentioning `PATH` or `JSON` is not making that claim, and scanning every capitalised token would
 * bury the real finding under prose. The convention holds for every name the product owns.
 */
export function readDocumentedSwitches(readme, headings = ["Removed:", "削除済み:"], pattern = /\b(?:DESKTOP_TOUCH|DTM)_[A-Z0-9_]+\b/g) {
  const documented = new Set();
  const tombstoned = new Set();
  const escaped = headings.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const heading = new RegExp(`^#{1,6}\\s+(?:${escaped})`);
  let inFence = false;
  for (const line of readme.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    // A heading inside a fenced block is an EXAMPLE of a tombstone, not one.
    const isTombstone = !inFence && heading.test(line);
    for (const m of line.matchAll(new RegExp(pattern.source, "g"))) {
      // **Not `continue` on the heading.** `### Removed: \`A\` and \`B\`` used to bury A and drop B
      // from both sets, so B was either accused of having no tombstone or documented invisibly.
      if (isTombstone) tombstoned.add(m[0]);
      else if (!inFence) documented.add(m[0]);
    }
  }
  for (const name of tombstoned) documented.delete(name);
  return { documented: [...documented].sort(), tombstoned: [...tombstoned].sort() };
}
