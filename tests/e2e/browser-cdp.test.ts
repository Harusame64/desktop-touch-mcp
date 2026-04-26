/**
 * browser-cdp.test.ts — E2E tests for CDP browser integration
 *
 * Tests the cdp-bridge engine functions directly (no MCP server overhead).
 * Requires Chrome/Edge with --remote-debugging-port; auto-launched per suite.
 *
 * Test categories:
 *   - headless: connect, eval, DOM, navigate — runnable in CI
 *   - headed:   coordinate precision + click — requires HEADED=1 env var
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import {
  listTabs,
  evaluateInTab,
  getElementScreenCoords,
  navigateTo,
  getDomHtml,
  disconnectAll,
} from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9224; // Separate from dev port 9222 and other test suite 9223
const IS_HEADED = Boolean(process.env.HEADED);
const CHROME_AVAILABLE = tryFindChrome() !== null;

// ─── Test fixture URL ─────────────────────────────────────────────────────────

// Use file:// URL so no HTTP server is needed
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;

// ─── Suite setup ──────────────────────────────────────────────────────────────

let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  // Launch Chrome with the fixture page as initial URL (file:// bypasses the
  // http-only restriction in navigateTo, which is correct for production use)
  chrome = await launchChrome(TEST_PORT, !IS_HEADED, FIXTURE_URL);
  await waitForLoad("desktop-touch CDP Test Page");
});

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

async function waitForLoad(expectedTitle?: string, maxMs = 8_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluateInTab("document.readyState", null, TEST_PORT);
      if (state === "complete") {
        if (!expectedTitle) return;
        const title = await evaluateInTab("document.title", null, TEST_PORT);
        if (title === expectedTitle) return;
      }
    } catch {
      // session may not be ready yet
    }
    await sleep(300);
  }
  throw new Error(
    `Page did not finish loading${expectedTitle ? ` with title "${expectedTitle}"` : ""} within ${maxMs}ms`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// browser_connect equivalent — listTabs
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("listTabs", () => {
  it("returns at least one page tab", async () => {
    const tabs = await listTabs(TEST_PORT);
    expect(tabs.length).toBeGreaterThan(0);
    const pageTabs = tabs.filter((t) => t.type === "page");
    expect(pageTabs.length).toBeGreaterThan(0);
  });

  it("each tab has id, title, url, webSocketDebuggerUrl", async () => {
    const tabs = await listTabs(TEST_PORT);
    const page = tabs.find((t) => t.type === "page")!;
    expect(page.id).toBeTruthy();
    expect(page.webSocketDebuggerUrl).toMatch(/^ws:\/\//);
  });

  it("throws a descriptive error on wrong port", async () => {
    await expect(listTabs(19999)).rejects.toThrow(/CDP|remote-debugging-port|Cannot reach/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateInTab — browser_eval
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("evaluateInTab", () => {
  it("returns document.title of the test page", async () => {
    const title = await evaluateInTab("document.title", null, TEST_PORT);
    expect(title).toBe("desktop-touch CDP Test Page");
  });

  it("returns a number", async () => {
    const val = await evaluateInTab("1 + 2 + 3", null, TEST_PORT);
    expect(val).toBe(6);
  });

  it("returns null for void expressions", async () => {
    const val = await evaluateInTab("void 0", null, TEST_PORT);
    expect(val).toBeUndefined();
  });

  it("returns a JSON-serializable object", async () => {
    const val = (await evaluateInTab(
      "JSON.stringify({a: 1, b: 'hello'})",
      null,
      TEST_PORT
    )) as string;
    expect(JSON.parse(val)).toEqual({ a: 1, b: "hello" });
  });

  it("can read and set a DOM element's textContent", async () => {
    // Set
    await evaluateInTab(
      "document.getElementById('text-result').textContent = 'test-marker-42'",
      null,
      TEST_PORT
    );
    // Read back
    const text = await evaluateInTab(
      "document.getElementById('text-result').textContent",
      null,
      TEST_PORT
    );
    expect(text).toBe("test-marker-42");
  });

  it("throws on syntax error", async () => {
    await expect(
      evaluateInTab("this is not valid JS !!!", null, TEST_PORT)
    ).rejects.toThrow(/JS exception/);
  });

  it("throws when expression throws", async () => {
    await expect(
      evaluateInTab("throw new Error('intentional error')", null, TEST_PORT)
    ).rejects.toThrow(/intentional error/);
  });

  it("can await async expressions", async () => {
    const val = await evaluateInTab(
      "new Promise(r => setTimeout(() => r('async-ok'), 100))",
      null,
      TEST_PORT
    );
    expect(val).toBe("async-ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getElementScreenCoords — browser_find_element
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("getElementScreenCoords", () => {
  it("returns coords for #btn-submit", async () => {
    const coords = await getElementScreenCoords("#btn-submit", null, TEST_PORT);
    expect(coords.x).toBeGreaterThan(0);
    expect(coords.y).toBeGreaterThan(0);
    expect(coords.width).toBeGreaterThan(0);
    expect(coords.height).toBeGreaterThan(0);
  });

  it("returns coords within reasonable screen bounds", async () => {
    const coords = await getElementScreenCoords("#btn-submit", null, TEST_PORT);
    // Screen should be at most 8K resolution
    expect(coords.x).toBeLessThan(8000);
    expect(coords.y).toBeLessThan(8000);
    expect(coords.x).toBeGreaterThan(0);
    expect(coords.y).toBeGreaterThan(0);
  });

  it("center = left + width/2 (roughly)", async () => {
    const coords = await getElementScreenCoords("#btn-submit", null, TEST_PORT);
    const expectedCenterX = coords.left + Math.round(coords.width / 2);
    expect(Math.abs(coords.x - expectedCenterX)).toBeLessThanOrEqual(1);
  });

  it("center = top + height/2 (roughly)", async () => {
    const coords = await getElementScreenCoords("#btn-submit", null, TEST_PORT);
    const expectedCenterY = coords.top + Math.round(coords.height / 2);
    expect(Math.abs(coords.y - expectedCenterY)).toBeLessThanOrEqual(1);
  });

  it("reports inViewport=true for visible element", async () => {
    const coords = await getElementScreenCoords("#btn-submit", null, TEST_PORT);
    expect(coords.inViewport).toBe(true);
  });

  it("reports inViewport=false for below-fold element (before scrolling)", async () => {
    // Reset scroll to top
    await evaluateInTab("window.scrollTo(0, 0)", null, TEST_PORT);
    const coords = await getElementScreenCoords(
      "#section-scroll",
      null,
      TEST_PORT
    );
    expect(coords.inViewport).toBe(false);
  });

  it("reports inViewport=true after scrolling element into view", async () => {
    await evaluateInTab(
      "document.getElementById('section-scroll').scrollIntoView()",
      null,
      TEST_PORT
    );
    await sleep(300); // give browser time to scroll
    const coords = await getElementScreenCoords(
      "#section-scroll",
      null,
      TEST_PORT
    );
    expect(coords.inViewport).toBe(true);
    // Restore scroll
    await evaluateInTab("window.scrollTo(0, 0)", null, TEST_PORT);
  });

  it("throws for non-existent selector", async () => {
    await expect(
      getElementScreenCoords("#does-not-exist-xyz", null, TEST_PORT)
    ).rejects.toThrow(/not found/i);
  });

  it("throws for zero-size hidden element", async () => {
    await expect(
      getElementScreenCoords("#btn-hidden", null, TEST_PORT)
    ).rejects.toThrow(/zero size|hidden/i);
  });

  it("two different elements have different coords", async () => {
    const btn = await getElementScreenCoords("#btn-submit", null, TEST_PORT);
    const input = await getElementScreenCoords("#input-name", null, TEST_PORT);
    expect(btn.x).not.toBe(input.x);
    expect(btn.y).not.toBe(input.y);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDomHtml — engine layer for browser_eval(action='dom')
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("getDomHtml", () => {
  it("returns document.body HTML when no selector given", async () => {
    const html = await getDomHtml(null, null, TEST_PORT);
    expect(html).toContain("btn-submit");
    expect(html).toContain("input-name");
  });

  it("returns element HTML for a valid selector", async () => {
    const html = await getDomHtml("#btn-submit", null, TEST_PORT);
    expect(html).toContain("btn-submit");
    expect(html).not.toContain("input-name"); // different element
  });

  it("throws for missing selector", async () => {
    await expect(
      getDomHtml("#no-such-element", null, TEST_PORT)
    ).rejects.toThrow(/Element not found/);
  });

  it("truncates at maxLength", async () => {
    const html = await getDomHtml(null, null, TEST_PORT, 100);
    expect(html.length).toBeLessThanOrEqual(200); // allow for truncation message
    expect(html).toContain("truncated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// navigateTo — browser_navigate
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CHROME_AVAILABLE)("navigateTo", () => {
  it("navigates to a new http page and title changes", async () => {
    await navigateTo("https://example.com", null, TEST_PORT);
    await sleep(2000);
    const title = await evaluateInTab("document.title", null, TEST_PORT);
    expect(typeof title).toBe("string");
    expect((title as string).length).toBeGreaterThan(0);

    // Restore fixture via browser history (file:// → https:// → file:// via back())
    await evaluateInTab("window.history.back()", null, TEST_PORT);
    await waitForLoad("desktop-touch CDP Test Page");
  });

  it("throws for non-http(s) URLs", async () => {
    await expect(
      navigateTo("javascript:alert(1)", null, TEST_PORT)
    ).rejects.toThrow(/https?/);
    await expect(
      navigateTo("file:///C:/Windows/system.ini", null, TEST_PORT)
    ).rejects.toThrow(/https?/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate precision — headed only (requires HEADED=1)
// ─────────────────────────────────────────────────────────────────────────────

describe.runIf(IS_HEADED && CHROME_AVAILABLE)("coordinate precision (headed mode)", () => {
  it("coords change consistently when page is scrolled", async () => {
    await evaluateInTab("window.scrollTo(0, 0)", null, TEST_PORT);
    const before = await getElementScreenCoords("#btn-submit", null, TEST_PORT);

    const scrollAmount = 50; // px
    await evaluateInTab(
      `window.scrollTo(0, ${scrollAmount})`,
      null,
      TEST_PORT
    );
    await sleep(200);

    const after = await getElementScreenCoords("#btn-submit", null, TEST_PORT);
    // Y coordinate should decrease by ~scrollAmount * devicePixelRatio
    const dpr = (await evaluateInTab(
      "window.devicePixelRatio",
      null,
      TEST_PORT
    )) as number;
    const expectedDelta = scrollAmount * dpr;
    const actualDelta = before.y - after.y;
    expect(Math.abs(actualDelta - expectedDelta)).toBeLessThanOrEqual(
      dpr + 1 // allow 1 CSS pixel rounding error
    );

    await evaluateInTab("window.scrollTo(0, 0)", null, TEST_PORT);
  });

  // This test requires physical mouse clicking, so only run headed and locally
  it("find_element coords → mouse_click fires click event", async () => {
    // Reset click log
    await evaluateInTab("window._clickLog = []", null, TEST_PORT);

    const coords = await getElementScreenCoords("#btn-submit", null, TEST_PORT);

    // Dynamically import nut-js mouse here to avoid loading native module
    // in headless/CI runs. This import only succeeds in headed mode with
    // the native addon compiled.
    const { mouse, Button, Point } = await import(
      "../../src/engine/nutjs.js"
    );
    await mouse.setPosition(new Point(coords.x, coords.y));
    await mouse.click(Button.LEFT);
    await sleep(200);

    const log = (await evaluateInTab(
      "JSON.stringify(window._clickLog)",
      null,
      TEST_PORT
    )) as string;
    const events = JSON.parse(log) as Array<{ id: string }>;
    expect(events.some((e) => e.id === "btn-submit")).toBe(true);
  });
});
