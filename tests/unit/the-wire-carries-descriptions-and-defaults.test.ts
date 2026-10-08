/**
 * internal #266 — what a tool's schema declares about a field, its description and its default,
 * reaches `tools/list`.
 *
 * win2 measured 2.2.0's wire: 83 descriptions and 51 defaults of the eight flattened tools, and 33
 * defaults on `z.preprocess` fields elsewhere, were lost. Two causes: `flattenUnionToObjectSchema`
 * stripped the wrappers a zod 4 `.describe()` / `.default()` hang on, and the SDK's `io: "input"`
 * conversion does not emit a default outside a `z.preprocess`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { wire } from "./helpers/wire-schema.js";
import { flattenUnionToObjectSchema } from "../../src/tools/_envelope.js";
import { coercedBoolean, coercedBooleanWithDefault } from "../../src/tools/_coerce.js";
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";

const propsOf = (schema: z.ZodTypeAny) => wire(schema).properties as Record<string, Record<string, unknown>>;

describe("coercedBooleanWithDefault", () => {
  it("shows its default on the wire, where coercedBoolean().default() does not", () => {
    const p = propsOf(z.object({ a: coercedBooleanWithDefault(true).describe("a"), b: coercedBoolean().default(true).describe("b") }));
    expect(p.a).toMatchObject({ type: "boolean", default: true, description: "a" });
    expect(p.b.default).toBeUndefined();
  });

  it("parses as coercedBoolean().default() does", () => {
    const s = z.object({ f: coercedBooleanWithDefault(false) });
    expect(s.parse({})).toEqual({ f: false });
    expect(s.parse({ f: "TRUE" })).toEqual({ f: true });
    expect(s.parse({ f: 1 })).toEqual({ f: true });
    expect(s.safeParse({ f: "yes" }).success).toBe(false);
    expect(wire(s).required ?? []).not.toContain("f");
  });
});

describe("flattenUnionToObjectSchema keeps what the variants declared", () => {
  const union = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("a"),
      same: z.string().optional().describe("one text"),
      differs: z.string().optional().describe("for a"),
      agreed: z.number().default(3).describe("n"),
      partial: z.enum(["x", "y"]).default("x"),
      clash: z.enum(["x", "y"]).default("x"),
      flag: coercedBooleanWithDefault(true).describe("flag"),
    }),
    z.object({
      action: z.literal("b"),
      same: z.string().optional().describe("one text"),
      differs: z.string().optional().describe("for b"),
      agreed: z.number().default(3).describe("n"),
      partial: z.enum(["x", "y"]).optional(),
      clash: z.enum(["x", "y"]).default("y"),
    }),
    z.object({
      action: z.literal("c"),
      differs: z.string().optional().describe("for a"),
    }),
  ]);
  const p = propsOf(flattenUnionToObjectSchema(union));

  it("a description the variants agree on, once", () => {
    expect(p.same.description).toBe("one text");
  });

  it("descriptions that differ, each labelled with the actions it is written for", () => {
    expect(p.differs.description).toBe("'a' / 'c': for a\n'b': for b");
  });

  it("a default every variant declares alike", () => {
    expect(p.agreed).toMatchObject({ default: 3, description: "n" });
    expect(p.flag).toMatchObject({ type: "boolean", default: true, description: "flag" });
  });

  it("no default where a variant has none, or where they differ", () => {
    expect(p.partial.default).toBeUndefined();
    expect(p.clash.default).toBeUndefined();
  });

  it("the wire default is metadata: the flat schema does not fill it in", () => {
    expect(flattenUnionToObjectSchema(union).parse({ action: "a" })).toEqual({ action: "a" });
  });

  it("refuses a coercedBooleanWithDefault whose variants disagree, rather than show one variant's default", () => {
    const bad = z.discriminatedUnion("action", [
      z.object({ action: z.literal("a"), f: coercedBooleanWithDefault(true) }),
      z.object({ action: z.literal("b"), f: coercedBoolean().optional() }),
    ]);
    expect(() => flattenUnionToObjectSchema(bad)).toThrow(/"f" would show a default/);
  });
});

describe("the catalog surface (= the live tools/list)", () => {
  // What is still undescribed, by name: `terminal.until` has no `.describe()` in its source (the
  // tool description explains it), and `mouse_drag`'s coordinates have none either.
  it("every property is described but the five known ones", () => {
    const undescribed = STUB_TOOL_CATALOG.flatMap((t) =>
      Object.entries((t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>)
        .filter(([, prop]) => typeof prop.description !== "string")
        .map(([k]) => `${t.name}.${k}`),
    ).sort();
    expect(undescribed).toEqual(["mouse_drag.endX", "mouse_drag.endY", "mouse_drag.startX", "mouse_drag.startY", "terminal.until"]);
  });

  it("the defaults win2 found lost are on the wire, but the two whose variants disagree", () => {
    const prop = (tool: string, key: string) =>
      (STUB_TOOL_CATALOG.find((t) => t.name === tool)!.inputSchema.properties as Record<string, Record<string, unknown>>)[key];
    expect(prop("browser_eval", "withPerception").default).toBe(false);
    expect(prop("browser_eval", "port").default).toBe(9222);
    expect(prop("screenshot", "dotByDot").default).toBe(false);
    expect(prop("desktop_state", "includeCursor").default).toBe(false);
    expect(prop("keyboard", "method").default).toBeUndefined();
    expect(prop("scroll", "direction").default).toBeUndefined();
  });
});
