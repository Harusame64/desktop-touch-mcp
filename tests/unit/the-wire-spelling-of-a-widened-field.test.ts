/**
 * #657 — the spelling of a widened field, pinned ON THE DOCUMENT THAT IS SENT.
 *
 * Why this file exists, and why it is not three lines inside another one:
 *
 * `flattenUnionToObjectSchema` widens a field that collides across variants, and two comments in
 * `src/` describe how that widening is spelled. A comment is a claim, not a check — and the first
 * attempt at a check pinned `z.toJSONSchema(schema)` with ITS DEFAULTS
 * (`target: "draft-2020-12"`, `io: "output"`), which is **not the document a client receives**
 * (gate 2, 2026-09-15). The registration path is `registerTool` → `toJsonSchemaCompat` →
 * `z4mini.toJSONSchema(schema, { target: "draft-7", io: "input" })`, and the two differ: under
 * `io: "output"` a `.default()` field is promoted into `required`, so the default rendering of
 * terminal's `until` says `required: ["mode","quietMs"]` where the wire says `required: ["mode"]`.
 * The `oneOf` key agreed, so a pin on the wrong document was green — which is the failure this
 * project keeps meeting: a cell that is green about something other than the thing it names.
 *
 * So this file imports the SDK's own converter, the one `registerTool` calls. It is an internal
 * path of `@modelcontextprotocol/sdk` (1.30.0) and that is the point: a change in how the SDK
 * converts is a change in what ships, and it should arrive here as a failure rather than as a
 * comment nobody re-measured. What is NOT pinned is the SDK's choice of options — this file calls
 * the compat function, so it follows that choice rather than asserting it.
 *
 * The two schemas below are the whole set that ships a widening today: measured across all eight
 * `flattenUnionToObjectSchema` products, `keyboard.method` is the only `z.union` widening, and
 * `terminal.until` the only nested union. Independently swept on the Windows machine over the live
 * wire the same day — 32 tools, zero type arrays, one `anyOf`, one `oneOf`, no top-level either.
 */
import { describe, it, expect } from "vitest";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { keyboardRegistrationSchema } from "../../src/tools/keyboard.js";
import { terminalRegistrationSchema } from "../../src/tools/terminal.js";

/**
 * The document a client receives: the SDK's converter, called with THE OPTIONS `registerTool`
 * passes it (`mcp.js`: `{ strictUnions: true, pipeStrategy: 'input' }`), not with its defaults.
 *
 * The two agree today only because the zod-v4 branch ignores `strictUnions` and defaults `io` to
 * `'input'` — measured: the documents are byte-identical either way. Relying on that is the
 * failure this file was written to close, one level up (gate 2, 2026-09-15): a pin that follows
 * the callee's defaults stays green if the caller's options change, or if a schema ever lands on
 * the v3 branch where `strictUnions` genuinely changes how a union is emitted.
 */
const wire = (schema: any): any =>
  toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: "input" });

/**
 * The spelling of a widened property, read from the document rather than assumed — and it THROWS
 * on a shape it does not recognise, so a third spelling fails loudly instead of passing as an
 * absence. `expect(Array.isArray(x.type)).toBe(false)` cannot do that: it is already implied by
 * the key assertion, and it passes just as well when there is no `type` key at all.
 */
function spellingOf(prop: Record<string, unknown>): "anyOf" | "oneOf" | "type-array" | "single-type" {
  if (Array.isArray(prop.anyOf)) return "anyOf";
  if (Array.isArray(prop.oneOf)) return "oneOf";
  if (Array.isArray(prop.type)) return "type-array";
  if (typeof prop.type === "string") return "single-type";
  throw new Error(
    `spellingOf: unrecognised property shape ${JSON.stringify(prop)} — not anyOf, oneOf, a type ` +
      "array or a single type. A fourth spelling must fail this cell rather than read as an absence.",
  );
}

describe("#657 — the wire spelling of a widened field", () => {
  describe("keyboard.method — the ONE widening that ships", () => {
    // It is a widening because the variants disagree in KIND: `z.enum([...]).default("auto")` in
    // one and `z.literal("foreground").optional()` in another, and `mergeFlatField`'s all-enum
    // merge does not apply to a literal, so it falls through to `z.union`.
    //
    // AND IT IS SPELLED `anyOf`, under zod 4.5.4 — which is why `_envelope.ts` may not say that
    // 4.5.4 "emits a type array" as if that were a property of the version. It is a property of
    // the BRANCH SHAPES: bare scalars collapse into one `type` array, branches that carry their
    // own keywords (`enum`, `const`) cannot be collapsed and stay `anyOf`.
    const method = wire(keyboardRegistrationSchema).properties.method as any;
    it("is spelled `anyOf` — not a type array, which is the spelling #657 cannot vouch for", () => {
      expect(spellingOf(method)).toBe("anyOf");
    });
    // `anyOf` AND NOTHING ELSE — including no `description` and no `default`, which is a DEFECT
    // this cell records rather than blesses: `mergeFlatField` strips the wrappers a `.describe()`
    // hangs on, so 15 of keyboard's 19 properties ship undocumented and `method` loses
    // `default: "auto"` (measured on the wire, both machines; filed as #664). WHEN #664 IS FIXED
    // THIS CELL GOES RED — that is intended, and it means the fix landed, not that it broke.
    it("and `anyOf` is the only key on it — see #664, which this pins rather than approves", () => {
      expect(Object.keys(method).sort()).toEqual(["anyOf"]);
    });
    it("carries the two branches that disagree in kind — an enum and a const, in any order", () => {
      expect(method.anyOf).toHaveLength(2);
      // ORDER-INSENSITIVE on purpose: the branch order follows the variant order in
      // `keyboardSchema`, so moving the `sequence` variant up — a refactor a client cannot
      // observe — would otherwise turn this red with a message about enum values, pointing at
      // zod rather than at the reorder (gate 2, 2026-09-15).
      const enums = method.anyOf
        .map((b: { enum?: string[] }) => b.enum)
        .filter(Boolean)
        .map((e: string[]) => [...e].sort());
      const consts = method.anyOf.map((b: { const?: string }) => b.const).filter(Boolean);
      expect(enums).toEqual([["auto", "background", "foreground", "foreground_flash"]]);
      expect(consts).toEqual(["foreground"]);
    });
  });

  describe("terminal.until — the nested union", () => {
    const until = wire(terminalRegistrationSchema).properties.until as any;
    it("is spelled `oneOf`, and that is the only key on it", () => {
      expect(spellingOf(until)).toBe("oneOf");
      expect(Object.keys(until).sort()).toEqual(["oneOf"]);
    });
    it("carries one branch per `until` mode", () => {
      expect(until.oneOf.map((b: { properties?: { mode?: { const?: string } } }) => b.properties?.mode?.const).sort()).toEqual([
        "exit",
        "pattern",
        "quiet",
      ]);
    });
  });

  // The one shape this repository knows the Anthropic API rejects. Both tools, on the wire.
  it("neither tool carries a TOP-LEVEL oneOf/anyOf", () => {
    for (const schema of [keyboardRegistrationSchema, terminalRegistrationSchema]) {
      const js = wire(schema);
      expect(js.oneOf).toBeUndefined();
      expect(js.anyOf).toBeUndefined();
    }
  });
});
