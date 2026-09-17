/**
 * ADR-036 `internal#119` — the recognizer half of `check:native-types`.
 *
 * **These cells exist because the first version's mutants could not have found any of this.** They
 * edited the two TS files, so they measured the COMPARISON; five ordinary Rust spellings made a
 * struct or a field disappear from the input and the run still printed OK (gate 2 on PR #668).
 * A guard whose stated purpose is "a struct nobody compares is the state this section exists to
 * end" may not drop one silently, so every spelling below asserts a PROBLEM, not a smaller count.
 */
import { describe, expect, it } from "vitest";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  isFeatureGated,
  parseNapiFunctions,
  parseNapiObjectStructs,
  parseTsFunctionParams,
  parseTsInterfaces,
  scanNapiAttributes,
} from "../../scripts/lib/napi-shapes.mjs";

const parse = (src: string) => parseNapiObjectStructs(src, "fixture.rs");

describe("the struct recognizer", () => {
  it("reads a plain struct, and marks Option fields", () => {
    const { structs, problems } = parse(`
#[napi(object)]
pub struct Thing {
    pub a: u32,
    pub b: Option<String>,
}
`);
    expect(problems).toEqual([]);
    expect([...structs.keys()]).toEqual(["Thing"]);
    expect([...structs.get("Thing")!.fields].map(([n, d]) => [n, d.optional])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    // **Every field carries its own line.** A finding used to anchor the struct's attribute — on
    // the real machine that was 25 lines above the field it was about (win2, 2026-09-17).
    expect(structs.get("Thing")!.fields.get("a")!.at).toBe("fixture.rs:4");
  });

  it("survives a multi-line attribute between the napi line and the struct", () => {
    const { structs, problems } = parse(`
#[napi(object)]
#[derive(
    Debug,
)]
pub struct Thing {
    pub a: u32,
}
`);
    expect(problems).toEqual([]);
    expect(structs.get("Thing")!.fields.size).toBe(1);
  });

  it("accepts a trailing comment on the attribute, and `object` after another argument", () => {
    expect(parse(`
#[napi(object)] // flat, see the doc above
pub struct Thing {
    pub a: u32,
}
`).structs.has("Thing")).toBe(true);

    const { structs } = parse(`
#[napi(js_name = "Other", object)]
pub struct Thing {
    pub a: u32,
}
`);
    // **The JS name is what the addon emits, so it is what pairs with a TS interface.**
    expect([...structs.keys()]).toEqual(["Other"]);
    expect(structs.get("Other")!.rustName).toBe("Thing");
  });

  it("does not read prose that mentions the attribute", () => {
    // `src/uia/types.rs` opens with "All structs use `#[napi(object)]`", and `l1_capture/ring.rs`
    // documents a struct as deliberately napi-FREE by naming it. Both used to be read as
    // declarations — loudly, but about structs that do not exist.
    const { structs, problems } = parse(`
//! All structs use \`#[napi(object)]\` so napi-rs maps them directly.

/// Keep this type napi-free so it never gets pulled into \`#[napi(object)]\` codegen.
#[derive(Clone)]
pub struct NotForJs {
    pub a: u32,
}
`);
    expect(problems).toEqual([]);
    expect(structs.size).toBe(0);
  });

  it("reports a field it cannot read instead of dropping it", () => {
    // A wrapped type, and a same-line attribute. Silent when TS also lacks the field; worse when
    // TS declares it, because the message then sends the reader to delete a correct declaration.
    expect(parse(`
#[napi(object)]
pub struct Thing {
    pub a:
        u32,
}
`).problems.join("")).toMatch(/cannot read as a field/);

  });

  it("reads a field that shares its line with an attribute", () => {
    // Skipping the whole line dropped the field with no trace. The attribute is stripped by
    // bracket depth, not by the first `]`, because one can carry its own (`ts_type = \"A[]\"`).
    const { structs, problems } = parse(`
#[napi(object)]
pub struct Thing {
    #[cfg(windows)] pub a: u32,
}
`);
    expect(problems).toEqual([]);
    expect([...structs.get("Thing")!.fields.keys()]).toEqual(["a"]);
  });

  it("does not let a brace inside a block comment truncate the field list", () => {
    const { structs, problems } = parse(`
#[napi(object)]
pub struct Thing {
    pub a: u32,
    /* JSON shape:
    {
    }
    */
    pub b: u32,
}
`);
    expect(problems).toEqual([]);
    expect([...structs.get("Thing")!.fields.keys()]).toEqual(["a", "b"]);
  });

  it("reads a one-line body instead of harvesting the next struct's fields", () => {
    // The first version walked to the next bare `}` and took the NEXT struct's fields, which
    // turned one collapsed line into 26 findings that all named the wrong struct. The brace scan
    // reads it properly now, and `Other` stays its own struct.
    const { structs, problems } = parse(`
#[napi(object)]
pub struct Thing { pub a: u32 }

#[napi(object)]
pub struct Other {
    pub b: u32,
}
`);
    expect(problems).toEqual([]);
    expect([...structs.get("Thing")!.fields.keys()]).toEqual(["a"]);
    expect([...structs.get("Other")!.fields.keys()]).toEqual(["b"]);
  });

  it("reads an attribute that wraps, and one followed by a block comment", () => {
    // Both spellings made the whole struct vanish with the run printing OK: the line-shaped regex
    // enumerated ONE trailing form (`//`) and could not span lines, and a non-match fell through
    // before the declaration was even counted (gate 2, second pass).
    expect(parse(`
#[napi(
    object,
)]
pub struct Thing {
    pub a: u32,
}
`).structs.has("Thing")).toBe(true);
    expect(parse(`
#[napi(object)] /* flat */
pub struct Thing {
    pub a: u32,
}
`).structs.has("Thing")).toBe(true);
    // An argument carrying its own parenthesis or bracket, which the narrowed regex also lost.
    expect(parse(`
#[napi(object, ts_args_type = "(a: number) => void")]
pub struct Thing {
    pub a: u32,
}
`).structs.has("Thing")).toBe(true);
  });

  it("counts a declaration it cannot parse, so the count can report it", () => {
    // The count used to be incremented INSIDE the branch the attribute regex guarded, so a
    // spelling the recognizer could not read was never counted and the arithmetic always
    // balanced — while the comment said the count made a silent drop impossible.
    const { structs, problems } = parse(`
#[napi(object)]
pub enum Thing {
    A,
}
`);
    expect(structs.size).toBe(0);
    expect(problems.join("")).toMatch(/could not find the `pub struct` line/);
  });

  it("reads a field behind a closed block comment on its own line", () => {
    // The twin of the same-line attribute: the prefix was thrown away with the field behind it.
    const { structs, problems } = parse(`
#[napi(object)]
pub struct Thing {
    /* see above */ pub a: u32,
}
`);
    expect(problems).toEqual([]);
    expect([...structs.get("Thing")!.fields.keys()]).toEqual(["a"]);
  });

  it("treats a fully-qualified Option as optional", () => {
    const { structs } = parse(`
#[napi(object)]
pub struct Thing {
    pub a: std::option::Option<u32>,
}
`);
    expect(structs.get("Thing")!.fields.get("a")!.optional).toBe(true);
  });

  it("refuses two structs with one JS name instead of keeping whichever came last", () => {
    // The `#[cfg(windows)]` / `#[cfg(not(windows))]` stub pair this repo already uses for
    // functions is exactly this shape, and platform gates are deliberately NOT skipped.
    const { problems } = parse(`
#[napi(object)]
pub struct Thing {
    pub a: u32,
}

#[napi(object)]
pub struct Thing {
    pub b: u32,
}
`);
    expect(problems.join("")).toMatch(/already declared/);
  });

  it("skips a feature-gated struct, because its twin carries the other build's shape", () => {
    const { structs, problems } = parse(`
#[cfg(not(feature = "vision-gpu"))]
#[napi(object)]
pub struct CapabilityProfile {
    pub backend_built: bool,
}
`);
    expect(problems).toEqual([]);
    expect(structs.size).toBe(0);
  });

  it("reports an unterminated body", () => {
    expect(parse(`
#[napi(object)]
pub struct Thing {
    pub a: u32,
`).problems.join("")).toMatch(/no closing brace/);
  });
});

describe("the interface recognizer", () => {
  it("reads fields and their optionality", () => {
    const { interfaces, problems } = parseTsInterfaces(`
export interface Thing {
  /** doc */
  a: number
  b?: string | null
}
`);
    expect(problems).toEqual([]);
    expect([...interfaces.get("Thing")!].map(([n, d]) => [n, d.optional])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("reports a declaration it cannot read rather than making that side of the check vanish", () => {
    // An `extends` used to make an interface invisible. Against `index.d.ts` that surfaced as "no
    // interface for X"; against `native-types.ts`, where an unpaired struct is skipped by design,
    // it disabled the whole half in silence.
    expect(parseTsInterfaces("export interface Thing extends Base {\n  a: number\n}\n").problems.join("")).toMatch(
      /does not follow/,
    );
    expect(parseTsInterfaces("export type Thing = {\n  a: number\n}\n").problems.join("")).toMatch(/not a plain/);
  });

  it("reads `readonly` and `export declare interface`, which used to vanish", () => {
    // `readonly` is already live in `native-types.ts`; the first version dropped such a line with
    // no problem, so the comparison then reported the field as MISSING from a file that declares
    // it — sending the reader to add a line that is already there.
    const { interfaces, problems } = parseTsInterfaces(`
export declare interface Thing {
  readonly a: number
  b?: string
}
`);
    expect(problems).toEqual([]);
    expect([...interfaces.get("Thing")!].map(([n, d]) => [n, d.optional])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("reports what it cannot read in a body, and a name declared twice", () => {
    expect(parseTsInterfaces("export interface Thing {\n  [k: string]: unknown\n}\n").problems.join("")).toMatch(
      /cannot read as a field/,
    );
    expect(
      parseTsInterfaces("export interface Thing {\n  a: number\n}\nexport interface Thing {\n  b: number\n}\n")
        .problems.join(""),
    ).toMatch(/declared twice/);
  });

  it("understands a method signature as carrying no field", () => {
    // `NativeDirtyRectSubscription` describes a napi CLASS; a `#[napi(object)]` field can never be
    // a method, so this is recognised rather than reported — and rather than silently skipped.
    const { interfaces, problems } = parseTsInterfaces(`
export interface Thing {
  a: number
  next(timeoutMs: number): Promise<number>
}
`);
    expect(problems).toEqual([]);
    expect([...interfaces.get("Thing")!.keys()]).toEqual(["a"]);
  });
});

describe("the gate predicate", () => {
  const at = (src: string) => {
    const lines = src.split("\n");
    return isFeatureGated(lines, lines.findIndex((l) => l.includes("#[napi")));
  };

  it("calls a cargo feature gate a feature gate", () => {
    expect(at(`
#[cfg(feature = "vision-gpu")]
#[napi]
pub fn thing() {}
`)).toBe(true);
    expect(at(`
#[cfg(not(feature = "vision-gpu"))]
#[napi(object)]
pub struct Thing {}
`)).toBe(true);
  });

  it("does not call a platform gate one", () => {
    // Treating `#[cfg(windows)]` as out of scope is how a Windows-only `#[napi] pub fn` could go
    // undeclared with the run still green — the #667 defect class, on the function side.
    expect(at(`
#[cfg(windows)]
#[napi]
pub fn thing() {}
`)).toBe(false);
    expect(at(`
#[cfg(target_os = "macos")]
#[napi]
pub fn thing() {}
`)).toBe(false);
  });

  it("looks past unrelated attributes and doc comments, and stops at code", () => {
    expect(at(`
#[cfg(feature = "x")]
/// doc
#[derive(Debug)]
#[napi]
pub fn thing() {}
`)).toBe(true);
    expect(at(`
#[cfg(feature = "x")]
pub fn other() {}

#[napi]
pub fn thing() {}
`)).toBe(false);
  });
});

describe("the attribute entry", () => {
  const scan = (src: string) => scanNapiAttributes(src, "fixture.rs");

  it("matches on the path, not on one spelling", () => {
    // **This is where three rounds of fixes kept leaking.** The inside was rewritten twice while
    // the entry stayed the literal `#[napi(`; `src/uia/` writes it fully qualified, and 13 structs
    // were outside the check with the run printing OK.
    for (const spelling of ["#[napi(object)]", "#[napi_derive::napi(object)]", "#[ ::napi_derive :: napi (object) ]"]) {
      const { structs, problems } = parseNapiObjectStructs(
        `${spelling}\npub struct Thing {\n    pub a: u32,\n}\n`,
        "fixture.rs",
      );
      expect(problems, spelling).toEqual([]);
      expect(structs.has("Thing"), spelling).toBe(true);
    }
  });

  it("reports a napi attribute it cannot follow instead of walking past it", () => {
    // `cfg_attr` is not followed. **Saying so is the point** — the same door must not pass a
    // spelling that was read and one that was not.
    expect(scan("#[cfg_attr(windows, napi(object))]\npub struct Thing {}\n").problems.join("")).toMatch(
      /does not follow it/,
    );
  });

  it("ignores attributes that are not napi, and prose that names one", () => {
    const { attrs, problems } = scan(`
//! All structs use \`#[napi(object)]\`.
#[derive(Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thing {}
`);
    expect(problems).toEqual([]);
    expect(attrs).toEqual([]);
  });

  it("covers every napi attribute spelling the tree actually uses", () => {
    // **The fixtures come from the tree, not from the spellings a review happened to name.**
    // Every round so far fixed the spellings someone thought of and left the next one silent.
    const root = join(__dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".rs")) files.push(p);
      }
    };
    walk(root);
    const heads = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/^[ \t]*#\[([A-Za-z_][A-Za-z0-9_:\s]*?)[\s(\]]/gm)) {
        const path = m[1].replace(/\s+/g, "");
        // **Harvested by a DIFFERENT rule than the recognizer's own.** Collecting with
        // `last segment === "napi"` could only ever feed the recognizer spellings it already
        // accepts — a fixture structurally unable to fail for the class that leaks (gate 2, fourth
        // pass). `napi` as a SUBSTRING is broader: an alias like `napi_alias` is harvested, and the
        // assertion below is then "read it or report it", never "pass quietly".
        if (/napi/.test(path)) heads.add(path);
      }
    }
    expect(heads.size).toBeGreaterThan(1); // the tree really does spell it more than one way
    for (const path of heads) {
      const src = `use napi_derive::napi as ${path.split("::").pop()};\n#[${path}(object)]\npub struct Thing {\n    pub a: u32,\n}\n`;
      const { attrs, problems } = scan(path.split("::").pop() === "napi" ? src.split("\n").slice(1).join("\n") : src);
      // Read it, or say it could not be read. Never silence.
      expect(attrs.length > 0 || problems.length > 0, path).toBe(true);
    }
  });
});

describe("the function and parameter recognizers", () => {
  it("reads a fully-qualified attribute, a js_name, and a signature that wraps", () => {
    const { functions, problems } = parseNapiFunctions(
      `
#[napi_derive::napi]
pub fn plain_one(x: u32) -> u32 { x }

#[napi(js_name = "renamed")]
pub fn other_one() -> u32 { 1 }

#[napi]
pub fn takes_options(
    opts: uia::tree::GetElementsOptions,
) -> u32 { 1 }
`,
      "fixture.rs",
    );
    expect(problems).toEqual([]);
    expect([...functions.keys()].sort()).toEqual(["plainOne", "renamed", "takesOptions"]);
    // **The parameter type is the last segment**, because that is how the struct is keyed.
    expect(functions.get("takesOptions")!.paramType).toBe("GetElementsOptions");
  });

  it("leaves class members alone", () => {
    const { functions } = parseNapiFunctions(
      `
#[napi(constructor)]
pub fn new(a: u32) -> Self { Self {} }

#[napi]
pub fn method(&self) -> u32 { 1 }
`,
      "fixture.rs",
    );
    expect([...functions.keys()]).toEqual([]);
  });

  it("reads the inline parameter object a .d.ts declares", () => {
    // The argument shapes have no named interface: they are written at the function.
    const params = parseTsFunctionParams(
      'export declare function uiaClickElement(opts: { windowTitle: string; name?: string }): Promise<void>\n',
    );
    expect([...params.get("uiaClickElement")!].map(([n, d]) => [n, d.optional])).toEqual([
      ["windowTitle", false],
      ["name", true],
    ]);
  });
});

describe("the function scan says what it could not read", () => {
  const fns = (src: string) => parseNapiFunctions(src, "fixture.rs");

  it("reads an async, unsafe, generic or comment-separated export", () => {
    // **Four spellings that used to leave through a quiet `continue`**, each an undeclared export
    // with the run printing OK and the export count unmoved (gate 2, fourth pass). The block
    // comment is the sharpest: the STRUCT walk had learned it a round earlier — same spelling, one
    // function over, silent.
    const { functions, problems } = fns(`
#[napi]
pub async fn one() -> u32 { 1 }

#[napi]
pub unsafe fn two(x: u32) -> u32 { x }

#[napi]
pub fn three<T: Clone>(x: u32) -> u32 { x }

#[napi]
/* keep this one */
pub fn four(x: u32) -> u32 { x }
`);
    expect(problems).toEqual([]);
    expect([...functions.keys()].sort()).toEqual(["four", "one", "three", "two"]);
  });

  it("reports an item it cannot read instead of dropping the export", () => {
    const { problems } = fns(`
#[napi]
pub static NOT_A_FUNCTION: u32 = 1;
`);
    expect(problems.join("")).toMatch(/cannot read the item/);
  });

  it("follows a napi attribute imported under another name", () => {
    // `use napi_derive::napi as napi_alias;` made both scans blind, with nothing reported.
    const { functions, problems } = fns(`
use napi_derive::napi as napi_alias;

#[napi_alias]
pub fn aliased(x: u32) -> u32 { x }
`);
    expect(problems).toEqual([]);
    expect([...functions.keys()]).toEqual(["aliased"]);

    const grouped = parseNapiObjectStructs(
      `use napi_derive::{napi as n};\n#[n(object)]\npub struct Thing {\n    pub a: u32,\n}\n`,
      "fixture.rs",
    );
    expect(grouped.structs.has("Thing")).toBe(true);
  });

  it("records what a function returns, so an argument shape can be told from a returned one", () => {
    const { functions } = fns(`
#[napi]
pub fn takes_and_returns(opts: uia::types::BoundingRect) -> napi::Result<BoundingRect> { todo!() }
`);
    const def = functions.get("takesAndReturns")!;
    expect(def.paramType).toBe("BoundingRect");
    expect(def.returns).toContain("BoundingRect");
  });

  it("refuses two exports with one JS name", () => {
    expect(
      fns(`
#[napi]
pub fn twice(x: u32) -> u32 { x }

#[napi(js_name = "twice")]
pub fn other(x: u32) -> u32 { x }
`).problems.join(""),
    ).toMatch(/already exported/);
  });
});
