/**
 * internal #421 (PR-C) — browser_click's by-axis road reads where a person would press when its single match is
 * covered in the page, as the selector road does (#1005): the resolved element is marked, the landing read finds a
 * point or names what is in front, and the mark is removed. Before this, a covered match stopped as
 * BrowserNoActionableTarget ("receivesEvents=false") without saying what covered it.
 *
 * Only what answers before an OS press runs here (mac); the presses are measured on Windows (win2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserClickElementHandler } from "../../src/tools/browser.js";
import { resolveBrowserActionTarget, buildTagResolvedJs, buildUntagJs } from "../../src/tools/browser-resolver.js";

const PORT = 9236;
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
async function click(args: Record<string, unknown>): Promise<{ code?: string; error?: string; context?: Record<string, unknown>; ok?: boolean }> {
  const r = await browserClickElementHandler({ ...args, port: PORT } as never);
  const text = (r.content[0] as { text: string }).text;
  return JSON.parse(text.slice(text.indexOf("{"))) as never;
}
const counts = async (): Promise<Record<string, number>> => (await evaluateInTab("window.__n", null, PORT)) as Record<string, number>;
const marks = async (): Promise<number> => (await evaluateInTab("document.querySelectorAll('[data-dtm-press]').length", null, PORT)) as number;

describe.skipIf(!CHROME)("browser_click by-axis: a covered match is read like the selector road (internal #421, PR-C)", () => {
  it("refuses a button under a cookie banner as BrowserPointCovered / page, naming the banner and what it offers", async () => {
    await page(`<button data-n="low" style="position:fixed;left:300px;bottom:40px">Checkout</button>
      <div role="region" aria-label="Cookies" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee;z-index:5"><button data-n="accept">Accept all</button><button data-n="reject">Reject</button></div>`);
    const r = await click({ by: "text", pattern: "Checkout" });
    expect(r.code).toBe("BrowserPointCovered");
    expect(r.context).toMatchObject({ by: "text", pattern: "Checkout", coveredBy: "page", offers: ["Accept all", "Reject"] });
    expect(r.error).toContain('The element found by text:"Checkout" is covered in the page');
    expect(r.error).not.toContain("data-dtm-press");
    expect(await counts()).toEqual({});
    expect(await marks()).toBe(0);
  });

  it("refuses a button behind an aria-modal dialog as BrowserModalBlocking with what the dialog offers", async () => {
    await page(`<button data-n="behind" style="position:absolute;left:300px;top:300px">Archive</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10"></div>
      <div role="dialog" aria-modal="true" aria-label="Delete file" style="position:fixed;left:150px;top:150px;width:300px;height:120px;background:#fff;z-index:11"><button>Delete</button><button>Cancel</button></div>`);
    const r = await click({ by: "text", pattern: "Archive" });
    expect(r.code).toBe("BrowserModalBlocking");
    expect(r.context).toMatchObject({ by: "text", pattern: "Archive", blockingElement: { name: "Delete file", role: "dialog" }, offers: ["Delete", "Cancel"] });
    expect(await marks()).toBe(0);
  });

  it("still stops two matches as ambiguous (control: the covered road needs a single match)", async () => {
    await page(`<button style="position:absolute;left:100px;top:100px">Save</button><button style="position:absolute;left:300px;top:100px">Save</button>`);
    const r = await click({ by: "text", pattern: "Save" });
    expect(r.code).toBe("BrowserAmbiguousTarget");
  });

  it("still stops a covered match that is off the screen as before (control: no scrolling hunt)", async () => {
    await page(`<button data-n="far" style="position:absolute;left:300px;top:1700px">Faraway</button><div style="position:absolute;left:0;top:1650px;width:800px;height:120px;background:#eee;z-index:5">Cover</div>`);
    const r = await click({ by: "text", pattern: "Faraway" });
    expect(r.code).toBe("BrowserNoActionableTarget");
    expect(await marks()).toBe(0);
  });

  it("marks the resolved clickable (after the climb) and unmarks it", async () => {
    await page(`<div role="button" id="card" style="position:absolute;left:300px;top:300px;padding:8px"><span>Open card</span></div>`);
    const o = await resolveBrowserActionTarget({ by: "text", pattern: "Open card", action: "click", port: PORT, tabId: null });
    expect(o.kind).toBe("resolved");
    if (o.kind !== "resolved") return;
    const ok = await evaluateInTab(buildTagResolvedJs({ by: "text", pattern: "Open card", caseSensitive: false }, o.index, o.climbDepth, o.matched, "n1"), null, PORT);
    expect(ok).toEqual({ ok: true });
    expect(await evaluateInTab("document.querySelector('[data-dtm-press=\"n1\"]').id", null, PORT)).toBe("card");
    await evaluateInTab(buildUntagJs("n1"), null, PORT);
    expect(await marks()).toBe(0);
  });

  it("does not mark anything when the page changed since the gather (identity gate)", async () => {
    await page(`<button id="a" style="position:absolute;left:300px;top:300px">Proceed</button>`);
    const o = await resolveBrowserActionTarget({ by: "text", pattern: "Proceed", action: "click", port: PORT, tabId: null });
    if (o.kind !== "resolved") throw new Error(o.kind);
    await evaluateInTab("var b=document.createElement('button');b.textContent='Proceed';document.body.prepend(b);true", null, PORT);
    const ok = await evaluateInTab(buildTagResolvedJs({ by: "text", pattern: "Proceed", caseSensitive: false }, o.index, o.climbDepth, o.matched, "n2"), null, PORT);
    expect(ok).toMatchObject({ ok: false, error: "identity_changed" });
    expect(await marks()).toBe(0);
  });

  it("removes the mark when the press cannot be sent after a landing read (badge over the centre)", async () => {
    await page(`<button data-n="b" style="position:absolute;left:300px;top:300px;width:160px;height:40px">Notifications</button><span style="position:absolute;left:360px;top:300px;width:40px;height:40px;background:red;z-index:5">9</span>`);
    const r = await click({ by: "text", pattern: "Notifications" });
    if (r.ok === true) return; // a machine that can press
    expect(r.code).not.toBe("BrowserNoActionableTarget");
    expect(r.code).not.toBe("BrowserPointCovered");
    expect(await marks()).toBe(0);
  });

  it("names a modal only the old rules find as BrowserModalBlocking when nothing reaches the element, and decides on facts only (internal #421)", async () => {
    // No aria-modal: a dialog covering the whole button, with a transparent full-page layer (the old rules' backdrop),
    // scroll locked and focus inside. The landing read finds no point and refuses; the old rules choose the words.
    await page(`<button data-n="under" style="position:absolute;left:200px;top:300px;width:200px;height:40px">Archive all</button>
      <div role="dialog" aria-label="Settings" style="position:fixed;left:20px;top:20px;right:20px;bottom:20px;background:#fff;border:1px solid #000;z-index:10"><button id="okb">OK</button></div>
      <div style="position:fixed;inset:0;z-index:9;pointer-events:none"></div>`);
    await evaluateInTab("document.body.style.overflow='hidden';document.getElementById('okb').focus();true", null, PORT);
    const r = await click({ by: "text", pattern: "Archive all" });
    expect(r.code).toBe("BrowserModalBlocking");
    expect(r.context).toMatchObject({ blockingElement: { name: "Settings", role: "dialog" }, signals: { ariaModal: false }, offers: ["OK"] });
    expect(await marks()).toBe(0);
    expect(await counts()).toEqual({});
  });

  it("does not refuse a checkbox inside a dialog the old rules call modal: its own label takes the press (/code-review round 2 on #1006)", async () => {
    await page(`<div role="dialog" aria-label="Prefs" style="position:fixed;left:40px;top:40px;width:500px;height:400px;background:#fff;z-index:10"><input type="checkbox" id="cb" style="position:absolute;left:20px;top:20px;margin:0"><label for="cb" style="position:absolute;left:20px;top:20px;padding:0 0 0 30px;width:200px;height:20px">Remember me</label><button id="okb">OK</button></div>
      <div style="position:fixed;inset:0;z-index:9;pointer-events:none"></div>`);
    await evaluateInTab("document.body.style.overflow='hidden';document.getElementById('okb').focus();true", null, PORT);
    const r = await click({ by: "role", pattern: "checkbox" });
    expect(r.code).not.toBe("BrowserModalBlocking");
    expect(await marks()).toBe(0);
  });

});
