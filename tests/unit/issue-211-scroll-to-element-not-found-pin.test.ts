/**
 * issue-211-scroll-to-element-not-found-pin.test.ts
 *
 * scroll(action='to_element') ElementNotFound contract pin — Phase 5 E4
 * (epic #211) follow-up to PR #213 Phase 2b execution audit.
 *
 * Audit history (Phase 2b §3 E4):
 *   The audit asked for an "ElementNotFound after scrollIntoView 不可達"
 *   pin. Reading the production code (`src/tools/scroll-to-element.ts`)
 *   clarified the actual contract:
 *     - CDP path (selector): if `document.querySelector(selector)` returns
 *       null → JS returns `{ok:false, error:'Element not found: <sel>'}` →
 *       `failWith` → `_errors.ts:361-362` classifies via "element not found"
 *       substring → top-level `code:'ElementNotFound'` envelope.
 *     - UIA path (name+windowTitle): `scrollElementIntoView` returns
 *       `{ok:false, error:'Element not found'}` when the UIA tree walk
 *       does not match → same classify chain → `code:'ElementNotFound'`.
 *     - "Element exists but ScrollIntoView did not bring it into the
 *       viewport" is NOT an ElementNotFound — CDP path returns success
 *       with viewportTop/Bottom regardless of viewport intersection;
 *       UIA path returns `{ok:true, scrolled:false}` when
 *       ScrollItemPattern is not supported. These are degradation hints,
 *       not failures, so they fall outside the ElementNotFound contract.
 *
 * Production fact (no production code change in this PR — the emit chain
 * was already complete; this PR adds the structural pin only):
 *   - CDP emit site: `scroll-to-element.ts:74` (`failWith(res.error, ...)`
 *     with `res.error === 'Element not found: ...'` from the JS branch
 *     at line 65)
 *   - UIA emit site: `scroll-to-element.ts:88` (`failWith(result.error,
 *     ...)` with `result.error === 'Element not found'` from
 *     `uia-bridge.ts:1368` PowerShell branch or the native nativeUia
 *     short-circuit at line 1332)
 *   - classify branch: `_errors.ts:361-362`
 *
 * Two cases pinned:
 *   1. CDP path: querySelector returns null → top-level
 *      `code:'ElementNotFound'`, includes selector in context.
 *   2. UIA path: scrollElementIntoView returns ok:false with
 *      "Element not found" error → top-level `code:'ElementNotFound'`,
 *      includes windowTitle and name in context.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/engine/cdp-bridge.js", () => ({
  evaluateInTab: vi.fn(),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  scrollElementIntoView: vi.fn(),
}));

vi.mock("../../src/utils/desktop-config.js", () => ({
  getCdpPort: vi.fn(() => 9222),
}));

import { scrollToElementHandler } from "../../src/tools/scroll-to-element.js";
import * as cdp from "../../src/engine/cdp-bridge.js";
import * as uia from "../../src/engine/uia-bridge.js";

const mockEvaluateInTab = vi.mocked(cdp.evaluateInTab);
const mockScrollIntoView = vi.mocked(uia.scrollElementIntoView);

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Phase 5 E4 (epic #211): scroll(action='to_element') ElementNotFound contract pin", () => {
  it("CDP path: querySelector null → top-level code:'ElementNotFound'", async () => {
    mockEvaluateInTab.mockResolvedValueOnce({
      ok: false,
      error: "Element not found: #nonexistent",
    });

    const r = parseResult(await scrollToElementHandler({
      selector: "#nonexistent",
      block: "center",
      port: 9222,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ElementNotFound");
    expect(typeof r.error).toBe("string");
    expect(r.error).toMatch(/Element not found/);
    // Recovery suggest[] should be populated (auto-classify routes to
    // SUGGESTS.ElementNotFound at _errors.ts).
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    // Selector should be preserved in context for caller diagnosis
    // (failWith third arg at scroll-to-element.ts:74 → context.selector).
    expect(r.context.selector).toBe("#nonexistent");
    expect(mockEvaluateInTab).toHaveBeenCalledTimes(1);
  });

  it("UIA path: scrollElementIntoView ok:false 'Element not found' → top-level code:'ElementNotFound'", async () => {
    mockScrollIntoView.mockResolvedValueOnce({
      ok: false,
      scrolled: false,
      error: "Element not found",
    });

    const r = parseResult(await scrollToElementHandler({
      name: "Some Button",
      windowTitle: "Test Window",
      block: "center",
      port: 9222,
    }));

    expect(r.ok).toBe(false);
    expect(r.code).toBe("ElementNotFound");
    expect(r.error).toMatch(/Element not found/);
    expect(Array.isArray(r.suggest)).toBe(true);
    expect(r.suggest.length).toBeGreaterThan(0);
    // windowTitle and name should be preserved in context for caller
    // diagnosis (failWith third arg at scroll-to-element.ts:88 → context).
    expect(r.context.windowTitle).toBe("Test Window");
    expect(r.context.name).toBe("Some Button");
    expect(mockScrollIntoView).toHaveBeenCalledTimes(1);
    expect(mockScrollIntoView).toHaveBeenCalledWith("Test Window", "Some Button");
  });

  it("CDP path success: querySelector hit → ok:true with viewport coords (sanity check, no ElementNotFound)", async () => {
    // Sanity case to ensure the mock harness doesn't false-positive on
    // ElementNotFound — verifies the classify branch only fires on the
    // documented "Element not found" error string.
    mockEvaluateInTab.mockResolvedValueOnce({
      ok: true,
      tag: "button",
      text: "Submit",
      viewportTop: 400,
      viewportBottom: 440,
    });

    const r = parseResult(await scrollToElementHandler({
      selector: "#submit",
      block: "center",
      port: 9222,
    }));

    expect(r.ok).toBe(true);
    expect(r.path).toBe("cdp");
    expect(r.selector).toBe("#submit");
    expect(r.viewportTop).toBe(400);
    expect(r.viewportBottom).toBe(440);
    expect(r.code).toBeUndefined();
  });
});
