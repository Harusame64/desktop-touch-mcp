/**
 * browser-connect-active.test.ts — E2E tests for browser_connect active tab detection
 *
 * Verifies that browserConnectHandler returns:
 *   - top-level "active" field (tab id or null)
 *   - tabs[].active boolean for each tab
 *   - tabs[].active fields are consistent (only one true, or all false if no focus)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { browserConnectHandler, browserOpenHandler } from "../../src/tools/browser.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9228;
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;
const CHROME_AVAILABLE = tryFindChrome() !== null;

let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(TEST_PORT, true, FIXTURE_URL);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const state = await evaluateInTab("document.readyState", null, TEST_PORT);
      if (state === "complete") return;
    } catch { /* not ready */ }
    await sleep(300);
  }
  throw new Error("Test page did not load within 15s");
}, 20_000);

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

function extractJsonBlock(text: string): unknown {
  // The browserConnectHandler embeds a JSON block within the text response
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON block found in response");
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

describe.skipIf(!CHROME_AVAILABLE)("browser_connect active tab detection", () => {
  it("returns tabs array with active boolean field on each tab", async () => {
    const result = await browserConnectHandler({ port: TEST_PORT });
    const text = (result.content[0] as { text: string }).text;
    const payload = extractJsonBlock(text) as { port: number; active: string | null; tabs: Array<{ id: string; title: string; url: string; active: boolean }> };

    expect(Array.isArray(payload.tabs)).toBe(true);
    expect(payload.tabs.length).toBeGreaterThan(0);

    // Every tab should have an 'active' boolean
    for (const tab of payload.tabs) {
      expect(tab).toHaveProperty("id");
      expect(tab).toHaveProperty("title");
      expect(tab).toHaveProperty("url");
      expect(typeof tab.active).toBe("boolean");
    }
  });

  it("returns top-level active field (string id or null)", async () => {
    const result = await browserConnectHandler({ port: TEST_PORT });
    const text = (result.content[0] as { text: string }).text;
    const payload = extractJsonBlock(text) as { active: string | null };

    // active is either null or a string tab id
    const isValid = payload.active === null || typeof payload.active === "string";
    expect(isValid).toBe(true);
  });

  it("port field in JSON matches the requested port", async () => {
    const result = await browserConnectHandler({ port: TEST_PORT });
    const text = (result.content[0] as { text: string }).text;
    const payload = extractJsonBlock(text) as { port: number };
    expect(payload.port).toBe(TEST_PORT);
  });

  it("at most one tab is marked active:true", async () => {
    const result = await browserConnectHandler({ port: TEST_PORT });
    const text = (result.content[0] as { text: string }).text;
    const payload = extractJsonBlock(text) as { tabs: Array<{ active: boolean }> };
    const activeCount = payload.tabs.filter((t) => t.active).length;
    // Headless Chrome tabs may report hasFocus()=false — allow 0 or 1 active tabs
    expect(activeCount).toBeLessThanOrEqual(1);
  });

  it("top-level active matches the tab with active:true", async () => {
    const result = await browserConnectHandler({ port: TEST_PORT });
    const text = (result.content[0] as { text: string }).text;
    const payload = extractJsonBlock(text) as {
      active: string | null;
      tabs: Array<{ id: string; active: boolean }>;
    };
    const activeTab = payload.tabs.find((t) => t.active);
    if (activeTab) {
      expect(payload.active).toBe(activeTab.id);
    } else {
      expect(payload.active).toBeNull();
    }
  });
});

// Phase 3: browser_open dispatcher absorbs former browser_launch via optional launch param.
// This exercise targets the launch-then-connect short circuit when CDP is already live.
describe.skipIf(!CHROME_AVAILABLE)("browser_open(launch:{}) — idempotent connect when CDP already live", () => {
  it("launch:{} on an already-running CDP endpoint returns the connect payload (no spawn)", async () => {
    // Chrome is already running on TEST_PORT (set up in beforeAll). browser_open with
    // launch:{} should detect this via listTabs and skip the spawn step, returning the
    // standard connect payload with tabs[].active.
    const result = await browserOpenHandler({
      port: TEST_PORT,
      launch: {
        browser: "auto",
        userDataDir: "C:\\tmp\\cdp-phase3-test",
        waitMs: 5_000,
      },
    });
    const text = (result.content[0] as { text: string }).text;
    const payload = extractJsonBlock(text) as {
      port: number;
      tabs: Array<{ id: string; title: string; url: string; active: boolean }>;
    };
    expect(payload.port).toBe(TEST_PORT);
    expect(Array.isArray(payload.tabs)).toBe(true);
    expect(payload.tabs.length).toBeGreaterThan(0);
    for (const tab of payload.tabs) {
      expect(typeof tab.active).toBe("boolean");
    }
  });

  it("launch undefined performs pure connect (current connect behaviour)", async () => {
    const result = await browserOpenHandler({ port: TEST_PORT });
    const text = (result.content[0] as { text: string }).text;
    const payload = extractJsonBlock(text) as {
      port: number;
      tabs: Array<{ id: string; active: boolean }>;
    };
    expect(payload.port).toBe(TEST_PORT);
    expect(Array.isArray(payload.tabs)).toBe(true);
  });
});
