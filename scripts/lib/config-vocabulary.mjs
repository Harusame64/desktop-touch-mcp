// ADR-036 — the CONFIGURATION axis of the completion grid, read out of the source.
//
// The gate's denominator is "the vocabulary extracted from the code × configuration × result"
// (the user's decision, 2026-09-11). The road axis got its extractor in #669; this is the second
// of the three. The same rule applies: **extracted, not hand-listed**, so that a switch added in
// code cannot quietly become a dimension nobody counted.
//
// **What makes this one hard is that a switch has five reading shapes**, and the obvious sweep
// (`process.env.NAME`) sees one and a half of them. Counted on `06a66999`, `process.env.*` alone
// finds 54 of the 65 the product actually reads — and the eleven it misses include the two the map
// says DEFINE the grid (`DISABLE_NATIVE_UIA`, which makes native UIA's third value, and
// `KEYBOARD_RUNG_UNCHECKED`, which deletes a column). The shapes:
//
//  1. `process.env.NAME`
//  2. `process.env["NAME"]`
//  3. `env.NAME` / `env["NAME"]` — an INJECTED environment. Half the engine is written this way
//     (`readKeyboardRungSwitch(env: NodeJS.ProcessEnv = process.env)`) precisely so cells can drive
//     it, which is exactly why the sweep that misses it misses the testable switches.
//  4. `process.env[CONST]` where `const CONST = "NAME"` sits elsewhere in the file. The name is
//     still a literal; it is just not at the lookup. (`reachable-bounds.ts` reads
//     `DESKTOP_TOUCH_CAPTURE_BACKEND` this way — the same shape the road extractor had to learn to
//     report, one axis over.)
//  5. `std::env::var("NAME")` in the Rust addon. **A TypeScript-only sweep cannot see these at
//     all**, and they carry a real lattice constraint: a switch only the addon reads cannot be
//     exercised in a build that has no addon.
//
// A name that no shape can resolve is REPORTED. A shorter set is indistinguishable from a complete
// one, and that is the failure this file exists to end.

/** Strip `//` and block comments, keeping every line's index. Shared shape with the road extractor. */
export function stripComments(source) {
  const out = source.replace(/\r\n/g, "\n").split("\n");
  let inBlock = false;
  for (let i = 0; i < out.length; i++) {
    let line = out[i];
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out[i] = "";
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const open = line.indexOf("/*");
      if (open === -1) break;
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 2);
    }
    out[i] = line.replace(/\/\/.*$/, "");
  }
  return out.join("\n");
}

/**
 * A product switch, as opposed to the operating system's own environment.
 *
 * `LOCALAPPDATA`, `SystemRoot`, `PROGRAMFILES(X86)` and friends are read too, and they are not
 * dimensions of the grid — nothing the product does chooses them. Separating on the prefix keeps
 * the axis to what a run can actually be configured WITH.
 */
export const SWITCH_PREFIX = /^(DESKTOP_TOUCH|DTM)_[A-Z0-9_]+$/;

/**
 * Every switch a TypeScript source reads, through all four of its shapes.
 *
 * `problems` collects a lookup whose key this parser cannot name — the one case where the count
 * comes back short with nothing saying so.
 */
export function readSwitchesFromTypeScript(source, file = "<source>", problems = []) {
  const text = stripComments(source);
  const names = new Set();
  const platform = new Set();

  const take = (name) => {
    if (SWITCH_PREFIX.test(name)) names.add(name);
    else platform.add(name);
  };

  // Shapes 1 and 2, on `process.env` and on an injected `env` alike. The `\b` before `env` is what
  // keeps `process.env` from being counted twice and what lets `env` on its own be counted at all.
  for (const m of text.matchAll(/\b(?:process\.)?env\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) take(m[1]);
  for (const m of text.matchAll(/\b(?:process\.)?env\[\s*["']([^"']+)["']\s*\]/g)) take(m[1]);

  // Shape 4: the key is an identifier. Resolve it against a `const NAME = "…"` in the same file.
  const bound = new Map();
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*["']([^"']+)["']\s*;/g)) {
    bound.set(m[1], m[2]);
  }
  for (const m of text.matchAll(/\b(?:process\.)?env\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
    const resolved = bound.get(m[1]);
    if (resolved !== undefined) {
      take(resolved);
      continue;
    }
    // **A genuinely dynamic lookup.** One is legitimate and recognised by its neighbourhood:
    // `raw.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)` expands `%VAR%`
    // tokens out of a registry value, so its key is the REGISTRY's, not a switch of ours. It reads
    // arbitrary environment and contributes no dimension. Recognised narrowly — the recognition
    // asks for the `%…%` replace on the same line, so any OTHER dynamic key still surfaces.
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index));
    if (/%\(\[\^%\]\+\)%|%\(\[\^%\]\*\)%|\/%\(/.test(line) || /replace\(\s*\/%/.test(line)) continue;
    problems.push(`${file}: a switch is read through a key this parser cannot name: env[${m[1]}]`);
  }

  return { names: [...names].sort(), platform: [...platform].sort() };
}

/**
 * Every switch a Rust source reads.
 *
 * These are the addon's own, and they are the reason this axis is a lattice rather than a product:
 * **a switch only the addon reads is unreachable in a build with no addon.** Nothing in the
 * TypeScript tree mentions them at the point of use, so a sweep of `src/**\/*.ts` returns a set
 * that looks complete and is three short.
 */
export function readSwitchesFromRust(source, file = "<source>", problems = []) {
  const text = source.replace(/\r\n/g, "\n").replace(/^\s*(\/\/.*|\/\/!.*)$/gm, "");
  const names = new Set();
  for (const m of text.matchAll(/\bstd::env::var(?:_os)?\(\s*"([^"]+)"\s*\)/g)) {
    if (SWITCH_PREFIX.test(m[1])) names.add(m[1]);
  }
  for (const m of text.matchAll(/\bstd::env::var(?:_os)?\(\s*([^")\s][^)]*)\)/g)) {
    problems.push(`${file}: a switch is read through a key this parser cannot name: std::env::var(${m[1].trim().slice(0, 40)})`);
  }
  return [...names].sort();
}

/**
 * The switches a README names, split into the ones it documents and the ones it BURIES.
 *
 * A removed switch keeps a tombstone (`### Removed: \`NAME\``) on purpose: a user whose config
 * still sets it needs to be told it does nothing. So "named in the README but read nowhere" is not
 * by itself a defect — **it is a defect only when there is no tombstone**, and the sweep that
 * cannot tell the two apart reports every tombstone as a lie and gets ignored.
 */
export function readDocumentedSwitches(readme) {
  const documented = new Set();
  const tombstoned = new Set();
  const lines = readme.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const removed = line.match(/^#{1,6}\s+Removed:\s*`?((?:DESKTOP_TOUCH|DTM)_[A-Z0-9_]+)`?/);
    if (removed) {
      tombstoned.add(removed[1]);
      continue;
    }
    for (const m of line.matchAll(/\b(?:DESKTOP_TOUCH|DTM)_[A-Z0-9_]+\b/g)) documented.add(m[0]);
  }
  for (const name of tombstoned) documented.delete(name);
  return { documented: [...documented].sort(), tombstoned: [...tombstoned].sort() };
}
