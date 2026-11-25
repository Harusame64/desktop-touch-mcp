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
import { evaluateInTab, disconnectAll, listTabs } from "../../src/engine/cdp-bridge.js";
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
    const opened = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`${base}/other`)}`, { method: "PUT" })).json() as { id: string };
    await fetch(`http://127.0.0.1:${PORT}/json/activate/${opened.id}`);
    const r = parsePayload(await pending);
    expect(r.title).toBe("hang");
    expect(r.url).toBe(`${base}/hang-img`);
    expect(r.hints.warnings).toEqual(["NavigateTimeout"]);
    await fetch(`http://127.0.0.1:${PORT}/json/close/${opened.id}`);
  }, 30_000);

  it("wait_until(url_matches) with a tabId that names no tab answers InvalidArgs at once", async () => {
    const t = Date.now();
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/x", tabId: "NO-SUCH-TAB", port: PORT }, timeoutMs: 2000, intervalMs: 200,
    } as never));
    expect(r.code).toBe("InvalidArgs");
    expect(r.error).toMatch(/target\.tabId "NO-SUCH-TAB" names no open tab/);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("wait_until(element_matches) with a tabId that names no tab answers InvalidArgs at once", async () => {
    const t = Date.now();
    const r = parsePayload(await waitUntilHandler({
      condition: "element_matches", target: { by: "text", pattern: "Save", tabId: "NO-SUCH-TAB", port: PORT }, timeoutMs: 2000, intervalMs: 200,
    } as never));
    expect(r.code).toBe("InvalidArgs");
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("a tabId that names an open tab still waits as before", async () => {
    const tab = (await listTabs(PORT)).find((x) => x.type === "page")!;
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/never-here", tabId: tab.id, port: PORT }, timeoutMs: 600, intervalMs: 100,
    } as never));
    expect(r.code).toBe("WaitTimeout");
  });
});
