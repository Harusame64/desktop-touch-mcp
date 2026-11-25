/**
 * internal #423, the last two places a call could read another tab than the one it started on.
 * - The smart scroll's Chrome path resolved the default page tab again for each step.
 * - With lensId and no tabId, the guards checked the lens's tab while the call ran on the default tab.
 *   MEASURED on main (mac, headless Chrome): with the lens bound to a tab behind the front one,
 *   browser_eval({lensId, expression:"document.title"}) answered "front".
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const PORT = 9250;
// Lenses bind on the configured port; this suite's Chrome is that port.
vi.mock("../../src/utils/desktop-config.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/desktop-config.js")>()),
  getCdpPort: () => 9250,
}));

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll, listTabs } from "../../src/engine/cdp-bridge.js";
import { browserEvalJsHandler, browserNavigateHandler } from "../../src/tools/browser.js";
import { smartScrollHandler } from "../../src/tools/smart-scroll.js";
import * as registry from "../../src/engine/perception/registry.js";
import { parsePayload } from "./helpers/wait.js";

const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;
let server: Server;
let base = "";
let prevAutoGuard: string | undefined;
const opened: string[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function openTab(path: string, front = true): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(base + path)}`, { method: "PUT" });
  const id = ((await res.json()) as { id: string }).id;
  opened.push(id);
  if (front) await fetch(`http://127.0.0.1:${PORT}/json/activate/${id}`);
  return id;
}

async function untilLoaded(tab: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", tab, PORT) === "complete") return; } catch { /* not yet */ }
    await sleep(200);
  }
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
  process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const name = (req.url ?? "/").slice(1);
    if (name === "list") {
      const rows = Array.from({ length: 200 }, (_, i) => `<div id="row-${i}" style="height:40px">row ${i}</div>`).join("");
      res.end(`<title>list</title><div id="box" style="height:300px;overflow:auto">${rows}</div>`);
    } else {
      res.end(`<title>${name}</title><p>${name}</p>`);
    }
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

afterEach(async () => {
  registry.__resetForTests();
  for (const id of opened.splice(0)) await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`).catch(() => undefined);
});

afterAll(() => {
  if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
  else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  disconnectAll(PORT);
  chrome?.kill();
  server?.closeAllConnections?.();
  server?.close();
});

describe.skipIf(!CHROME_AVAILABLE)("a scroll and a lens keep to one tab", () => {
  it("the smart scroll scrolls the tab it walked, when another tab comes to the front mid-call", async () => {
    const list = await openTab("/list");
    await untilLoaded(list);
    // Hold the list tab's thread for 2 s from now, so the scroll's first step waits on it, and bring another
    // tab forward while it is held: the later steps come after the switch.
    await evaluateInTab(`setTimeout(() => { const t = Date.now(); while (Date.now() - t < 2000); }, 0); 1`, list, PORT);
    const switching = (async () => { await sleep(900); await openTab("/elsewhere"); })();
    const r = parsePayload(await smartScrollHandler({
      target: "#row-150", port: PORT, strategy: "cdp", direction: "into-view", inline: "center",
      maxDepth: 10, retryCount: 1, verifyWithHash: false, expandHidden: false,
    } as never));
    await switching;
    expect(r.ok).toBe(true);
    expect(await evaluateInTab("document.querySelector('#box').scrollTop", list, PORT)).toBeGreaterThan(0);
  }, 30_000);

  it("browser_eval with lensId and no tabId runs in the lens's tab, not the front one", async () => {
    const lensed = await openTab("/lensed");
    await untilLoaded(lensed);
    const { lensId } = await registry.registerLensAsync({
      name: "t", target: { kind: "browserTab", match: { urlIncludes: "/lensed" } }, maintain: [], guards: [],
    } as never);
    expect(registry.getLens(lensId)!.binding.hwnd).toBe(lensed);
    const front = await openTab("/front");
    await untilLoaded(front);
    const text = (await browserEvalJsHandler({ expression: "document.title", port: PORT, includeContext: false, lensId } as never))
      .content.find((b) => b.type === "text")!.text!;
    expect(text).toMatch(/^lensed/);
  }, 30_000);

  it("browser_navigate with lensId and no tabId navigates the lens's tab", async () => {
    const lensed = await openTab("/lensed");
    await untilLoaded(lensed);
    const { lensId } = await registry.registerLensAsync({
      name: "t", target: { kind: "browserTab", match: { urlIncludes: "/lensed" } }, maintain: [], guards: [],
    } as never);
    const front = await openTab("/front");
    await untilLoaded(front);
    await browserNavigateHandler({ url: `${base}/lensed-next`, port: PORT, waitForLoad: true, loadTimeoutMs: 5000, lensId } as never);
    const tabs = await listTabs(PORT);
    expect(tabs.find((t) => t.id === lensed)!.url).toBe(`${base}/lensed-next`);
    expect(tabs.find((t) => t.id === front)!.url).toBe(`${base}/front`);
  }, 30_000);
});
