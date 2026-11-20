/**
 * internal #421 — browser_click's selector road reads where a person would press, as desktop_act does (#1004), and
 * refuses before any OS press when nothing reaches the element: a dialog that blocks the page is
 * BrowserModalBlocking (naming it and what it offers), anything else in front is BrowserPointCovered / coveredBy
 * "page". Before this, a cover that was not a modal was clicked through: the OS press landed on the cover.
 *
 * Only the refusals run here: they answer before the browser window is focused or the cursor moves, so they hold on
 * any machine. The presses themselves are an OS click (Windows), measured on win2.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserClickElementHandler } from "../../src/tools/browser.js";

const PORT = 9235;
const CHROME = tryFindChrome() !== null;
let chrome: ChromeInstance;

beforeAll(async () => {
  if (!CHROME) return;
  chrome = await launchChrome(PORT, !process.env.HEADED, "about:blank");
}, 20_000);
afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

async function page(body: string): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;height:2000px;font:16px sans-serif}</style></head><body>${body}<script>window.__n={};document.addEventListener('click',function(e){var t=e.target.closest('[data-n]');if(t){window.__n[t.dataset.n]=(window.__n[t.dataset.n]||0)+1;}},true);</script></body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, null, PORT);
  await sleep(150);
}
async function click(selector: string): Promise<{ code?: string; error?: string; context?: Record<string, unknown>; ok?: boolean }> {
  const r = await browserClickElementHandler({ selector, port: PORT } as never);
  const text = (r.content[0] as { text: string }).text;
  return JSON.parse(text.slice(text.indexOf("{"))) as never;
}
const counts = async (): Promise<Record<string, number>> => (await evaluateInTab("window.__n", null, PORT)) as Record<string, number>;

const BEHIND = '<button id="behind" data-n="behind" style="position:absolute;left:300px;top:300px">Behind</button>';

describe.skipIf(!CHROME)("browser_click refuses what a person must deal with first, before any press (internal #421)", () => {
  it("refuses the page behind an aria-modal dialog as BrowserModalBlocking, naming it and its buttons", async () => {
    await page(`${BEHIND}<div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10"></div>
      <div role="dialog" aria-modal="true" aria-label="Delete file" style="position:fixed;left:150px;top:150px;width:300px;height:120px;background:#fff;z-index:11"><button data-n="ok">Delete</button><button data-n="cancel">Cancel</button></div>`);
    const r = await click("#behind");
    expect(r.code).toBe("BrowserModalBlocking");
    expect(r.context?.blockingElement).toEqual({ name: "Delete file", role: "dialog" });
    expect(r.context?.offers).toEqual(["Delete", "Cancel"]);
    expect(r.error).toContain("nothing was clicked");
    expect(await counts()).toEqual({});
  });

  it("still names a large dialog the page does not mark aria-modal as BrowserModalBlocking, as the old preflight did", async () => {
    // What the old preflight's rescue rule took for a modal: a backdrop, scroll locked, focus inside, over half the
    // page. Its rules now choose the words only; whether to press is decided by the landing read.
    await page(`${BEHIND}<div class="ui-widget-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:100"></div>
      <div role="dialog" aria-labelledby="t" style="position:fixed;left:5vw;top:5vh;width:90vw;height:90vh;z-index:101;background:#fff"><span id="t">Confirm delete</span><button id="okb">OK</button><button>Cancel</button></div>`);
    await evaluateInTab("document.body.style.overflow='hidden';document.getElementById('okb').focus();true", null, PORT);
    const r = await click("#behind");
    expect(r.code).toBe("BrowserModalBlocking");
    expect(r.context?.blockingElement).toMatchObject({ role: "dialog" });
    expect(await counts()).toEqual({});
  });

  it("refuses a button under a cookie banner as BrowserPointCovered / page, naming what the banner offers", async () => {
    // Fixed to the bottom with the button: no scroll takes the button out from under it.
    await page(`<button id="low" data-n="low" style="position:fixed;left:300px;bottom:40px">Low</button>
      <div id="cookie" role="region" aria-label="Cookies" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee;z-index:5"><p>We use cookies.</p><button data-n="accept">Accept all</button><button data-n="reject">Reject</button></div>`);
    const r = await click("#low");
    expect(r.code).toBe("BrowserPointCovered");
    expect(r.context?.coveredBy).toBe("page");
    expect(r.context?.offers).toEqual(["Accept all", "Reject"]);
    expect(String(r.context?.cover)).toContain("cookie");
    expect(r.error).toContain("retry browser_click");
    expect(await counts()).toEqual({});
  });

  it("refuses under an overlay that does not go away, after waiting, and says to wait", async () => {
    await page(`${BEHIND}<div style="position:fixed;inset:0;background:rgba(255,255,255,.6);z-index:5"></div>`);
    const t0 = Date.now();
    const r = await click("#behind");
    expect(Date.now() - t0).toBeGreaterThan(1500);
    expect(r.code).toBe("BrowserPointCovered");
    expect(r.error).toContain("empty overlay");
  });

  it("never puts a typed password into the refusal when a password field is the cover", async () => {
    await page(`${BEHIND}<input type="password" id="pw" aria-label="Password" style="position:absolute;left:280px;top:290px;width:200px;height:40px;z-index:5">`);
    await evaluateInTab("document.getElementById('pw').value='hunter2-secret'", null, PORT);
    const r = await click("#behind");
    expect(r.code).toBe("BrowserPointCovered");
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("refuses an element its own container takes the press for, saying so", async () => {
    await page(`<div id="wrap" style="position:absolute;left:300px;top:300px;padding:10px;background:#ddd"><button id="inert" style="pointer-events:none">Inert</button></div>`);
    const r = await click("#inert");
    expect(r.code).toBe("BrowserPointCovered");
    expect(r.error).toContain("does not take a press at its own point");
  });
});
