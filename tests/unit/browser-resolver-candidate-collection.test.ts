/**
 * tests/unit/browser-resolver-candidate-collection.test.ts
 * — ADR-023 Phase 1 (S1/S7), R-P1-1 (snapshot-first, bit-equal extraction).
 *
 * `buildCandidateCollectionJs` is a VERBATIM extraction of the injected-JS IIFE
 * that `browser_search` used to build inline. browser_search now delegates to it,
 * so its public contract is unchanged ONLY IF the generated JS stays byte-equal.
 * The full-template snapshot pins that: any change to the emitted JS (which would
 * alter browser_search behavior) shows up as an explicit snapshot diff. The
 * targeted assertions document the interpolation contract + the per-axis scoring
 * constants the extraction must preserve.
 *
 * @see src/tools/browser-resolver.ts  buildCandidateCollectionJs
 */

import { describe, it, expect } from "vitest";
import { buildCandidateCollectionJs } from "../../src/tools/browser-resolver.js";

describe("ADR-023 Phase 1 (S1/S7): buildCandidateCollectionJs — bit-equal extraction", () => {
  it("emits the full IIFE for a representative by:text + scope query (snapshot)", () => {
    const js = buildCandidateCollectionJs({
      by: "text", pattern: "Submit", scope: "#checkout",
      maxResults: 20, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    });
    expect(js).toMatchSnapshot();
  });

  it("interpolates scope into document.querySelector, omits to document when absent", () => {
    const withScope = buildCandidateCollectionJs({
      by: "text", pattern: "x", scope: "#s",
      maxResults: 5, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    });
    expect(withScope).toContain('const root = document.querySelector("#s");');

    const noScope = buildCandidateCollectionJs({
      by: "text", pattern: "x",
      maxResults: 5, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    });
    expect(noScope).toContain("const root = document;");
  });

  it("JSON-encodes by / pattern / caseSensitive and derives maxN=maxResults+offset, offN=offset", () => {
    const js = buildCandidateCollectionJs({
      by: "ariaLabel", pattern: 'a"b', scope: undefined,
      maxResults: 10, offset: 5, visibleOnly: false, inViewportOnly: true, caseSensitive: true,
    });
    expect(js).toContain('const by = "ariaLabel";');
    expect(js).toContain('const pat = "a\\"b";'); // JSON.stringify escapes the embedded quote
    expect(js).toContain("const cs  = true;");
    expect(js).toContain("const visibleOnly = false;");
    expect(js).toContain("const viewportOnly = true;");
    expect(js).toContain("const maxN = 15;"); // 10 + 5
    expect(js).toContain("const offN = 5;");
  });

  it("preserves the per-axis scoring constants + scan budget (verbatim extraction guard)", () => {
    const js = buildCandidateCollectionJs({
      by: "role", pattern: "button",
      maxResults: 5, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    });
    for (const frag of [
      "record(el, 1.0, 'text')",
      "record(el, 0.8, 'text')",
      "record(el, 0.9, 'regex')",
      "record(el, 0.75, 'role')",
      "record(el, 0.85, 'roleImplicit')",
      "record(el, 0.95, 'ariaLabel')",
      "record(el, 0.7, 'ariaLabel')",
      "record(selectorMatches[i], 1.0, 'selector')",
      "const SCAN_BUDGET_MS = 3000;",
    ]) {
      expect(js).toContain(frag);
    }
  });
});
