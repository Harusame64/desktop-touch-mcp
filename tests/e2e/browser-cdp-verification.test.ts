/**
 * browser-cdp-verification.test.ts — E2E tests for issue #181
 *
 * Pins the CDP delivery verification contract added by #181:
 *   - browser_click installs a MutationObserver before the click and reports
 *     hints.verifyDelivery.status = "delivered" | "unverifiable" based on
 *     observed DOM mutations / URL change / activeElement change.
 *   - browser_fill reads element.value back after fill and surfaces a
 *     BrowserFillNotDelivered failure (with sub-reason) when the framework
 *     transforms the value (matrix doc §5.2 false-positive watch).
 *
 * The browser_click probe install/read primitives are tested directly via
 * evaluateInTab so the verification logic is exercised in headless mode
 * (CI). The full handler (which uses real mouse hardware via nut-js) is
 * gated on HEADED=1 and skipped otherwise.
 *
 * The browser_fill handler does NOT need physical mouse — element.focus()
 * + native-setter dispatch goes via CDP only, so the headless path covers
 * the whole code path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import {
  browserClickElementHandler,
  browserFillInputHandler,
} from "../../src/tools/browser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9229;
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;
const CHROME_AVAILABLE = tryFindChrome() !== null;
const IS_HEADED = Boolean(process.env.HEADED);

let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(TEST_PORT, !IS_HEADED, FIXTURE_URL);
  // Wait for the fixture page itself to land. Headless Chrome may briefly
  // expose an about:blank tab before navigating to the file://.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const probe = await evaluateInTab(
        "JSON.stringify([document.title, document.readyState, location.href])",
        null,
        TEST_PORT,
      );
      const [title, state, href] = JSON.parse(probe as string) as [string, string, string];
      if (
        state === "complete" &&
        title === "desktop-touch CDP Test Page" &&
        href.includes("test-page.html")
      ) {
        return;
      }
    } catch { /* not ready */ }
    await sleep(300);
  }
  throw new Error("Test page did not load within 15s");
}, 20_000);

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

/** Parse the JSON line emitted at content[0].text. */
function parseFirstLine(r: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = (r.content[0] as { text: string }).text;
  // Multi-line responses (with includeContext) put JSON on line 0.
  const firstLine = text.split("\n")[0];
  return JSON.parse(firstLine);
}

// ─────────────────────────────────────────────────────────────────────────────
// MutationObserver probe primitives — exercised via evaluateInTab so the
// verification JS runs end-to-end in the page even without physical mouse.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("issue #181 — click probe primitive", () => {
  it("install + bound-button click + read reports mutationCount > 0 (delivered signal)", async () => {
    // Reset target so prior runs don't accumulate.
    await evaluateInTab(
      "document.getElementById('btn-verify-bound-target').textContent = ''",
      null,
      TEST_PORT,
    );
    // Install the probe.
    const installed = await evaluateInTab(
      `(function() {
        if (window.__dtmClickProbe && window.__dtmClickProbe.observer) {
          try { window.__dtmClickProbe.observer.disconnect(); } catch (_e) {}
        }
        var probe = {
          mutationCount: 0,
          beforeUrl: location.href,
          beforeActive: document.activeElement,
          selectorFound: true,
          inIframe: false,
          observer: null
        };
        var obs = new MutationObserver(function(records) { probe.mutationCount += records.length; });
        obs.observe(document.body, { subtree: true, childList: true, attributes: true });
        probe.observer = obs;
        window.__dtmClickProbe = probe;
        return { ok: true };
      })()`,
      null,
      TEST_PORT,
    );
    expect((installed as { ok: boolean }).ok).toBe(true);
    // Synthetic click on the bound button — appends a span (DOM mutation).
    await evaluateInTab(
      "document.getElementById('btn-verify-bound').click()",
      null,
      TEST_PORT,
    );
    // settle
    await sleep(150);
    // Read out the probe.
    const reading = (await evaluateInTab(
      `(function() {
        var p = window.__dtmClickProbe;
        if (!p) return { ok: false };
        try { p.observer.disconnect(); } catch (_e) {}
        var r = {
          ok: true,
          mutationCount: p.mutationCount,
          urlChanged: p.beforeUrl !== location.href,
          activeElementChanged: p.beforeActive !== document.activeElement
        };
        delete window.__dtmClickProbe;
        return r;
      })()`,
      null,
      TEST_PORT,
    )) as { ok: boolean; mutationCount: number; urlChanged: boolean; activeElementChanged: boolean };
    expect(reading.ok).toBe(true);
    expect(reading.mutationCount).toBeGreaterThan(0);
  });

  it("install + silent-button click + read reports zero signals (unverifiable)", async () => {
    // Install probe.
    await evaluateInTab(
      `(function() {
        if (window.__dtmClickProbe && window.__dtmClickProbe.observer) {
          try { window.__dtmClickProbe.observer.disconnect(); } catch (_e) {}
        }
        var probe = {
          mutationCount: 0,
          beforeUrl: location.href,
          beforeActive: document.activeElement,
          selectorFound: true,
          inIframe: false,
          observer: null
        };
        var obs = new MutationObserver(function(records) { probe.mutationCount += records.length; });
        obs.observe(document.body, { subtree: true, childList: true, attributes: true });
        probe.observer = obs;
        window.__dtmClickProbe = probe;
        return { ok: true };
      })()`,
      null,
      TEST_PORT,
    );
    // Synthetic click on the silent button (no listener wired up).
    await evaluateInTab(
      "document.getElementById('btn-verify-silent').click()",
      null,
      TEST_PORT,
    );
    await sleep(150);
    const reading = (await evaluateInTab(
      `(function() {
        var p = window.__dtmClickProbe;
        if (!p) return { ok: false };
        try { p.observer.disconnect(); } catch (_e) {}
        var r = {
          ok: true,
          mutationCount: p.mutationCount,
          urlChanged: p.beforeUrl !== location.href,
          // The silent button is a <button type="button"> — clicking it
          // synthetically still focuses it on some Chromium versions, which
          // would mask a real silent-fail. We compare to a fresh
          // activeElement read here, but the production handler treats
          // activeElement-only change as a delivered signal anyway (matrix
          // doc §3.1 explicitly lists it). This assertion only pins the
          // mutation half.
          activeElementChanged: p.beforeActive !== document.activeElement
        };
        delete window.__dtmClickProbe;
        return r;
      })()`,
      null,
      TEST_PORT,
    )) as { ok: boolean; mutationCount: number; urlChanged: boolean; activeElementChanged: boolean };
    expect(reading.ok).toBe(true);
    // The silent button cannot append/remove/attribute-toggle anything in the
    // body subtree — mutationCount stays 0.
    expect(reading.mutationCount).toBe(0);
    expect(reading.urlChanged).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full browser_click handler — requires HEADED mode for nut-js mouse hardware.
// ─────────────────────────────────────────────────────────────────────────────

describe.runIf(IS_HEADED && CHROME_AVAILABLE)(
  "issue #181 — browser_click handler verification (headed)",
  () => {
    it("clicking a bound button emits hints.verifyDelivery.status='delivered'", async () => {
      // Reset bound target.
      await evaluateInTab(
        "document.getElementById('btn-verify-bound-target').textContent = ''",
        null,
        TEST_PORT,
      );
      const result = await browserClickElementHandler({
        selector: "#btn-verify-bound",
        port: TEST_PORT,
      });
      const body = parseFirstLine(result) as {
        ok: boolean;
        hints?: { verifyDelivery?: { status?: string; channel?: string; observedSignals?: { mutationCount: number } } };
      };
      expect(body.ok).toBe(true);
      expect(body.hints?.verifyDelivery?.status).toBe("delivered");
      expect(body.hints?.verifyDelivery?.channel).toBe("cdp");
      expect(body.hints?.verifyDelivery?.observedSignals?.mutationCount ?? 0).toBeGreaterThan(0);
    });

    it("clicking a silent SPA button emits hints.verifyDelivery.status='unverifiable'", async () => {
      const result = await browserClickElementHandler({
        selector: "#btn-verify-silent",
        port: TEST_PORT,
      });
      const body = parseFirstLine(result) as {
        ok: boolean;
        hints?: { verifyDelivery?: { status?: string; reason?: string } };
      };
      expect(body.ok).toBe(true);
      // Silent button — no DOM mutation, no URL change. The handler must NOT
      // claim 'delivered' here; the contract is to emit 'unverifiable' so the
      // LLM caller knows the click reached the OS layer but produced no
      // observable page response.
      expect(body.hints?.verifyDelivery?.status).toBe("unverifiable");
      expect(body.hints?.verifyDelivery?.reason).toBe("no_dom_mutation");
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// browser_fill handler — element.value read-back, headless-friendly.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("issue #181 — browser_fill verification", () => {
  it("plain input retains the requested value (delivered)", async () => {
    // Reset.
    await evaluateInTab(
      "document.getElementById('input-verify-plain').value = ''",
      null,
      TEST_PORT,
    );
    const result = await browserFillInputHandler({
      selector: "#input-verify-plain",
      value: "hello-181",
      port: TEST_PORT,
      includeContext: false,
    });
    const body = parseFirstLine(result) as {
      ok: boolean;
      actual?: string;
      hints?: { verifyDelivery?: { status?: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.actual).toBe("hello-181");
    expect(body.hints?.verifyDelivery?.status).toBe("delivered");
  });

  it("controlled-input transform surfaces BrowserFillNotDelivered with subReason", async () => {
    // Reset.
    await evaluateInTab(
      "document.getElementById('input-verify-numbersonly').value = ''",
      null,
      TEST_PORT,
    );
    const result = await browserFillInputHandler({
      selector: "#input-verify-numbersonly",
      // The numbers-only filter strips letters in the input handler — actual
      // value ends up "123" (length 3 < requested length 6).
      value: "abc123",
      port: TEST_PORT,
      includeContext: false,
    });
    const body = parseFirstLine(result) as {
      ok: false;
      code: string;
      suggest?: string[];
      context?: { subReason?: string; actualLen?: number; requestedLen?: number; note?: string };
      hints?: { verifyDelivery?: { status?: string; reason?: string; subReason?: string } };
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("BrowserFillNotDelivered");
    expect(body.context?.subReason).toBe("controlled_input_transform");
    expect(body.context?.actualLen ?? 0).toBeLessThan(body.context?.requestedLen ?? 0);
    // Hint shape (matrix doc §4.2) — present on failure path too.
    expect(body.hints?.verifyDelivery?.status).toBe("unverifiable");
    expect(body.hints?.verifyDelivery?.subReason).toBe("controlled_input_transform");
    // suggest[] must include the controlled-input disclaimer so the caller
    // knows not to retry blindly.
    expect((body.suggest ?? []).join(" ")).toMatch(/controlled_input_transform|controlled input/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #441 — browser_click handler rescue (hidden/zero-size selector duplicate)
//
// The STOP branches (ambiguous / no-actionable) return before any OS click, so
// they exercise the full handler → ElementZeroSizeError catch → rescue → typed
// failure pipeline HEADLESS. The success branch issues a real nut-js click and is
// HEADED-gated (parity with the #181 handler test above).
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("issue #441 — browser_click rescue stop branches (headless)", () => {
  it("zero-size first match + TWO visible duplicates → BrowserAmbiguousTarget + candidates (no auto-click)", async () => {
    // querySelector('[aria-label="Ambiguous Dup"]') matches the hidden div first
    // → ElementZeroSizeError → rescue → 2 visible actionable → ambiguous stop.
    const result = await browserClickElementHandler({
      selector: '[aria-label="Ambiguous Dup"]',
      port: TEST_PORT,
    });
    const body = parseFirstLine(result) as {
      ok: false;
      code: string;
      context?: { candidates?: Array<{ index: number; name: string }>; total?: number };
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("BrowserAmbiguousTarget");
    // The rescue surfaces the visible candidates so the agent can disambiguate.
    expect((body.context?.candidates ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe.runIf(IS_HEADED && CHROME_AVAILABLE)("issue #441 — browser_click rescue success (headed)", () => {
  it("zero-size first match + ONE visible duplicate → clicks the visible button (resolvedVia rescue)", async () => {
    await evaluateInTab("window._clickLog = []", null, TEST_PORT);
    const result = await browserClickElementHandler({
      selector: '[aria-label="Request Indexing"]',
      port: TEST_PORT,
    });
    const body = parseFirstLine(result) as {
      ok: boolean;
      clicked?: unknown;
      resolvedVia?: string;
    };
    expect(body.ok).toBe(true);
    // selector-mode wire shape preserved: clicked is the selector string.
    expect(body.clicked).toBe('[aria-label="Request Indexing"]');
    expect(body.resolvedVia).toBe("actionability-rescue");
    // The OS click landed on the VISIBLE button, not the hidden duplicate.
    const log = (await evaluateInTab(
      "JSON.stringify((window._clickLog || []).map(e => e.id))",
      null,
      TEST_PORT,
    )) as string;
    expect(JSON.parse(log)).toContain("dup441-visible-btn");
  });
});
