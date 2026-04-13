/**
 * browser-search.test.ts — E2E tests for browser_search (5 axes + scope + pagination + errors).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { parsePayload, sleep } from "./helpers/wait.js";
import { browserSearchHandler } from "../../src/tools/browser.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9225;                               // separate from other suites (9223/9224)
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;

let chrome: ChromeInstance;

beforeAll(async () => {
  chrome = await launchChrome(TEST_PORT, true /* headless */, FIXTURE_URL);
  // Wait until:
  //   1. document.readyState === 'complete'
  //   2. fixture elements are laid out (width > 0) — headless Chrome reports
  //      zero-size rects before first layout pass even after 'complete'.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluateInTab(
        `document.readyState === 'complete' && ` +
        `(document.querySelectorAll('p.search-text').length >= 3) && ` +
        `(document.querySelector('p.search-text').getBoundingClientRect().width > 0)`,
        null, TEST_PORT);
      if (ready === true) return;
    } catch { /* ignore */ }
    await sleep(250);
  }
  throw new Error("Test page did not fully lay out within 15s");
}, 20_000);

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

async function search(args: Partial<Parameters<typeof browserSearchHandler>[0]>) {
  return parsePayload(await browserSearchHandler({
    by: "text", pattern: "",
    maxResults: 50, offset: 0,
    visibleOnly: true, inViewportOnly: false, caseSensitive: false,
    port: TEST_PORT,
    ...args,
  } as Parameters<typeof browserSearchHandler>[0]));
}

describe("sanity", () => {
  it("page is loaded with the expected fixture content", async () => {
    const title = await evaluateInTab("document.title", null, TEST_PORT);
    expect(title).toBe("desktop-touch CDP Test Page");
    const bodyText = await evaluateInTab("document.body.innerText", null, TEST_PORT);
    expect(typeof bodyText).toBe("string");
    expect(bodyText).toContain("Unique search needle alpha");
    const buttonCount = await evaluateInTab("document.querySelectorAll('button').length", null, TEST_PORT);
    expect(buttonCount).toBeGreaterThanOrEqual(3);
  });

});

describe("browser_search — by:'text'", () => {
  it("finds a unique literal substring", async () => {
    const r = await search({ by: "text", pattern: "Unique search needle alpha" });
    expect(r.ok !== false, JSON.stringify(r)).toBe(true);
    expect(r.total).toBeGreaterThan(0);
    // Should be confidence 1.0 for exact match
    expect(r.results[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.results[0].text).toContain("Unique search needle alpha");
  });

  it("caseSensitive:false matches uppercase needle", async () => {
    const r = await search({ by: "text", pattern: "NEEDLE", caseSensitive: false });
    expect(r.total).toBeGreaterThanOrEqual(2);
  });

  it("caseSensitive:true only matches exact case", async () => {
    const r = await search({ by: "text", pattern: "NEEDLE", caseSensitive: true });
    expect(r.total).toBe(1);
    expect(r.results[0].text).toContain("NEEDLE");
  });

  it("fails with BrowserSearchNoResults for non-existent text", async () => {
    const r = await search({ by: "text", pattern: "this_string_does_not_exist_zzz_9999" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BrowserSearchNoResults");
    expect(Array.isArray(r.suggest)).toBe(true);
  });
});

describe("browser_search — by:'regex'", () => {
  it("matches a regex pattern", async () => {
    const r = await search({ by: "regex", pattern: "^Unique.*alpha$" });
    expect(r.total).toBeGreaterThan(0);
    expect(r.results[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.results[0].matchedBy).toBe("regex");
  });

  it("returns BrowserSearchNoResults (via InvalidRegex) for bad regex", async () => {
    const r = await search({ by: "regex", pattern: "[unclosed" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("BrowserSearchNoResults");
  });
});

describe("browser_search — by:'role'", () => {
  it("finds implicit button role", async () => {
    const r = await search({ by: "role", pattern: "button" });
    expect(r.total).toBeGreaterThanOrEqual(2); // submit / cancel at least
    // roleImplicit should outscore explicit role
    expect(r.results[0].matchedBy).toMatch(/role/);
    expect(r.results[0].type).toBe("button");
  });

  it("finds explicit role=navigation", async () => {
    const r = await search({ by: "role", pattern: "navigation" });
    expect(r.total).toBeGreaterThan(0);
    expect(r.results[0].matchedBy).toBe("role");
  });

  it("finds implicit link role", async () => {
    const r = await search({ by: "role", pattern: "link" });
    expect(r.total).toBeGreaterThanOrEqual(3); // 3 nav links + existing #link-next
  });
});

describe("browser_search — by:'ariaLabel'", () => {
  it("finds exact aria-label", async () => {
    const r = await search({ by: "ariaLabel", pattern: "Search query" });
    expect(r.total).toBeGreaterThan(0);
    expect(r.results[0].ariaLabel).toBe("Search query");
    expect(r.results[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("finds via aria-label substring", async () => {
    const r = await search({ by: "ariaLabel", pattern: "address" });
    expect(r.total).toBeGreaterThan(0);
  });
});

describe("browser_search — by:'selector'", () => {
  it("finds elements by CSS selector with confidence 1.0", async () => {
    const r = await search({ by: "selector", pattern: "button[id^='search-btn-']" });
    expect(r.total).toBeGreaterThanOrEqual(2);
    expect(r.results[0].confidence).toBe(1.0);
    expect(r.results[0].matchedBy).toBe("selector");
  });

  it("fails with ScopeNotFound when scope selector matches nothing", async () => {
    const r = await search({
      by: "text", pattern: "anything",
      scope: "#this-scope-does-not-exist-xyz",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("ScopeNotFound");
  });
});

describe("browser_search — scope / pagination / visibility", () => {
  it("scope limits results to within the selector", async () => {
    const inScope = await search({ by: "text", pattern: "inside-scope", scope: "#search-scope-parent" });
    const outScope = await search({ by: "text", pattern: "inside-scope" });
    expect(inScope.total).toBeLessThanOrEqual(outScope.total);
    expect(inScope.total).toBeGreaterThan(0);
  });

  it("visibleOnly:false includes hidden elements with confidence penalty", async () => {
    const visibleOnly = await search({
      by: "text", pattern: "Hidden Unique Marker", visibleOnly: true,
    });
    expect(visibleOnly.ok).toBe(false); // no visible match

    const includeHidden = await search({
      by: "text", pattern: "Hidden Unique Marker", visibleOnly: false,
    });
    expect(includeHidden.ok !== false, JSON.stringify(includeHidden)).toBe(true);
    expect(includeHidden.total).toBeGreaterThan(0);
    // confidence penalty (0.3 deducted for hidden)
    expect(includeHidden.results[0].confidence).toBeLessThan(1.0);
  });

  it("offset + maxResults paginates without duplication", async () => {
    const page1 = await search({ by: "role", pattern: "link", maxResults: 2, offset: 0 });
    const page2 = await search({ by: "role", pattern: "link", maxResults: 2, offset: 2 });
    expect(page1.returned).toBeLessThanOrEqual(2);
    expect(page2.returned).toBeGreaterThanOrEqual(0);
    // selectors must not overlap between pages
    const set1 = new Set<string>(page1.results.map((r: { selector: string }) => r.selector));
    for (const r of page2.results) {
      expect(set1.has(r.selector)).toBe(false);
    }
  });

  it("results are sorted by confidence descending", async () => {
    const r = await search({ by: "role", pattern: "button" });
    for (let i = 1; i < r.results.length; i++) {
      expect(r.results[i - 1].confidence).toBeGreaterThanOrEqual(r.results[i].confidence);
    }
  });

  it("cross-axis re-search does not inherit stale matchScore from previous call (Bug 2 regression)", async () => {
    // Run by:'role' first to mark every <button> with score 0.85 / matchedBy='roleImplicit'.
    // If WeakMap-based state leaked into a DOM expando, the next by:'text' call would
    // see a stale 0.85 sitting on the button and produce wrong confidence/matchedBy.
    const role1 = await search({ by: "role", pattern: "button" });
    expect(role1.ok !== false).toBe(true);
    expect(role1.results.every((r: { matchedBy: string }) => /role/.test(r.matchedBy))).toBe(true);

    // Now search by text for "Submit Form" (a button-text content).
    const text1 = await search({ by: "text", pattern: "Submit Form" });
    expect(text1.ok !== false, JSON.stringify(text1)).toBe(true);
    // matchedBy must reflect THIS call's axis, not the previous role search.
    expect(text1.results[0].matchedBy).toBe("text");
    // confidence should be 1.0 (exact text), not 0.85 (stale role score).
    expect(text1.results[0].confidence).toBe(1.0);

    // And run by:'role' a third time — score must still be the role-axis value,
    // not a stale 1.0 from the text call.
    const role2 = await search({ by: "role", pattern: "button" });
    expect(role2.ok !== false).toBe(true);
    expect(role2.results.every((r: { confidence: number }) => r.confidence <= 0.85)).toBe(true);
  });
});
