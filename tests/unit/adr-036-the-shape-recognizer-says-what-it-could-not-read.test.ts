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

import { isFeatureGated, parseNapiObjectStructs, parseTsInterfaces } from "../../scripts/lib/napi-shapes.mjs";

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
    expect([...structs.get("Thing")!.fields]).toEqual([
      ["a", false],
      ["b", true],
    ]);
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

  it("refuses a one-line body rather than harvesting the next struct's fields", () => {
    const { problems } = parse(`
#[napi(object)]
pub struct Thing { pub a: u32 }

#[napi(object)]
pub struct Other {
    pub b: u32,
}
`);
    expect(problems.join("")).toMatch(/written on one line/);
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
    expect([...interfaces.get("Thing")!]).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("reports a declaration it cannot read rather than making that side of the check vanish", () => {
    // An `extends` used to make an interface invisible. Against `index.d.ts` that surfaced as "no
    // interface for X"; against `native-types.ts`, where an unpaired struct is skipped by design,
    // it disabled the whole half in silence.
    expect(parseTsInterfaces("export interface Thing extends Base {\n  a: number\n}\n").problems.join("")).toMatch(
      /not a plain/,
    );
    expect(parseTsInterfaces("export type Thing = {\n  a: number\n}\n").problems.join("")).toMatch(/not a plain/);
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
