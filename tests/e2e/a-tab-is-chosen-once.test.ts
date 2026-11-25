/**
 * internal #423: which tab a call reads.
 * - browser_navigate with no tabId picked the default page tab again on every read, so a tab brought to
 *   the front during the load wait was read instead. MEASURED on main (mac): a navigation still loading
 *   answered ok at 857 ms with the other tab's title, URL and readyState "complete".
 * - wait_until with a tabId that names no open tab polled to its timeout. MEASURED on main: url_matches
 *   answered WaitTimeout after 1981 ms of 2000.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserNavigateHandler, registerBrowserTools } from "../../src/tools/browser.js";
import { waitUntilHandler, setBrowserSearchHook } from "../../src/tools/wait-until.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9248;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;
let server: Server;
let base = "";
let prevAutoGuard: string | undefined;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function openTab(url: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return ((await res.json()) as { id: string }).id;
}
async function closeTab(id: string): Promise<void> {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`).catch(() => undefined);
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
  process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  registerBrowserTools(new Proxy({}, { get: () => () => undefined }) as never);
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/hang-img")) res.end(`<title>hang</title><p>x</p><img src="/never">`);
    else if (req.url?.startsWith("/never")) { /* never answered: the load never completes */ }
    else res.end(`<title>other</title><button>Save</button>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await launchChrome(PORT, true, `${base}/start`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* not ready */ }
    await sleep(300);
  }
}, 20_000);

afterAll(() => {
  if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
  else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  setBrowserSearchHook(null);
  disconnectAll(PORT);
  chrome?.kill();
  server?.closeAllConnections?.();
  server?.close();
});

describe.skipIf(!CHROME_AVAILABLE)("a call reads the tab it chose", () => {
  it("browser_navigate with no tabId keeps reading the tab it navigated when another comes to the front", async () => {
    const pending = browserNavigateHandler({ url: `${base}/hang-img`, port: PORT, waitForLoad: true, loadTimeoutMs: 3000 } as never);
    await sleep(800);
    const opened = await openTab(`${base}/other`);
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/activate/${opened}`);
      const r = parsePayload(await pending);
      expect(r.title).toBe("hang");
      expect(r.url).toBe(`${base}/hang-img`);
      expect(r.hints.warnings).toEqual(["NavigateTimeout"]);
    } finally {
      await closeTab(opened);
    }
  }, 30_000);

  it("browser_navigate on a tab that closes while it loads answers NavigateFailed, not a slow page", async () => {
    const tab = await openTab(`${base}/other`);
    const t = Date.now();
    const pending = browserNavigateHandler({ url: `${base}/hang-img`, tabId: tab, port: PORT, waitForLoad: true, loadTimeoutMs: 8000 } as never);
    await sleep(800);
    await closeTab(tab);
    const r = parsePayload(await pending);
    expect(r.code).toBe("NavigateFailed");
    expect(r.error).toMatch(/the tab closed while its page was loading/);
    expect(Date.now() - t).toBeLessThan(3000);
  }, 30_000);

  it("browser_navigate refuses a file: URL before it looks for a tab", async () => {
    const r = parsePayload(await browserNavigateHandler({ url: "file:///etc/hosts", port: 9393, waitForLoad: true, loadTimeoutMs: 1000 } as never));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only accepts http:\/\/ and https:\/\/ URLs/);
  });

  it("wait_until(url_matches) with a tabId that names no tab answers InvalidArgs at once", async () => {
    const t = Date.now();
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/x", tabId: "NO-SUCH-TAB", port: PORT }, timeoutMs: 2000, intervalMs: 200,
    } as never));
    expect(r.code).toBe("InvalidArgs");
    expect(r.error).toMatch(new RegExp(`target\\.tabId "NO-SUCH-TAB" names no open tab on port ${PORT}`));
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("wait_until(element_matches) with a tabId that names no tab answers InvalidArgs at once, by text and by role", async () => {
    for (const target of [{ by: "text", pattern: "Save" }, { by: "role", pattern: "button" }]) {
      const t = Date.now();
      const r = parsePayload(await waitUntilHandler({
        condition: "element_matches", target: { ...target, tabId: "NO-SUCH-TAB", port: PORT }, timeoutMs: 2000, intervalMs: 200,
      } as never));
      expect(r.code, target.by).toBe("InvalidArgs");
      expect(r.error).toMatch(/target\.tabId "NO-SUCH-TAB" names no open tab/);
      expect(Date.now() - t).toBeLessThan(1000);
    }
  });

  it("a tab that was there and closes during the wait is waited past, not called a wrong argument", async () => {
    const tab = await openTab(`${base}/other`);
    setTimeout(() => { void closeTab(tab); }, 500);
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/never-here", tabId: tab, port: PORT }, timeoutMs: 1500, intervalMs: 100,
    } as never));
    expect(r.code).toBe("WaitTimeout");
    expect(r.context.lastLook.error).toBe("the tab closed during the wait");
  }, 30_000);

  it("a tabId that names an open tab still waits as before", async () => {
    const tab = await openTab(`${base}/other`);
    try {
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/never-here", tabId: tab, port: PORT }, timeoutMs: 600, intervalMs: 100,
    } as never));
    expect(r.code).toBe("WaitTimeout");
    expect(r.context).not.toHaveProperty("lastLook");
    } finally {
      await closeTab(tab);
    }
  });
});
