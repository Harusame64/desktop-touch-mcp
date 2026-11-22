/**
 * jsLiteral writes a value as a JS literal for a script the page runs, with <, >, / and U+2028 / U+2029 escaped
 * (CodeQL js/bad-code-sanitization, alerts 217-226). It must read back as the same value.
 */
import { describe, it, expect } from "vitest";
import { jsLiteral } from "../../src/tools/_js-literal.js";

describe("jsLiteral", () => {
  const samples: unknown[] = ["a</script><b>c", "x\u2028y\u2029z", "path/to", "plain", 'q"uote\\', null, 3, true, ["</", { k: "<v>" }]];
  it("leaves none of < > / U+2028 U+2029 in the literal", () => {
    for (const v of samples) expect(jsLiteral(v)).not.toMatch(/[<>/\u2028\u2029]/);
  });
  it("reads back as the same value", () => {
    for (const v of samples) expect(new Function(`return ${jsLiteral(v)};`)()).toEqual(v);
  });
  it("writes undefined as undefined", () => {
    expect(jsLiteral(undefined)).toBe("undefined");
  });
});
