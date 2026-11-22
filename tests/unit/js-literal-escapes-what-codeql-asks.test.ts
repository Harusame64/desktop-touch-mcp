/**
 * jsLiteral writes a value as a JS literal for a script the page runs, with <, >, / and U+2028 / U+2029 escaped
 * (CodeQL js/bad-code-sanitization, alerts 217-226). It must read back as the same value.
 */
import { describe, it, expect } from "vitest";
import { jsLiteral } from "../../src/utils/js-literal.js";
import { buildTagResolvedJs, buildFillActJs } from "../../src/tools/browser-resolver.js";

describe("jsLiteral", () => {
  const samples: unknown[] = ["a</script><b>c", "emoji \ud83d\ude00", "lone \ud800", "back\\/slash", "already \\u003c", "x\u2028y\u2029z", "path/to", "plain", 'q"uote\\', null, 3, true, ["</", { k: "<v>" }]];
  it("leaves none of < > / U+2028 U+2029 in the literal", () => {
    for (const v of samples) expect(jsLiteral(v)).not.toMatch(/[<>/\u2028\u2029]/);
  });
  it("reads back as the same value", () => {
    for (const v of samples) expect(new Function(`return ${jsLiteral(v)};`)()).toEqual(v);
  });
  it("writes undefined as undefined", () => {
    expect(jsLiteral(undefined)).toBe("undefined");
  });
  it("is what the act gates write: a page name with < and U+2028 goes in escaped (CodeQL 217-226)", () => {
    const expect_ = { name: "a</b>\u2028c", role: "button", ariaLabel: "x/y", tag: "button", id: null, formName: null, total: 1 };
    const args = { by: "text" as const, pattern: "a", maxResults: 5, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false };
    for (const js of [buildTagResolvedJs(args as never, 0, 0, expect_, "n0nce"), buildFillActJs(args as never, 0, 0, "v</>", expect_ as never)]) {
      expect(js).toContain("a\\u003c\\u002fb\\u003e\\u2028c");
      expect(js).not.toContain("a</b>");
    }
  });
});
