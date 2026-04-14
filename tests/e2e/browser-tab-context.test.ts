/**
 * browser-tab-context.test.ts — E2E tests for activeTab/readyState annotation
 *
 * Verifies that browser_eval, browser_find_element, browser_get_dom,
 * browser_get_interactive, and browser_click_element all append
 * activeTab + readyState lines to their success responses.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import {
  browserEvalHandler,
  browserFindElementHandler,
  browserGetDomHandler,
  browserGetInteractiveHandler,
} from "../../src/tools/browser.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9226;
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;

let chrome: ChromeInstance;

beforeAll(async () => {
  chrome = await launchChrome(TEST_PORT, true, FIXTURE_URL);
  // Wait until the fixture page itself is fully loaded — not just any tab.
  // Headless Chrome can briefly expose an about:blank tab before navigating
  // to the file:// fixture, and resolveTab(null) returns the first matching
  // page tab regardless of URL.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const probe = await evaluateInTab(
        "JSON.stringify([document.title, document.readyState, location.href])",
        null,
        TEST_PORT
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

function extractTabContext(text: string): { activeTab: unknown; readyState: string } | null {
  // Match activeTab: {...} line — URL may contain :// so we match until end of line
  const activeTabMatch = text.match(/^activeTab:\s*(.+)$/m);
  const readyStateMatch = text.match(/^readyState:\s*"(\w+)"/m);
  if (!activeTabMatch || !readyStateMatch) return null;
  try {
    const activeTab = JSON.parse(activeTabMatch[1]);
    return { activeTab, readyState: readyStateMatch[1] };
  } catch {
    return null;
  }
}

describe("browser_eval — activeTab/readyState annotation", () => {
  it("appends activeTab and readyState to successful eval", async () => {
    const result = await browserEvalHandler({
      expression: "1 + 1",
      port: TEST_PORT,
    });
    const text = (result.content[0] as { text: string }).text;
    const ctx = extractTabContext(text);
    expect(ctx).not.toBeNull();
    expect(ctx!.activeTab).toHaveProperty("id");
    expect(ctx!.activeTab).toHaveProperty("title");
    expect(ctx!.activeTab).toHaveProperty("url");
    expect(["loading", "interactive", "complete"]).toContain(ctx!.readyState);
  });

  it("does not append activeTab/readyState on failure", async () => {
    const result = await browserEvalHandler({
      expression: "throw new Error('intentional')",
      port: TEST_PORT,
    });
    const text = (result.content[0] as { text: string }).text;
    // Should be a failure JSON, not have activeTab
    expect(text).not.toMatch(/activeTab:/);
  });
});

describe("browser_find_element — activeTab/readyState annotation", () => {
  it("appends activeTab and readyState on success", async () => {
    const result = await browserFindElementHandler({
      selector: "#btn-submit",
      port: TEST_PORT,
    });
    const text = (result.content[0] as { text: string }).text;
    const ctx = extractTabContext(text);
    if (ctx === null) {
      throw new Error(
        `extractTabContext returned null. Raw handler output:\n--- BEGIN ---\n${text}\n--- END ---`
      );
    }
    expect(ctx.activeTab).toHaveProperty("id");
    expect(["loading", "interactive", "complete"]).toContain(ctx.readyState);
  });
});

describe("browser_get_dom — activeTab/readyState annotation", () => {
  it("appends activeTab and readyState on success", async () => {
    const result = await browserGetDomHandler({
      selector: "#btn-submit",
      maxLength: 500,
      port: TEST_PORT,
    });
    const text = (result.content[0] as { text: string }).text;
    const ctx = extractTabContext(text);
    if (ctx === null) {
      throw new Error(
        `extractTabContext returned null. Raw handler output:\n--- BEGIN ---\n${text}\n--- END ---`
      );
    }
    expect(["loading", "interactive", "complete"]).toContain(ctx.readyState);
  });
});

describe("browser_get_interactive — activeTab/readyState annotation", () => {
  it("appends activeTab and readyState on success", async () => {
    const result = await browserGetInteractiveHandler({
      types: ["all"],
      inViewportOnly: false,
      maxResults: 10,
      port: TEST_PORT,
    });
    const text = (result.content[0] as { text: string }).text;
    const ctx = extractTabContext(text);
    expect(ctx).not.toBeNull();
    expect(["loading", "interactive", "complete"]).toContain(ctx!.readyState);
  });
});
