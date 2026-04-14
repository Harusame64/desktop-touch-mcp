import { describe, it, expect } from "vitest";
import { z } from "zod";
import { coercedBoolean, coercedJsonObject } from "../../src/tools/_coerce.js";

describe("coercedBoolean", () => {
  const schema = coercedBoolean();

  it("accepts true / false directly", () => {
    expect(schema.parse(true)).toBe(true);
    expect(schema.parse(false)).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["TRUE", true],
    ["False", false],
    ["  true  ", true],
  ])('coerces the string "%s" → %s', (input, expected) => {
    expect(schema.parse(input)).toBe(expected);
  });

  it("coerces 0 / 1", () => {
    expect(schema.parse(1)).toBe(true);
    expect(schema.parse(0)).toBe(false);
  });

  it.each([
    ["yes"],
    ["no"],
    ["1.0"],
    [""],
    [null],
    [{}],
    [[]],
  ])("rejects ambiguous input %j", (input) => {
    expect(() => schema.parse(input)).toThrow();
  });

  it("works with .default() (string default)", () => {
    const withDefault = coercedBoolean().default(true);
    expect(withDefault.parse(undefined)).toBe(true);
    expect(withDefault.parse("false")).toBe(false);
  });

  it("works with .optional()", () => {
    const opt = coercedBoolean().optional();
    expect(opt.parse(undefined)).toBeUndefined();
    expect(opt.parse("true")).toBe(true);
  });
});

describe("coercedJsonObject", () => {
  const target = coercedJsonObject({
    windowTitle: z.string().optional(),
    port: z.coerce.number().optional(),
  });

  it("accepts a plain object", () => {
    expect(target.parse({ windowTitle: "Notepad" })).toEqual({ windowTitle: "Notepad" });
  });

  it("accepts an empty object", () => {
    expect(target.parse({})).toEqual({});
  });

  it('coerces the JSON string \'{"windowTitle":"Notepad"}\'', () => {
    expect(target.parse('{"windowTitle":"Notepad"}')).toEqual({ windowTitle: "Notepad" });
  });

  it('coerces "{}" → {}', () => {
    expect(target.parse("{}")).toEqual({});
  });

  it('coerces "" → {}', () => {
    expect(target.parse("")).toEqual({});
  });

  it("rejects malformed JSON string with a structured error (not a silent no-op)", () => {
    // The string falls through to z.object which then rejects "not-json" as non-object.
    expect(() => target.parse("not-json")).toThrow();
  });

  it("rejects an array (objects only)", () => {
    expect(() => target.parse([1, 2, 3])).toThrow();
    expect(() => target.parse("[1,2,3]")).toThrow();
  });

  it("coerces nested boolean/number per inner schema", () => {
    const r = target.parse('{"windowTitle":"Notepad","port":"9222"}');
    expect(r).toEqual({ windowTitle: "Notepad", port: 9222 });
  });
});
