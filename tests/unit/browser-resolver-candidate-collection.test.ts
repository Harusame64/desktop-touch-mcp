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
import {
  buildCandidateCollectionJs,
  buildActionCandidateFactsJs,
  buildFillActJs,
} from "../../src/tools/browser-resolver.js";

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

describe("ADR-023 Phase 1 PR2: buildActionCandidateFactsJs — gather tail (snapshot)", () => {
  it("emits the full fact-gather IIFE for a representative by:text query (snapshot)", () => {
    const js = buildActionCandidateFactsJs({
      by: "text", pattern: "Save", scope: "#app", caseSensitive: false,
    });
    expect(js).toMatchSnapshot();
  });

  it("reuses the shared matching body verbatim (same per-axis scoring + scan budget)", () => {
    const js = buildActionCandidateFactsJs({ by: "role", pattern: "button", caseSensitive: false });
    // Shared body fragments (must match the collection builder's matching core).
    for (const frag of [
      "record(el, 1.0, 'text')",
      "record(el, 0.85, 'roleImplicit')",
      "record(selectorMatches[i], 1.0, 'selector')",
      "const SCAN_BUDGET_MS = 3000;",
      "filtered.sort((a, b) =>",
    ]) {
      expect(js).toContain(frag);
    }
  });

  it("gather tail: top-N cap, climb depth, elementFromPoint hit-test, viewport metrics", () => {
    const js = buildActionCandidateFactsJs({ by: "ariaLabel", pattern: "Search", caseSensitive: false });
    expect(js).toContain("const N = 8;");                       // AMBIGUITY_CANDIDATE_CAP
    expect(js).toContain("const D = 3;");                       // CLIMB_MAX_DEPTH
    expect(js).toContain("const top = pool.slice(0, N);");      // top-N of the (role-filtered) pool
    expect(js).toContain("document.elementFromPoint(cx, cy)"); // receivesEvents hit-test
    expect(js).toContain("for (let d = 0; d <= D && node; d++)"); // self + D ancestors
    // window-level coord metrics (no second querySelector for click)
    expect(js).toContain("const chromeH = window.outerHeight - window.innerHeight;");
    expect(js).toContain("viewport: { screenX: sx, screenY: sy, dpr: dpr");
    // candidate fact shape
    expect(js).toContain("chain: chainOf(el)");
    expect(js).toContain("nearestLabels: labelsOf(el)");
    expect(js).toContain("containerHint: hintOf(el)");
  });

  it("role filter: absent → roleFilter null + pool is filtered; present → lowercased role", () => {
    const noRole = buildActionCandidateFactsJs({ by: "text", pattern: "Save", caseSensitive: false });
    expect(noRole).toContain("const roleFilter = null;");
    const withRole = buildActionCandidateFactsJs({ by: "text", pattern: "Save", role: "Button", caseSensitive: false });
    expect(withRole).toContain('const roleFilter = "button";'); // lowercased
    // climb-fix: the role filter matches the leaf OR an ancestor within D, so a
    // button whose label is wrapped in a child element still matches (GSC dogfood).
    expect(withRole).toContain("function roleMatchesChain(el)");
    expect(withRole).toContain("filtered.filter(function(e) { return roleMatchesChain(e.el); })");
  });

  it("shares the collection error returns (ScopeNotFound / Timeout) via the body", () => {
    const js = buildActionCandidateFactsJs({ by: "text", pattern: "x", scope: "#nope", caseSensitive: false });
    expect(js).toContain('document.querySelector("#nope")');
    expect(js).toContain('return { __error: "ScopeNotFound" };');
    expect(js).toContain('__error: "Timeout"');
  });
});

const EXPECT = { name: "Email address", role: null, ariaLabel: "Email address", tag: "input", total: 1 };

describe("ADR-023 Phase 1 PR4: buildFillActJs — by-axis fill act (snapshot)", () => {
  it("emits the full fill-act IIFE for a representative by:ariaLabel target (snapshot)", () => {
    const js = buildFillActJs({ by: "ariaLabel", pattern: "Email address", caseSensitive: false }, 0, 0, "user@example.com", EXPECT);
    expect(js).toMatchSnapshot();
  });

  it("reuses the shared candidate pool (same matching body + role filter + top-N)", () => {
    const js = buildFillActJs({ by: "ariaLabel", pattern: "X", role: "textbox", caseSensitive: false }, 0, 0, "v", EXPECT);
    for (const frag of [
      "filtered.sort((a, b) =>",          // shared matching body
      "const top = pool.slice(0, N);",    // shared pool fragment
      'const roleFilter = "textbox";',    // role filter shared
      "record(el, 0.95, 'ariaLabel')",    // shared per-axis scoring
    ]) {
      expect(js).toContain(frag);
    }
  });

  it("identity gate (Codex P1): verifies pool count + matched signature before writing", () => {
    const js = buildFillActJs(
      { by: "ariaLabel", pattern: "X", caseSensitive: false }, 2, 1, "hi",
      { name: "Email address", role: null, ariaLabel: "Email address", tag: "input", total: 3 },
    );
    expect(js).toContain("if (pool.length !== 3) return { ok: false, error: 'identity_changed', detail: 'candidate_count' };");
    expect(js).toContain('if (mName !== "Email address" || mRole !== null || mAria !== "Email address" || mTag !== "input")');
    expect(js).toContain("error: 'identity_changed', detail: 'signature'");
    // the gate runs BEFORE any focus/setter write
    expect(js.indexOf("identity_changed")).toBeLessThan(js.indexOf("descriptor.set.call(el, val)"));
  });

  it("act tail: re-select top[index], climb climbDepth, fillable gate, native setter + events", () => {
    const js = buildFillActJs({ by: "ariaLabel", pattern: "X", caseSensitive: false }, 2, 1, "hi", EXPECT);
    expect(js).toContain("if (top.length <= 2) return { ok: false, error: 'index_out_of_range' };");
    expect(js).toContain("const matched = top[2].el;");
    expect(js).toContain("let el = matched;");
    expect(js).toContain("for (let d = 0; d < 1 && el; d++) el = el.parentElement;");
    expect(js).toContain("const isTextInput = tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/.test(ty);");
    expect(js).toContain("el.isContentEditable === true");
    expect(js).toContain("error: 'not_fillable'");
    expect(js).toContain("descriptor.set.call(el, val)");        // React-compatible native setter
    expect(js).toContain("new InputEvent('input'");
    expect(js).toContain("new Event('change'");
    expect(js).toContain("fullMatches: fullActual === val");
  });

  it("JSON-encodes the value (escapes embedded quotes) and interpolates index/climbDepth as numbers", () => {
    const js = buildFillActJs({ by: "ariaLabel", pattern: "X", caseSensitive: false }, 0, 0, 'a"b', EXPECT);
    expect(js).toContain('const val = "a\\"b";');
  });
});
