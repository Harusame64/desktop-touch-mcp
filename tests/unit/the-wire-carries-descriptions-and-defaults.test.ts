/**
 * internal #266 — what a tool's schema declares about a field, its description and its default,
 * reaches `tools/list`.
 *
 * win2 measured 2.2.0's wire: 83 descriptions and 51 defaults of the eight flattened tools, and 33
 * defaults on `z.preprocess` fields elsewhere, were lost. Two causes: `flattenUnionToObjectSchema`
 * stripped the wrappers a zod 4 `.describe()` / `.default()` hang on, and the SDK's `io: "input"`
 * conversion does not emit a default outside a `z.preprocess`.
 *
 * Counted on the regenerated catalog against main: 91 descriptions (#266's 83, plus the eight
 * `include` fields the envelope injects, which it did not list) and 80 defaults (48 + 32) more.
 * Four declared defaults still do not show, by name in the sweep below.
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

  it("refuses a coercedBooleanWithDefault whose variants disagree, in either order (gate 2)", () => {
    const withDefault = () => coercedBooleanWithDefault(true);
    const without = () => coercedBoolean().optional();
    for (const [first, second] of [[withDefault, without], [without, withDefault]]) {
      const bad = z.discriminatedUnion("action", [
        z.object({ action: z.literal("a"), f: first() }),
        z.object({ action: z.literal("b"), f: second() }),
      ]);
      expect(() => flattenUnionToObjectSchema(bad)).toThrow(/"f" would show a default/);
    }
  });

  it("refuses it inside a widening too, where its default would sit in one anyOf branch (gate 2)", () => {
    const bad = z.discriminatedUnion("action", [
      z.object({ action: z.literal("a"), f: coercedBooleanWithDefault(true) }),
      z.object({ action: z.literal("b"), f: z.string().optional() }),
    ]);
    expect(() => flattenUnionToObjectSchema(bad)).toThrow(/"f" would show a default/);
  });

  it("reads a description written before the wrappers, too (gate 2)", () => {
    const u = z.discriminatedUnion("action", [
      z.object({ action: z.literal("a"), e: z.enum(["x"]).describe("inner text").default("x") }),
      z.object({ action: z.literal("b"), e: z.enum(["y"]).describe("inner text").optional() }),
    ]);
    expect(propsOf(flattenUnionToObjectSchema(u)).e.description).toBe("inner text");
  });

  it("labels a description only some actions have, so it is not read as every action's (gate 2)", () => {
    const u = z.discriminatedUnion("action", [
      z.object({ action: z.literal("a"), x: z.string().optional().describe("required for a") }),
      z.object({ action: z.literal("b"), x: z.string().optional() }),
    ]);
    expect(propsOf(flattenUnionToObjectSchema(u)).x.description).toBe("'a': required for a");
  });
});

// The eight flattened tools' unions: their registered schemas no longer hold the defaults.
const UNIONS: Record<string, [string, string]> = {
  browser_eval: ["../../src/tools/browser.js", "browserEvalSchema"],
  clipboard: ["../../src/tools/clipboard.js", "clipboardSchema"],
  excel: ["../../src/tools/excel.js", "excelSchema"],
  key_locker: ["../../src/tools/key-locker-tool.js", "keyLockerSchema"],
  keyboard: ["../../src/tools/keyboard.js", "keyboardSchema"],
  scroll: ["../../src/tools/scroll.js", "scrollSchema"],
  terminal: ["../../src/tools/terminal.js", "terminalSchema"],
  window_dock: ["../../src/tools/window-dock.js", "windowDockSchema"],
};

function declaredDefault(schema: unknown): { value: unknown } | undefined {
  let cur: any = schema;
  for (let g = 0; g < 12; g++) {
    const t = cur?._def?.type;
    if (t === "default") return { value: cur._def.defaultValue };
    if (t !== "optional" && t !== "nullable") return undefined;
    cur = cur._def.innerType;
  }
  return undefined;
}

describe("the catalog surface (= the live tools/list)", () => {
  it("every default a registered tool declares is on the wire with its value, but four named ones (gate 2)", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { CATALOG_TOOL_REGISTRARS } = await import("../../src/tools/catalog-registrars.js");
    const { registerKeyLockerTools } = await import("../../src/tools/key-locker-tool.js");
    const server = new McpServer({ name: "sweep", version: "0" });
    for (const register of CATALOG_TOOL_REGISTRARS) register(server);
    registerKeyLockerTools(server);
    const registered = (server as any)._registeredTools as Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
    const declared: Array<[string, string, unknown]> = [];
    for (const [tool, entry] of Object.entries(registered)) {
      if (tool in UNIONS) {
        const [path, name] = UNIONS[tool];
        const union = (await import(path))[name] as { options: Array<{ shape: Record<string, unknown> }> };
        for (const v of union.options)
          for (const [k, f] of Object.entries(v.shape)) {
            const d = declaredDefault(f);
            if (d !== undefined) declared.push([tool, k, d.value]);
          }
      } else {
        for (const [k, f] of Object.entries(entry.inputSchema?.shape ?? {})) {
          const d = declaredDefault(f);
          if (d !== undefined) declared.push([tool, k, d.value]);
        }
      }
    }
    const wireOf = (tool: string, key: string) =>
      (STUB_TOOL_CATALOG.find((t) => t.name === tool)?.inputSchema.properties as Record<string, Record<string, unknown>> | undefined)?.[key];
    const missing = new Set<string>();
    for (const [tool, key, value] of declared) {
      const w = wireOf(tool, key);
      if (w === undefined || !("default" in w)) missing.add(`${tool}.${key}`);
      else expect(w.default, `${tool}.${key}`).toEqual(value);
    }
    // CONTROL: the sweep saw the declarations it is about — from a union and from a plain tool.
    expect(declared.length).toBeGreaterThan(100);
    expect(declared).toContainEqual(["terminal", "lines", 50]);
    expect(declared).toContainEqual(["screenshot", "dotByDot", false]);
    // keyboard.method / scroll.direction: the actions disagree. terminal.until / wait_until.target:
    // objects holding a z.preprocess field, whose default zod drops in input mode.
    expect([...missing].sort()).toEqual(["keyboard.method", "scroll.direction", "terminal.until", "wait_until.target"]);
  });

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

  it("the two nested defaults this restored are on the wire too (Copilot: the sweep is top-level only)", () => {
    const props = (tool: string) =>
      STUB_TOOL_CATALOG.find((t) => t.name === tool)!.inputSchema.properties as Record<string, Record<string, unknown>>;
    const launch = props("browser_open").launch as { properties: Record<string, Record<string, unknown>> };
    expect(launch.properties.killExisting.default).toBe(false);
    const until = props("terminal").until as { oneOf: Array<{ properties: Record<string, Record<string, unknown>> }> };
    const pattern = until.oneOf.find((b) => b.properties.mode?.const === "pattern")!;
    expect(pattern.properties.regex.default).toBe(false);
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
