/**
 * browser-app-state.test.ts — `browser_get_app_state` end-to-end.
 *
 * Verifies the new tool from #2:
 *   - Discovers Next.js / GitHub react-app / JSON-LD / Redux SSR payloads
 *   - Returns parsed JSON
 *   - Empty `notFound` for selectors that match
 *   - Custom selector override works
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { browserGetAppStateHandler } from "../../src/tools/browser.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9230;
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;
const CHROME_AVAILABLE = tryFindChrome() !== null;

let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(TEST_PORT, true, FIXTURE_URL);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const probe = await evaluateInTab(
        "JSON.stringify([document.title, document.readyState])",
        null,
        TEST_PORT
      );
      const [title, state] = JSON.parse(probe as string) as [string, string];
      if (state === "complete" && title === "desktop-touch CDP Test Page") return;
    } catch { /* not ready */ }
    await sleep(300);
  }
  throw new Error("Test page did not load within 15s");
}, 20_000);

afterAll(() => {
  disconnectAll(TEST_PORT);
  chrome?.kill();
});

interface AppStateHit {
  selector: string;
  framework: string;
  sizeBytes: number;
  truncated: boolean;
  payload: unknown;
}

interface AppStateResponse {
  ok: true;
  found: AppStateHit[];
  notFound: string[];
}

function parseResponse(text: string): AppStateResponse {
  return JSON.parse(text) as AppStateResponse;
}

describe.skipIf(!CHROME_AVAILABLE)("browser_get_app_state — default selectors", () => {
  it("discovers Next.js __NEXT_DATA__ payload", async () => {
    const result = await browserGetAppStateHandler({
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const text = (result.content[0] as { text: string }).text;
    const r = parseResponse(text);
    const next = r.found.find((h) => h.framework === "next");
    expect(next).toBeDefined();
    expect((next!.payload as { props: { pageProps: { foo: string } } }).props.pageProps.foo).toBe("next-bar");
  });

  it("discovers GitHub react-app embeddedData payload", async () => {
    const result = await browserGetAppStateHandler({
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    const hit = r.found.find((h) => h.framework === "react-app");
    expect(hit).toBeDefined();
    const payload = hit!.payload as { payload: { vulnerabilityEmail: boolean } };
    expect(payload.payload.vulnerabilityEmail).toBe(true);
  });

  it("discovers JSON-LD metadata", async () => {
    const result = await browserGetAppStateHandler({
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    const ld = r.found.find((h) => h.framework === "ld+json");
    expect(ld).toBeDefined();
  });

  it("discovers window.__INITIAL_STATE__ Redux SSR snapshot", async () => {
    const result = await browserGetAppStateHandler({
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    const init = r.found.find((h) => h.selector === "window:__INITIAL_STATE__");
    expect(init).toBeDefined();
    const payload = init!.payload as { user: string; count: number };
    expect(payload.user).toBe("harusame64");
    expect(payload.count).toBe(42);
  });

  it("notFound contains the selectors that did not match", async () => {
    const result = await browserGetAppStateHandler({
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    // Fixture has no Nuxt / Remix / Apollo
    expect(r.notFound).toEqual(expect.arrayContaining([expect.stringMatching(/__NUXT|__REMIX|__APOLLO/i)]));
  });
});

describe.skipIf(!CHROME_AVAILABLE)("browser_get_app_state — custom selectors", () => {
  it("respects an explicit selector list", async () => {
    const result = await browserGetAppStateHandler({
      selectors: ["script#__NEXT_DATA__"],
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    expect(r.found).toHaveLength(1);
    expect(r.found[0]!.selector).toBe("script#__NEXT_DATA__");
    expect(r.found[0]!.framework).toBe("custom");
  });

  it("supports window: prefix for globals", async () => {
    const result = await browserGetAppStateHandler({
      selectors: ["window:__INITIAL_STATE__"],
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    expect(r.found).toHaveLength(1);
    const payload = r.found[0]!.payload as { user: string };
    expect(payload.user).toBe("harusame64");
  });

  it("missing selector lands in notFound, not found", async () => {
    const result = await browserGetAppStateHandler({
      selectors: ["script#never-going-to-exist", "window:__NO_SUCH_GLOBAL__"],
      maxBytes: 4000,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    expect(r.found).toHaveLength(0);
    expect(r.notFound).toEqual([
      "script#never-going-to-exist",
      "window:__NO_SUCH_GLOBAL__",
    ]);
  });
});

describe.skipIf(!CHROME_AVAILABLE)("browser_get_app_state — truncation", () => {
  it("flags truncated:true and slices the payload when over maxBytes", async () => {
    const result = await browserGetAppStateHandler({
      selectors: ["script#__NEXT_DATA__"],
      maxBytes: 20,
      port: TEST_PORT,
      includeContext: false,
    });
    const r = parseResponse((result.content[0] as { text: string }).text);
    expect(r.found).toHaveLength(1);
    expect(r.found[0]!.truncated).toBe(true);
    // Truncated payload becomes a parse-error fallback with `preview`
    const payload = r.found[0]!.payload as { __parseError?: string; preview?: string };
    expect(payload.__parseError).toBeDefined();
    expect(typeof payload.preview).toBe("string");
  });
});
