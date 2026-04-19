/**
 * browser-navigate-wait.test.ts — E2E tests for browser_navigate waitForLoad
 *
 * Tests:
 *  - waitForLoad=true (default): returns readyState="complete" + title/url/elapsedMs
 *  - waitForLoad=false: returns immediately without readyState
 *  - loadTimeoutMs=1 with navigate + timeout path
 *  - URL validation: non-http(s) URLs are rejected
 *
 * Note: browser_navigate only accepts http:// and https:// URLs.
 * We use http://example.com for live tests (requires network) or skip gracefully.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { browserNavigateHandler } from "../../src/tools/browser.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9227;
// Chrome is launched with the fixture as initial URL (file:// via CLI arg, bypassing navigateTo)
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;

// A real http URL to test navigate with — uses example.com which is reliably reachable
const TEST_HTTP_URL = "http://example.com";
const CHROME_AVAILABLE = tryFindChrome() !== null;

let chrome: ChromeInstance;
let hasNetwork = false;
let prevAutoGuard: string | undefined;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  // Disable Auto Perception guard — this suite has no lensId and the guard would
  // block navigation calls with AutoGuardBlocked on machines running v0.12+.
  prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
  process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  chrome = await launchChrome(TEST_PORT, true, FIXTURE_URL);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const state = await evaluateInTab("document.readyState", null, TEST_PORT);
      if (state === "complete") break;
    } catch { /* not ready */ }
    await sleep(300);
  }
  // Probe network availability
  try {
    const res = await fetch("http://example.com", { signal: AbortSignal.timeout(3000) });
    hasNetwork = res.ok;
  } catch {
    hasNetwork = false;
  }
}, 20_000);

afterAll(() => {
  if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
  else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

describe.skipIf(!CHROME_AVAILABLE)("browser_navigate waitForLoad", () => {
  it("rejects file:// URLs with error (http/https only)", async () => {
    const result = await browserNavigateHandler({
      url: FIXTURE_URL,
      waitForLoad: true,
      loadTimeoutMs: 5_000,
      port: TEST_PORT,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    // Should have an error code (ToolError wraps the throw from navigateTo)
    expect(typeof payload.code).toBe("string");
  });

  it("rejects javascript: URLs", async () => {
    const result = await browserNavigateHandler({
      url: "javascript:alert(1)",
      waitForLoad: true,
      loadTimeoutMs: 5_000,
      port: TEST_PORT,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
  });

  it("returns text response immediately when waitForLoad=false (http URL)", async () => {
    if (!hasNetwork) {
      console.log("Skipping: no network access to http://example.com");
      return;
    }
    const result = await browserNavigateHandler({
      url: TEST_HTTP_URL,
      waitForLoad: false,
      loadTimeoutMs: 15_000,
      port: TEST_PORT,
    });
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text);
    expect(payload.ok).toBe(true);
    expect(payload.waited).toBe(false);
    expect(payload.url).toBe(TEST_HTTP_URL);
    expect(typeof payload.hint).toBe("string");
    // waitForLoad=false must NOT include readyState (we didn't wait)
    expect(payload.readyState).toBeUndefined();
  }, 10_000);

  it("returns readyState='complete' and title/url/elapsedMs when waitForLoad=true", async () => {
    if (!hasNetwork) {
      console.log("Skipping: no network access to http://example.com");
      return;
    }
    const result = await browserNavigateHandler({
      url: TEST_HTTP_URL,
      waitForLoad: true,
      loadTimeoutMs: 15_000,
      port: TEST_PORT,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(payload.readyState).toBe("complete");
    expect(typeof payload.title).toBe("string");
    expect(typeof payload.url).toBe("string");
    expect(typeof payload.elapsedMs).toBe("number");
    expect(payload.waited).toBe(true);
  }, 20_000);

  it("returns NavigateTimeout hint when loadTimeoutMs is too short", async () => {
    if (!hasNetwork) {
      console.log("Skipping: no network access to http://example.com");
      return;
    }
    // Navigate to example.com with an extremely short timeout — will likely timeout
    // before readyState=complete (though the page may load fast enough to complete)
    const result = await browserNavigateHandler({
      url: TEST_HTTP_URL,
      waitForLoad: true,
      loadTimeoutMs: 1,
      port: TEST_PORT,
    });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    // Should succeed (ok:true) even on timeout — page is partially loaded
    expect(payload.ok).toBe(true);
    if (payload.hints?.warnings) {
      expect(payload.hints.warnings).toContain("NavigateTimeout");
    }
    // Either way, readyState field must be present when waitForLoad=true
    expect(typeof payload.readyState).toBe("string");
  }, 15_000);
});
