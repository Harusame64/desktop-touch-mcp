/**
 * #657 — the spelling of a widened field, pinned ON THE DOCUMENT THAT IS SENT.
 *
 * `flattenUnionToObjectSchema` widens a field that collides across variants, and two comments in
 * `src/` describe how that widening is spelled. A comment is a claim, not a check. What counts as
 * "the document that is sent" lives in `helpers/wire-schema.ts`, together with the three ways this
 * PR got it wrong before it got it right.
 *
 * The two named pins below are the whole set that ships a widening today: `keyboard.method` is the
 * only `z.union` widening and `terminal.until` the only nested union, measured across all eight
 * `flattenUnionToObjectSchema` products. The SWEEP after them is what keeps that sentence true — a
 * pin on two tools cannot say anything about the other six, and the claim in `_envelope.ts` is
 * about all of them. Independently swept over the live wire on the Windows machine the same day
 * (32 tools, zero type arrays, one `anyOf`, one `oneOf`, no top-level either), and the sweep's
 * ability to SEE a new one was confirmed there by intervention rather than by reading: a
 * bare-scalar collision added to `scroll.ts` turned the sweep red, named
 * `scroll.mutationProbeCount`, left the other cells green, and really did ship
 * `{"type":["number","string"]}` to a running server.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { browserEvalRegistrationSchema } from "../../src/tools/browser.js";
import { clipboardRegistrationSchema } from "../../src/tools/clipboard.js";
import { excelRegistrationSchema } from "../../src/tools/excel.js";
import { keyLockerRegistrationSchema } from "../../src/tools/key-locker-tool.js";
import { keyboardRegistrationSchema } from "../../src/tools/keyboard.js";
import { scrollRegistrationSchema } from "../../src/tools/scroll.js";
import { terminalRegistrationSchema } from "../../src/tools/terminal.js";
import { windowDockRegistrationSchema } from "../../src/tools/window-dock.js";
import { spellingOf, typeArrayPaths, wire } from "./helpers/wire-schema.js";

/** The eight `flattenUnionToObjectSchema` call sites outside `_envelope.ts` itself. */
const FLATTENED = [
  ["browser_eval", browserEvalRegistrationSchema],
  ["clipboard", clipboardRegistrationSchema],
  ["excel", excelRegistrationSchema],
  ["key_locker", keyLockerRegistrationSchema],
  ["keyboard", keyboardRegistrationSchema],
  ["scroll", scrollRegistrationSchema],
  ["terminal", terminalRegistrationSchema],
  ["window_dock", windowDockRegistrationSchema],
] as const;

describe("#657 — the wire spelling of a widened field", () => {
  // FLATTENED IS HAND-MAINTAINED, and the cells below are titled "every flattened tool". Nothing
  // detected a ninth: a new tool flattening a union could ship a type array with every cell here
  // green, while `_envelope.ts`'s "across all eight products" quietly became a claim about
  // eight-of-nine (gate 2 round 5). So the list is compared against the source.
  it("the list above is every `flattenUnionToObjectSchema` call site in src/tools", () => {
    const dir = new URL("../../src/tools/", import.meta.url);
    const sites: string[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".ts") || file === "_envelope.ts") continue;
      const src = readFileSync(new URL(file, dir), "utf8");
      const n = src.split("flattenUnionToObjectSchema(").length - 1;
      for (let i = 0; i < n; i++) sites.push(file);
    }
    expect(sites.length).toBe(FLATTENED.length);
  });

  describe("keyboard.method — the ONE widening that ships", () => {
    // It is a widening because the variants disagree in KIND: `z.enum([...]).default("auto")` in
    // one and `z.literal("foreground").optional()` in another, and `mergeFlatField`'s all-enum
    // merge does not apply to a literal, so it falls through to `z.union`.
    //
    // AND IT IS SPELLED `anyOf`, under zod 4.5.4 — which is why `_envelope.ts` may not say that
    // 4.5.4 "emits a type array" as if that were a property of the version. It is a property of the
    // BRANCH SHAPES: bare scalars collapse into one `type` array, branches that carry their own
    // keywords (`enum`, `const`) cannot be collapsed and stay `anyOf`.
    // `spellingOf` FIRST, in the describe body, so ALL the cells below get its sentence when the
    // property has left the wire. Two of the three used to reach `Object.keys(undefined)` and
    // `undefined.anyOf` first and reported a TypeError — the very failure the helper's ordering
    // was fixed to eliminate, one cell over (gate 2 round 5, measured by removing `method` from
    // all three keyboard variants).
    const method = wire(keyboardRegistrationSchema).properties?.method;
    spellingOf(method);
    it("is spelled `anyOf` — not a type array, which is the spelling #657 cannot vouch for", () => {
      expect(spellingOf(method)).toBe("anyOf");
    });
    // `anyOf` AND NOTHING ELSE — including no `description` and no `default`, which is a DEFECT
    // this cell records rather than blesses: `mergeFlatField` strips the wrappers a `.describe()`
    // hangs on, so 15 of keyboard's 19 properties ship undocumented and `method` loses
    // `default: "auto"` (measured on the wire, both machines; filed as #664).
    it("and `anyOf` is the only key on it — see #664, which this pins rather than approves", () => {
      expect(
        Object.keys(method).sort(),
        "#664: if this went red because `description` or `default` came back, THE FIX LANDED — update this pin rather than reverting the fix.",
      ).toEqual(["anyOf"]);
    });
    it("carries the two branches that disagree in kind — an enum and a const, in any order", () => {
      expect(method.anyOf).toHaveLength(2);
      // ORDER-INSENSITIVE on purpose: the branch order follows the variant order in
      // `keyboardSchema`, so moving the `sequence` variant up — a refactor a client cannot observe
      // — would otherwise turn this red with a message about enum values, pointing at zod rather
      // than at the reorder (gate 2 round 2).
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
    const until = wire(terminalRegistrationSchema).properties?.until;
    spellingOf(until);
    it("is spelled `oneOf`, and that is the only key on it", () => {
      expect(spellingOf(until)).toBe("oneOf");
      expect(Object.keys(until).sort()).toEqual(["oneOf"]);
    });
    it("carries one branch per `until` mode", () => {
      expect(
        until.oneOf
          .map((b: { properties?: { mode?: { const?: string } } }) => b.properties?.mode?.const)
          .sort(),
      ).toEqual(["exit", "pattern", "quiet"]);
    });
  });

  describe("every flattened tool, and not only the two with a widening", () => {
    // FIRST, that there is a document at all. `?? {}` over an empty or missing property set would
    // make the sweeps below iterate zero times and PASS — and empty `properties` is exactly the
    // regression `flattenUnionToObjectSchema` exists to prevent: `_envelope.ts` records that the
    // SDK's `normalizeObjectSchema` returns `undefined` for a top-level union, whereupon
    // `tools/list` falls back to empty properties. A vacuous sweep would report that as health
    // (gate 2 round 4).
    it.each(FLATTENED.map(([name, schema]) => ({ name, schema })))(
      "$name ships a non-empty property set including `action`",
      ({ schema }) => {
        const props = wire(schema).properties;
        expect(props).toBeDefined();
        expect(Object.keys(props).length).toBeGreaterThan(0);
        expect(props.action).toBeDefined();
      },
    );

    it("no flattened tool ships a property-level TYPE ARRAY, at any depth", () => {
      const offenders: string[] = [];
      for (const [name, schema] of FLATTENED) {
        // RECURSIVE: a top-level-only walk cannot see `until.oneOf[…].properties.quietMs`, and the
        // claim this cell stands behind is about the whole document (gate 2 round 4).
        offenders.push(...typeArrayPaths(wire(schema)).map((p) => `${name}: ${p}`));
      }
      expect(offenders).toEqual([]);
    });

    it("and no flattened tool ships a TOP-LEVEL oneOf/anyOf — the shape the API rejects", () => {
      const offenders: string[] = [];
      for (const [name, schema] of FLATTENED) {
        const js = wire(schema);
        if (js.oneOf !== undefined) offenders.push(`${name}: oneOf`);
        if (js.anyOf !== undefined) offenders.push(`${name}: anyOf`);
      }
      expect(offenders).toEqual([]);
    });
  });
});
