/**
 * internal #423: with no tabId, browser_* tools resolved the default page tab (the most recently used one
 * in the browser's list) again for each read, so a tab brought to the front mid-call took the later reads.
 * MEASURED on main (mac, headless Chrome): browser_fill focused #q in one tab, a second tab came to the
 * front while the focus ran, and the value was written into the second tab's #q. The answer was ok,
 * "delivered", with the second tab as activeTab, and the first tab's field stayed empty.
 *
 * Each cell holds the first tab's thread for 2 s inside the call and brings a second tab to the front
 * meanwhile; the call must keep to the tab it started on.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll, listTabs } from "../../src/engine/cdp-bridge.js";
import {
  browserFillInputHandler, browserSearchHandler, browserEvalJsHandler,
  browserGetFormHandler, browserGetDomHandler, browserGetInteractiveHandler, browserGetAppStateHandler,
} from "../../src/tools/browser.js";
import { parsePayload } from "./helpers/wait.js";

/** The text of a reply, and the activeTab line includeContext appends to it. */
function replyText(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((b) => b.type === "text")?.text ?? "";
}
function activeTabOf(text: string): { id: string; title: string } {
  const m = /^activeTab: (\{.*\})$/m.exec(text);
  if (m) return JSON.parse(m[1]!);
  // Some tools put it in their JSON instead of a trailing line.
  const inJson = (() => { try { return (JSON.parse(text) as { activeTab?: { id: string; title: string } }).activeTab; } catch { return undefined; } })();
  if (!inJson) throw new Error(`no activeTab in: ${text.slice(0, 200)}`);
  return inJson;
}

const PORT = 9249;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;
let server: Server;
let base = "";
let prevAutoGuard: string | undefined;
let firstTab = "";
let secondTab: string | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bring a new tab to the front after `afterMs`, while the call under test is running. */
function switchTabsAfter(afterMs: number): Promise<void> {
  return (async () => {
    await sleep(afterMs);
    const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${base}/other`)}`, { method: "PUT" });
    secondTab = ((await res.json()) as { id: string }).id;
    await fetch(`http://127.0.0.1:${PORT}/json/activate/${secondTab}`);
  })();
}

/** Hold the first tab's thread for 2 s, starting at once. */
async function holdFirstTab(): Promise<void> {
  await evaluateInTab(`setTimeout(() => { const t = Date.now(); while (Date.now() - t < 2000); }, 0); 1`, firstTab, PORT);
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
  process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/form")) {
      // Focusing the field holds the thread for 2 s: the gap between browser_fill's focus and its fill.
      res.end(`<title>form</title><form id="f"><input id="q" name="q" onfocus="const t = Date.now(); while (Date.now() - t < 2000);"></form><p>needle</p><a href="#a">link</a>`);
    } else {
      res.end(`<title>other</title><input id="q"><p>needle</p>`);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await launchChrome(PORT, true, `${base}/form`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* not ready */ }
    await sleep(300);
  }
  firstTab = (await listTabs(PORT)).find((t) => t.type === "page")!.id;
}, 20_000);

beforeEach(async () => {
  if (!CHROME_AVAILABLE) return;
  // The first tab in front again, its field empty.
  await fetch(`http://127.0.0.1:${PORT}/json/activate/${firstTab}`);
  await evaluateInTab(`document.querySelector('#q').value = ''; window.__done = 1`, firstTab, PORT);
});

afterEach(async () => {
  if (secondTab) await fetch(`http://127.0.0.1:${PORT}/json/close/${secondTab}`).catch(() => undefined);
  secondTab = null;
  // Let a held thread go before the next cell.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("1", firstTab, PORT) === 1) break; } catch { /* still held */ }
    await sleep(200);
  }
});

afterAll(() => {
  if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
  else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  disconnectAll(PORT);
  chrome?.kill();
  server?.closeAllConnections?.();
  server?.close();
});

describe.skipIf(!CHROME_AVAILABLE)("a browser tool works on the tab it started on", () => {
  it("browser_fill writes into the field it focused, not into a tab that came to the front", async () => {
    const switching = switchTabsAfter(700);
    const text = replyText(await browserFillInputHandler({ selector: "#q", value: "hello", port: PORT, includeContext: true } as never));
    await switching;
    expect(text).toMatch(/^\{"ok":true/);
    expect(await evaluateInTab("document.querySelector('#q').value", firstTab, PORT)).toBe("hello");
    expect(await evaluateInTab("document.querySelector('#q').value", secondTab!, PORT)).toBe("");
    expect(activeTabOf(text).id).toBe(firstTab);
  }, 30_000);

  it("browser_search names the tab it searched as activeTab", async () => {
    await holdFirstTab();
    const switching = switchTabsAfter(700);
    const r = parsePayload(await browserSearchHandler({
      by: "text", pattern: "needle", maxResults: 5, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false, port: PORT,
    } as never));
    await switching;
    expect(r.total).toBeGreaterThan(0);
    expect(r.activeTab.id).toBe(firstTab);
    expect(r.activeTab.title).toBe("form");
  }, 30_000);

  it("browser_eval with includeContext names the tab it ran in", async () => {
    await holdFirstTab();
    const switching = switchTabsAfter(700);
    const text = replyText(await browserEvalJsHandler({ expression: "document.title", port: PORT, includeContext: true } as never));
    await switching;
    expect(text).toMatch(/^form\b/);
    expect(activeTabOf(text).id).toBe(firstTab);
  }, 30_000);

  // The other tools that name a tab with includeContext: each must name the tab it read.
  const contextCalls: Array<[string, () => Promise<{ content: Array<{ type: string; text?: string }> }>]> = [
    ["browser_form", () => browserGetFormHandler({ selector: "#f", includeHidden: false, maxResults: 50, port: PORT, includeContext: true } as never)],
    ["browser_get_dom", () => browserGetDomHandler({ selector: "#f", port: PORT, maxLength: 2000, includeContext: true } as never)],
    ["browser_overview", () => browserGetInteractiveHandler({ types: ["all"], inViewportOnly: false, maxResults: 50, port: PORT, includeContext: true } as never)],
    ["browser_get_app_state", () => browserGetAppStateHandler({ maxBytes: 2000, port: PORT, includeContext: true } as never)],
  ];
  for (const [name, call] of contextCalls) {
    it(`${name} names the tab it read`, async () => {
      await holdFirstTab();
      const switching = switchTabsAfter(700);
      const text = replyText(await call());
      await switching;
      expect(activeTabOf(text).id).toBe(firstTab);
    }, 30_000);
  }
});
