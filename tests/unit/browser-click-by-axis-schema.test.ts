/**
 * browser-click-by-axis-schema.test.ts
 * — ADR-023 Phase 1 PR3: browser_click schema = exactly-one-of(selector | by+pattern).
 *
 * Pins the `.refine()` validation contract AND the wire-transparency property the
 * MCP SDK relies on: in zod 4 a refined object keeps `_def.type === 'object'` +
 * its shape, so the SDK's normalizeObjectSchema returns it (→ tools/list emits
 * real `properties`) AND runs the refine at parse time. server.tool's 3-arg form
 * would throw on this ZodObject, which is why registration uses server.registerTool.
 *
 * @see src/tools/browser.ts  browserClickRegistrationSchema
 */

import { describe, it, expect } from "vitest";
import { browserClickRegistrationSchema } from "../../src/tools/browser.js";

describe("browser_click registration schema — exactly-one-of(selector | by+pattern)", () => {
  it("accepts selector alone", () => {
    expect(browserClickRegistrationSchema.safeParse({ selector: "#submit" }).success).toBe(true);
  });

  it("accepts by + pattern alone", () => {
    expect(browserClickRegistrationSchema.safeParse({ by: "text", pattern: "Save" }).success).toBe(true);
  });

  it("accepts by + pattern + role + scope (disambiguation args)", () => {
    expect(
      browserClickRegistrationSchema.safeParse({ by: "text", pattern: "Save", role: "button", scope: "#main" }).success,
    ).toBe(true);
  });

  it("rejects BOTH selector and by+pattern", () => {
    expect(browserClickRegistrationSchema.safeParse({ selector: "#x", by: "text", pattern: "Save" }).success).toBe(false);
  });

  it("rejects NEITHER (empty)", () => {
    expect(browserClickRegistrationSchema.safeParse({}).success).toBe(false);
  });

  it("rejects by without pattern", () => {
    expect(browserClickRegistrationSchema.safeParse({ by: "text" }).success).toBe(false);
  });

  it("rejects an unknown by-axis value (selector is NOT a public by-axis)", () => {
    expect(browserClickRegistrationSchema.safeParse({ by: "selector", pattern: "#x" }).success).toBe(false);
  });

  it("survives the refine as a ZodObject so the SDK emits tools/list properties", () => {
    // The MCP SDK's normalizeObjectSchema returns the schema only when
    // _zod.def.type === 'object' (or def.shape present). A refined object keeps both.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (browserClickRegistrationSchema as any)._zod?.def;
    expect(def?.type).toBe("object");
    const shape = def?.shape ?? {};
    for (const key of ["selector", "by", "pattern", "role", "scope", "include"]) {
      expect(Object.keys(shape)).toContain(key);
    }
  });
});
