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

/** The document a client receives: the SDK's converter, with the SDK's own options. */
const wire = (schema: any): any => toJsonSchemaCompat(schema);

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
    it("is spelled `anyOf`, and that is the only key on it", () => {
      expect(Object.keys(method).sort()).toEqual(["anyOf"]);
    });
    it("carries the two branches that disagree in kind — an enum and a const", () => {
      expect(method.anyOf).toHaveLength(2);
      expect(method.anyOf[0].enum).toEqual([
        "auto",
        "background",
        "foreground",
        "foreground_flash",
      ]);
      expect(method.anyOf[1].const).toBe("foreground");
    });
    it("is NOT a type array — the spelling #657 cannot say the API accepts", () => {
      expect(Array.isArray(method.type)).toBe(false);
    });
  });

  describe("terminal.until — the nested union", () => {
    const until = wire(terminalRegistrationSchema).properties.until as any;
    it("is spelled `oneOf`, and that is the only key on it", () => {
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
