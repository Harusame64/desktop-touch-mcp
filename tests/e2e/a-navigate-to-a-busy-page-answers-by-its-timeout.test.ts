/**
 * browser_navigate with waitForLoad to a page whose inline script holds its thread. The readyState
 * wait ends at loadTimeoutMs (pollUntil, #1041), but the call then asked the page for its title and
 * waited on CDP's own 15 s. MEASURED on main (mac, headless Chrome): 18229 ms against loadTimeoutMs
 * 3000, with title "" (the page never answered).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserNavigateHandler } from "../../src/tools/browser.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9246;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;
let server: Server;
let base = "";
let prevAutoGuard: string | undefined;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function untilThePageAnswers(): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("1", null, PORT) === 1) return; } catch { /* still held */ }
    await sleep(300);
  }
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  prevAutoGuard = process.env.DESKTOP_TOUCH_AUTO_GUARD;
  process.env.DESKTOP_TOUCH_AUTO_GUARD = "0";
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/busy")) {
      res.end(`<title>busy</title><script>const t = Date.now(); while (Date.now() - t < 20000);</script><p>x</p>`);
    } else if (req.url?.startsWith("/hang-img")) {
      res.end(`<title>hang</title><p>x</p><img src="/never">`);
    } else if (req.url?.startsWith("/never")) {
      // never answered: the image keeps the load from completing
    } else {
      res.end(`<title>plain</title><p>plain</p>`);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await launchChrome(PORT, true, `${base}/plain`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* not ready */ }
    await sleep(300);
  }
}, 20_000);

afterAll(() => {
  if (prevAutoGuard === undefined) delete process.env.DESKTOP_TOUCH_AUTO_GUARD;
  else process.env.DESKTOP_TOUCH_AUTO_GUARD = prevAutoGuard;
  disconnectAll(PORT);
  chrome?.kill();
  server?.closeAllConnections?.();
  server?.close();
});

async function navigate(path: string, loadTimeoutMs: number): Promise<{ r: any; wall: number }> {
  const t = Date.now();
  const r = parsePayload(await browserNavigateHandler({ url: `${base}${path}`, port: PORT, waitForLoad: true, loadTimeoutMs } as any));
  return { r, wall: Date.now() - t };
}

describe.skipIf(!CHROME_AVAILABLE)("browser_navigate to a busy page answers by its loadTimeoutMs", () => {
  it("a page whose script holds its thread: NavigateTimeout and PageNotAnswering at about loadTimeoutMs, title from the tab list", async () => {
    const { r, wall } = await navigate("/busy", 3000);
    expect(wall).toBeLessThan(4500);
    expect(r.ok).toBe(true);
    expect(r.hints.warnings).toEqual(["NavigateTimeout", "PageNotAnswering"]);
    expect(r.url).toBe(`${base}/busy`);
    expect(r.title).toBe("busy");
    await untilThePageAnswers();
  }, 60_000);

  it("a page that answers but never completes: NavigateTimeout only, its own readyState", async () => {
    const { r, wall } = await navigate("/hang-img", 2000);
    expect(wall).toBeLessThan(3500);
    expect(r.hints.warnings).toEqual(["NavigateTimeout"]);
    expect(r.readyState).toBe("interactive");
    expect(r.title).toBe("hang");
  }, 30_000);

  it("a page that loads: no warnings", async () => {
    const { r } = await navigate("/plain", 5000);
    expect(r.readyState).toBe("complete");
    expect(r.title).toBe("plain");
    expect(r).not.toHaveProperty("hints");
  }, 30_000);
});
