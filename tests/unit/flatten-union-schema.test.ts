/**
 * ADR-018 Phase 2a — unit tests for `flattenUnionToObjectSchema` and
 * `parseActionArgsOrFail` (`src/tools/_envelope.ts` §2.5.2).
 *
 * Contract pinned:
 *   1. `flattenUnionToObjectSchema(unionWithInclude)` → a flat top-level
 *      `z.object` (no top-level oneOf/anyOf — the Anthropic API rejects those),
 *      `action` becomes a required `z.enum`, every other field optional,
 *      the `include` envelope field is carried through, collisions widen.
 *   2. The flat wire schema is strictly LOOSER than the include-injected union
 *      — it never rejects an input the union accepts.
 *   3. `parseActionArgsOrFail` re-parses against the include-injected union
 *      (the strict gate the flat wire schema deliberately drops): valid →
 *      `{ ok: true, value }`, invalid → `{ ok: false, result }` with a typed
 *      `InvalidArgs` error; it never throws; `include` survives.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  flattenUnionToObjectSchema,
  parseActionArgsOrFail,
  withEnvelopeIncludeForUnion,
} from "../../src/tools/_envelope.js";

// Synthetic discriminated union exercising every collision class:
//  - `windowTitle`: same structural shape across variants (string, only the
//    description differs) → collapses to one optional field
//  - `direction`: different `z.enum`s per variant → all-enum merge to the
//    value union (one `z.enum`)
//  - `count`: `number` in one variant, `string` in another → `z.union`
//    fallback → property-level `anyOf`
//  - `onlyA` / `onlyB`: single-variant fields → optional passthrough
const synthBare = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("a"),
    windowTitle: z.string().describe("win title"),
    direction: z.enum(["up", "down"]),
    count: z.number(),
    onlyA: z.boolean(),
  }),
  z.object({
    action: z.literal("b"),
    windowTitle: z.string().describe("win title (b variant)"),
    direction: z.enum(["down", "left"]),
    count: z.string(),
    onlyB: z.string().optional(),
  }),
]);
const synthUnionWithInclude = withEnvelopeIncludeForUnion(synthBare);

function failureOf(result: { content: Array<{ text?: string }> }): {
  ok: false;
  code: string;
  error: string;
  context?: { issues?: unknown[] };
} {
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("ADR-018 Phase 2a — flattenUnionToObjectSchema", () => {
  const flat = flattenUnionToObjectSchema(synthUnionWithInclude);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const js = z.toJSONSchema(flat) as any;

  it("produces a flat top-level object — no oneOf/anyOf/allOf at the root", () => {
    expect(js.type).toBe("object");
    expect(js.oneOf).toBeUndefined();
    expect(js.anyOf).toBeUndefined();
    expect(js.allOf).toBeUndefined();
  });

  it("the discriminator becomes a required z.enum of all variant literals", () => {
    expect([...js.properties.action.enum].sort()).toEqual(["a", "b"]);
    expect(js.required).toEqual(["action"]);
  });

  it("carries the `include` envelope field through, optional (load-bearing)", () => {
    expect(js.properties.include).toBeDefined();
    expect(js.required).not.toContain("include");
  });

  it("same-structure collision (windowTitle) collapses to ONE optional field", () => {
    expect(js.properties.windowTitle.type).toBe("string");
    expect(js.properties.windowTitle.anyOf).toBeUndefined();
    expect(js.required).not.toContain("windowTitle");
  });

  it("all-enum collision (direction) merges to one z.enum of the value union", () => {
    expect([...js.properties.direction.enum].sort()).toEqual(["down", "left", "up"]);
    expect(js.properties.direction.anyOf).toBeUndefined();
  });

  it("mixed-type collision (count) widens to a property-level anyOf", () => {
    expect(js.properties.count.anyOf).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = js.properties.count.anyOf.map((b: any) => b.type).sort();
    expect(types).toEqual(["number", "string"]);
  });

  it("single-variant fields pass through as optional", () => {
    expect(js.properties.onlyA.type).toBe("boolean");
    expect(js.properties.onlyB.type).toBe("string");
    expect(js.required).not.toContain("onlyA");
    expect(js.required).not.toContain("onlyB");
  });

  it("the flat wire schema accepts every VALID input the include-injected union accepts (never rejects a valid call)", () => {
    // The flat wire schema's looseness contract is: a *valid* call — one that
    // the real union accepts — must also pass the wire schema. (It is NOT a
    // claim that the wire schema swallows *invalid* input: a wrong-typed
    // off-action field IS rejected, with a typed error — that is the contract
    // working, not a regression. `.catch(undefined)` was considered for that
    // case and rejected; see the `mergeFlatField` doc comment.)
    const validInputs: Record<string, unknown>[] = [
      { action: "a", windowTitle: "x", direction: "up", count: 1, onlyA: true },
      { action: "b", windowTitle: "y", direction: "left", count: "n", onlyB: "z" },
      { action: "a", windowTitle: "x", direction: "down", count: 0, onlyA: false, include: ["envelope"] },
    ];
    for (const input of validInputs) {
      expect(synthUnionWithInclude.safeParse(input).success, `union: ${JSON.stringify(input)}`).toBe(true);
      expect(flat.safeParse(input).success, `flat: ${JSON.stringify(input)}`).toBe(true);
    }
  });
});

describe("ADR-018 Phase 2a — parseActionArgsOrFail", () => {
  it("valid input → { ok: true, value } with the discriminator narrowed", () => {
    const r = parseActionArgsOrFail<z.infer<typeof synthBare>>(
      synthUnionWithInclude,
      { action: "a", windowTitle: "x", direction: "up", count: 1, onlyA: true },
      "synth",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.action).toBe("a");
  });

  it("per-action-invalid input (the flat wire schema would accept it) → { ok: false } with code InvalidArgs", () => {
    // `onlyA` is required by the real `a` variant but the flat wire schema has
    // it optional — this is exactly the gap `parseActionArgsOrFail` closes.
    const badForUnion = { action: "a", windowTitle: "x", direction: "up", count: 1 };
    const flat = flattenUnionToObjectSchema(synthUnionWithInclude);
    expect(flat.safeParse(badForUnion).success, "flat wire schema is loose").toBe(true);

    const r = parseActionArgsOrFail(synthUnionWithInclude, badForUnion, "synth");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const failure = failureOf(r.result);
      expect(failure.code).toBe("InvalidArgs");
      expect(failure.error).toContain("synth");
      expect(Array.isArray(failure.context?.issues)).toBe(true);
    }
  });

  it("preserves the `include` field on the parsed value (no strip)", () => {
    const r = parseActionArgsOrFail<z.infer<typeof synthUnionWithInclude>>(
      synthUnionWithInclude,
      { action: "a", windowTitle: "x", direction: "up", count: 1, onlyA: true, include: ["envelope"] },
      "synth",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { include?: unknown }).include).toEqual(["envelope"]);
  });

  it("never throws — returns a typed-error ToolResult on a bad discriminator", () => {
    expect(() => parseActionArgsOrFail(synthUnionWithInclude, { action: "nonexistent" }, "synth")).not.toThrow();
    const r = parseActionArgsOrFail(synthUnionWithInclude, { action: "nonexistent" }, "synth");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(failureOf(r.result).code).toBe("InvalidArgs");
  });
});
