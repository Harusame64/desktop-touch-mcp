/**
 * browser-interactive-aria.test.ts — `browser_get_interactive` ARIA support.
 *
 * Verifies the additions from #3:
 *   - role=switch / checkbox / radio / tab / menuitem are surfaced
 *   - aria-checked / aria-pressed / aria-selected / aria-expanded
 *     populate the new optional `state` field
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { launchChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { browserGetInteractiveHandler } from "../../src/tools/browser.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "test-page.html");
const TEST_PORT = 9229;
const FIXTURE_URL = `file:///${FIXTURE_PATH.replace(/\\/g, "/")}`;

let chrome: ChromeInstance;

beforeAll(async () => {
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

interface InteractiveItem {
  type: string;
  text: string;
  selector: string;
  inViewport: boolean;
  state?: {
    checked?: boolean;
    pressed?: boolean;
    selected?: boolean;
    expanded?: boolean;
  };
}

function extractItems(text: string): InteractiveItem[] {
  // The handler emits "Found N ...:\n[json]\n\nactiveTab:..." — the JSON
  // block is the first '[' after the header line.
  const open = text.indexOf("[");
  const close = text.lastIndexOf("]");
  if (open < 0 || close < 0) throw new Error("No JSON array in response");
  return JSON.parse(text.slice(open, close + 1)) as InteractiveItem[];
}

describe("browser_get_interactive ARIA support", () => {
  it("surfaces role=switch with state.checked", async () => {
    const result = await browserGetInteractiveHandler({
      types: ["all"],
      inViewportOnly: false,
      maxResults: 200,
      port: TEST_PORT,
      includeContext: false,
    });
    const items = extractItems((result.content[0] as { text: string }).text);
    const switchOn = items.find((i) => i.selector === "#aria-switch-on");
    const switchOff = items.find((i) => i.selector === "#aria-switch-off");
    expect(switchOn).toBeDefined();
    expect(switchOff).toBeDefined();
    expect(switchOn!.type).toBe("toggle[switch]");
    expect(switchOn!.state).toEqual({ checked: true });
    expect(switchOff!.state).toEqual({ checked: false });
  });

  it("surfaces role=checkbox / role=radio with state.checked", async () => {
    const result = await browserGetInteractiveHandler({
      types: ["all"],
      inViewportOnly: false,
      maxResults: 200,
      port: TEST_PORT,
      includeContext: false,
    });
    const items = extractItems((result.content[0] as { text: string }).text);
    const cb = items.find((i) => i.selector === "#aria-checkbox-on");
    const rd = items.find((i) => i.selector === "#aria-radio-off");
    expect(cb?.type).toBe("toggle[checkbox]");
    expect(cb?.state).toEqual({ checked: true });
    expect(rd?.type).toBe("toggle[radio]");
    expect(rd?.state).toEqual({ checked: false });
  });

  it("surfaces role=tab with state.selected", async () => {
    const result = await browserGetInteractiveHandler({
      types: ["all"],
      inViewportOnly: false,
      maxResults: 200,
      port: TEST_PORT,
      includeContext: false,
    });
    const items = extractItems((result.content[0] as { text: string }).text);
    const tab = items.find((i) => i.selector === "#aria-tab-active");
    expect(tab?.type).toBe("tab");
    expect(tab?.state).toEqual({ selected: true });
  });

  it("surfaces aria-pressed on a regular <button>", async () => {
    const result = await browserGetInteractiveHandler({
      types: ["all"],
      inViewportOnly: false,
      maxResults: 200,
      port: TEST_PORT,
      includeContext: false,
    });
    const items = extractItems((result.content[0] as { text: string }).text);
    const btn = items.find((i) => i.selector === "#aria-pressed-on");
    expect(btn?.state).toEqual({ pressed: true });
  });

  it("surfaces aria-expanded on a regular <button>", async () => {
    const result = await browserGetInteractiveHandler({
      types: ["all"],
      inViewportOnly: false,
      maxResults: 200,
      port: TEST_PORT,
      includeContext: false,
    });
    const items = extractItems((result.content[0] as { text: string }).text);
    const btn = items.find((i) => i.selector === "#aria-expanded-off");
    expect(btn?.state).toEqual({ expanded: false });
  });

  it("does NOT add a state field on a plain button without ARIA state attrs", async () => {
    const result = await browserGetInteractiveHandler({
      types: ["all"],
      inViewportOnly: false,
      maxResults: 200,
      port: TEST_PORT,
      includeContext: false,
    });
    const items = extractItems((result.content[0] as { text: string }).text);
    const plain = items.find((i) => i.selector === "#btn-submit");
    expect(plain).toBeDefined();
    expect(plain!.state).toBeUndefined();
  });
});
