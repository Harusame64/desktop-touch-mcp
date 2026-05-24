/**
 * browser-click-by-axis.test.ts — E2E for ADR-023 Phase 1 PR3 browser_click({by}).
 *
 * Exercises the by-axis handler path against real headless Chrome. The
 * ambiguous / no-actionable / error STOPS return before any OS click, so they are
 * fully covered headless (the genuinely-new PR3 logic = resolver outcome → typed
 * failure mapping). The resolved → real OS click → delivered path needs physical
 * mouse hardware, so it is gated on HEADED=1 (the OS-click+verify core is already
 * covered by the selector path in browser-cdp-verification.test.ts).
 *
 * @see src/tools/browser.ts  handleBrowserClickByAxis
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserClickElementHandler } from "../../src/tools/browser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "resolver-gsc-like.html");
const TEST_PORT = 9230;
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;
const CHROME_AVAILABLE = tryFindChrome() !== null;
const IS_HEADED = Boolean(process.env.HEADED);

let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(TEST_PORT, !IS_HEADED, FIXTURE_URL);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluateInTab(
        `document.readyState === 'complete' && document.querySelector('#real-settings') !== null && ` +
        `document.querySelector('#real-settings').getBoundingClientRect().width > 0`,
        null, TEST_PORT);
      if (ready === true) return;
    } catch { /* ignore */ }
    await sleep(250);
  }
  throw new Error("Fixture did not lay out within 15s");
}, 20_000);

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

function payload(r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = r.content[0]?.type === "text" ? r.content[0].text ?? "{}" : "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function click(args: Record<string, unknown>) {
  return payload(await browserClickElementHandler({ port: TEST_PORT, ...args } as Parameters<typeof browserClickElementHandler>[0]));
}

describe.skipIf(!CHROME_AVAILABLE)("browser_click by-axis — ambiguity & safety stops (headless)", () => {
  it("ambiguous match stops with code:'BrowserAmbiguousTarget' + candidates + next (no click)", async () => {
    const r = await click({ by: "text", pattern: "Save" });
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe("BrowserAmbiguousTarget");
    expect(Array.isArray(r.suggest)).toBe(true);
    const ctx = r.context as { total: number; candidates: unknown[] };
    expect(ctx.total).toBe(3);
    expect(ctx.candidates.length).toBe(3);
  });

  it("matched-but-non-actionable stops with code:'BrowserNoActionableTarget'", async () => {
    const r = await click({ by: "text", pattern: "Just a label Foobar" });
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe("BrowserNoActionableTarget");
  });

  it("an inherited-disabled (fieldset) button is non-actionable", async () => {
    const r = await click({ by: "text", pattern: "Fieldset Action" });
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe("BrowserNoActionableTarget");
  });

  it("role filter narrows to the off-viewport link → BrowserNoActionableTarget", async () => {
    const r = await click({ by: "text", pattern: "Open Settings", role: "link" });
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe("BrowserNoActionableTarget");
  });

  it("an invalid scope surfaces ScopeNotFound", async () => {
    const r = await click({ by: "text", pattern: "Save", scope: "#no-such-scope" });
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.code).toBe("ScopeNotFound");
  });
});

describe.skipIf(!CHROME_AVAILABLE || !IS_HEADED)("browser_click by-axis — resolved OS click (HEADED)", () => {
  it("clicks a uniquely-resolved bound button and reports delivered", async () => {
    // reset
    await evaluateInTab("document.getElementById('bound-out').textContent = ''", null, TEST_PORT);
    const r = await click({ by: "text", pattern: "Bound Action" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const hints = r.hints as { verifyDelivery?: { status?: string } };
    expect(hints.verifyDelivery?.status).toBe("delivered");
    const out = await evaluateInTab("document.getElementById('bound-out').textContent", null, TEST_PORT);
    expect(out).toBe("clicked");
  });
});
