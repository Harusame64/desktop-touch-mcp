/**
 * wait_until(element_matches) through the hook browser.ts registers. The hook used to turn every
 * browser_search failure into "no results", so the wait polled to its timeout and answered
 * WaitTimeout. MEASURED on main (mac): a port with no browser answered WaitTimeout after 1993 ms of
 * timeoutMs 2000, where browser_search itself answered BrowserNotConnected in 14 ms.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { registerBrowserTools } from "../../src/tools/browser.js";
import { waitUntilHandler, setBrowserSearchHook } from "../../src/tools/wait-until.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9247;
/** No listener: checked in beforeAll. */
const CLOSED_PORT = 9392;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  // The real hook, as the server wires it.
  const server = new Proxy({}, { get: () => () => undefined });
  registerBrowserTools(server as never);
  const html = `<main id="m"><button>Save</button></main>`;
  chrome = await launchChrome(PORT, true, `data:text/html,${encodeURIComponent(html)}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* not ready */ }
    await sleep(300);
  }
  const open = await fetch(`http://127.0.0.1:${CLOSED_PORT}/json/version`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (open) throw new Error(`port ${CLOSED_PORT} has a listener; this suite needs it closed`);
}, 20_000);

afterAll(() => {
  setBrowserSearchHook(null);
  disconnectAll(PORT);
  chrome?.kill();
});

async function wait(target: Record<string, unknown>, timeoutMs = 2000): Promise<{ r: any; wall: number }> {
  const t = Date.now();
  const r = parsePayload(await waitUntilHandler({ condition: "element_matches", target, timeoutMs, intervalMs: 200 } as never));
  return { r, wall: Date.now() - t };
}

describe.skipIf(!CHROME_AVAILABLE)("wait_until(element_matches) passes browser_search's failures up", () => {
  it("a port with no browser answers BrowserNotConnected at once", async () => {
    const { r, wall } = await wait({ by: "text", pattern: "Save", port: CLOSED_PORT });
    expect(r.code).toBe("BrowserNotConnected");
    expect(wall).toBeLessThan(1000);
    expect(r.error).not.toContain("BrowserNotConnected: BrowserNotConnected:");
  });

  it("a regex that does not compile is answered at once, not polled", async () => {
    const { r, wall } = await wait({ by: "regex", pattern: "([unclosed", port: PORT });
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe("WaitTimeout");
    expect(r.error).toMatch(/not a valid regular expression/);
    expect(wall).toBeLessThan(1000);
  });

  it("a scope that matches nothing is waited past and named on the timeout", async () => {
    const { r } = await wait({ by: "text", pattern: "Save", scope: "#not-yet", port: PORT }, 800);
    expect(r.code).toBe("WaitTimeout");
    expect(r.context.lastLook.error).toMatch(/^ScopeNotFound:/);
  });

  it("a search that finds nothing times out with no lastLook", async () => {
    const { r } = await wait({ by: "text", pattern: "Delete", port: PORT }, 800);
    expect(r.code).toBe("WaitTimeout");
    expect(r.context).not.toHaveProperty("lastLook");
  });

  it("a search that finds the element answers ok", async () => {
    const { r } = await wait({ by: "text", pattern: "Save", port: PORT });
    expect(r.ok).toBe(true);
    expect(r.observed.text).toContain("Save");
  });
});
