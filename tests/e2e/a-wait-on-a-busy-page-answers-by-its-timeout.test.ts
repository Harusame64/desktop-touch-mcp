/**
 * wait_until(url_matches) against a page whose script holds its thread: Runtime.evaluate does not
 * answer until the script lets go. MEASURED on main (mac, headless Chrome): timeoutMs 3000 answered
 * at 15004 ms, as BrowserNotConnected ("CDP timeout: Runtime.evaluate did not respond within
 * 15000ms") against a live connection.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { waitUntilHandler } from "../../src/tools/wait-until.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9243;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Hold the page's thread for `ms`, starting shortly after this call returns. */
async function holdThePage(ms: number): Promise<void> {
  await evaluateInTab(`setTimeout(() => { const t = Date.now(); while (Date.now() - t < ${ms}); }, 200); 1`, null, PORT);
  await sleep(500);
}

/** Wait until the page answers again, so one cell's hold does not run into the next. */
async function untilThePageAnswers(): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("1", null, PORT) === 1) return; } catch { /* still held */ }
    await sleep(300);
  }
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(PORT, true, "data:text/html,<p>busy</p>");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* not ready */ }
    await sleep(300);
  }
}, 20_000);

afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

describe.skipIf(!CHROME_AVAILABLE)("a wait on a busy page answers by its timeoutMs", () => {
  it("answers WaitTimeout at the deadline and says the last look had not answered", async () => {
    await holdThePage(20_000);
    const t = Date.now();
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/never", port: PORT }, timeoutMs: 3000, intervalMs: 200,
    }));
    const wall = Date.now() - t;
    expect(r.code).toBe("WaitTimeout");
    expect(wall).toBeLessThan(4000);
    expect(r.context.lastPoll.answered).toBe(false);
    expect(r.suggest[0]).toMatch(/^The last look had not answered/);
    await untilThePageAnswers();
  }, 60_000);

  it("a timeoutMs past the CDP call's own 15 s is still WaitTimeout, not BrowserNotConnected", async () => {
    await holdThePage(30_000);
    const t = Date.now();
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "/never", port: PORT }, timeoutMs: 17_000, intervalMs: 200,
    }));
    const wall = Date.now() - t;
    expect(r.code).toBe("WaitTimeout");
    expect(wall).toBeGreaterThanOrEqual(16_900);
    expect(wall).toBeLessThan(18_500);
    await untilThePageAnswers();
  }, 90_000);

  it("the page let go before the deadline: the wait sees the URL", async () => {
    await evaluateInTab(`history.replaceState(null, "", "#start"); 1`, null, PORT);
    await holdThePage(1500);
    setTimeout(() => { void evaluateInTab(`history.replaceState(null, "", "#arrived"); 1`, null, PORT).catch(() => undefined); }, 100);
    const r = parsePayload(await waitUntilHandler({
      condition: "url_matches", target: { pattern: "#arrived", port: PORT }, timeoutMs: 6000, intervalMs: 200,
    }));
    expect(r.ok).toBe(true);
    expect(r.observed.url).toMatch(/#arrived$/);
  }, 30_000);
});
