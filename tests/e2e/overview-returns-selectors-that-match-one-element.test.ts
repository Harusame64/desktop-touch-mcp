/**
 * internal #420 — browser_overview returns, for each element, a selector that matches that element alone, as
 * browser_search does since #1011. Its own copy had returned an id the page repeats, a radio group's shared name, a
 * link path other links share and a two-level path, and browser_click pressed the first match.
 *
 * Each cell checks that every selector matches one element, and that the element is the one listed: its text is the
 * item's text.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserGetInteractiveHandler, browserGetFormHandler } from "../../src/tools/browser.js";

const PORT = 9241;
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}</style></head><body>${body}</body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, null, PORT);
  await sleep(150);
}
type Item = { type: string; text: string; selector: string };
async function overview(maxResults = 200): Promise<Item[]> {
  const r = await browserGetInteractiveHandler({ types: ["all"], inViewportOnly: false, maxResults, port: PORT, includeContext: false });
  const t = (r.content[0] as { text: string }).text;
  return JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1)) as Item[];
}
// What each selector matches: how many elements, and the text or value of the first.
async function reads(items: Item[]): Promise<Array<{ n: number; text: string }>> {
  return (await evaluateInTab(
    `(${JSON.stringify(items.map((i) => i.selector))}).map(function(s){var l=document.querySelectorAll(s);var e=l[0];return {n:l.length,text:e?(e.getAttribute('aria-label')||e.getAttribute('value')||e.textContent||'').trim():''}})`,
    null, PORT,
  )) as Array<{ n: number; text: string }>;
}
async function expectEachAlone(items: Item[], texts: string[]): Promise<void> {
  expect(items.map((i) => i.text).sort()).toEqual([...texts].sort());
  const r = await reads(items);
  expect(r.map((x) => x.n)).toEqual(items.map(() => 1));
  expect(r.map((x) => x.text)).toEqual(items.map((i) => i.text));
}

describe.skipIf(!CHROME)("browser_overview returns selectors that match one element (internal #420)", () => {
  it("keeps an id the page has once, and leaves an id the page repeats", async () => {
    await page(`<button id="save">Save</button><span><button id="dup">One</button></span><span><button id="dup">Two</button></span>`);
    const items = await overview();
    expect(items.find((i) => i.text === "Save")?.selector).toBe("#save");
    await expectEachAlone(items, ["Save", "One", "Two"]);
  });

  it("does not hand back a radio group's shared name", async () => {
    await page(`<label><input type="radio" name="size" value="S" aria-label="S">S</label><label><input type="radio" name="size" value="M" aria-label="M">M</label><input name="email" aria-label="Email">`);
    const items = await overview();
    expect(items.find((i) => i.text === "Email")?.selector).toBe('input[name="email"]');
    await expectEachAlone(items, ["S", "M", "Email"]);
  });

  it("keeps a link's path only when no other link has it", async () => {
    // Absolute: a relative href has no base on the about:blank page the cells write into.
    await page(`<a href="https://example.org/wiki/Tokyo">Tokyo</a><a href="https://example.org/wiki/Kyoto">Kyoto</a><a href="https://example.org/wiki/Kyoto">Kyoto again</a><a href="https://example.org/wiki/Kyoto_Station">Station</a>`);
    const items = await overview();
    expect(items.find((i) => i.text === "Tokyo")?.selector).toBe('a[href*="/wiki/Tokyo"]');
    await expectEachAlone(items, ["Tokyo", "Kyoto", "Kyoto again", "Station"]);
  });

  it("does not hand a link a path another link holds: an in-page or relative href resolves to the page's own path (/code-review on #1012)", async () => {
    // el.href resolves against the page, so "#History" reads as /wiki/Tokyo#History, while the selector matches the
    // attribute: a[href*="/wiki/Tokyo"] matched the permalink alone, and a click on History pressed it.
    await page(`<base href="https://example.org/wiki/Tokyo"><a href="#History">History</a><a href="/wiki/Tokyo">Tokyo</a>`);
    await expectEachAlone(await overview(), ["History", "Tokyo"]);
    // A relative link reads the same way: "Kyoto" resolves to /wiki/Kyoto, which only the absolute link holds.
    await page(`<base href="https://example.org/wiki/Tokyo"><a href="Kyoto">Kyoto</a><a href="https://example.org/wiki/Kyoto">Kyoto too</a>`);
    await expectEachAlone(await overview(), ["Kyoto", "Kyoto too"]);
  });

  it("lengthens a path of positions past two levels when blocks are built alike", async () => {
    const card = (t: string) => `<div><div><div><button>${t}</button></div></div></div>`;
    await page(`<section>${card("Buy")}${card("Buy later")}</section><section>${card("Sell")}${card("Sell later")}</section>`);
    await expectEachAlone(await overview(), ["Buy", "Buy later", "Sell", "Sell later"]);
  });

  it("climbs to <body> for blocks built alike deeper than eight levels", async () => {
    const deep = (n: number, inner: string): string => (n === 0 ? inner : `<div>${deep(n - 1, inner)}</div>`);
    await page(`<div>${deep(11, `<a href="#t">Tile</a>`)}</div><div>${deep(11, `<a href="#t">Tile 2</a>`)}</div>`);
    await expectEachAlone(await overview(), ["Tile", "Tile 2"]);
  });

  it("anchors a path that climbs to the top: a widget a script appends to <html>, outside <body> (/code-review on #1012)", async () => {
    // Built alike under <body> and under <html>: div:nth-child(3) > button:nth-child(1) matches both.
    await page(`<div></div><div></div><div><button>In body</button></div>`);
    await evaluateInTab(`(function(){var h=document.documentElement;var d=document.createElement('div');d.innerHTML='<button>On html</button>';h.appendChild(d);return h.children.length})()`, null, PORT);
    await expectEachAlone(await overview(), ["In body", "On html"]);
  });

  it("keeps each selector to one element past the time budget, and still uses an id the page has once (/code-review on #1012)", async () => {
    // The clock answers 0 once, for the deadline the script sets, and an hour later from then on: every element is
    // past the budget.
    const card = (t: string) => `<div><div><button>${t}</button></div></div>`;
    await page(`<button id="save">Save</button><span><button id="dup">One</button></span><span><button id="dup">Two</button></span>${card("A")}${card("B")}`);
    await evaluateInTab(`(function(){var n=performance.now.bind(performance),c=0;window.__realNow=n;performance.now=function(){return c++?n()+3600000:n()};return true})()`, null, PORT);
    try {
      const items = await overview();
      expect(items.find((i) => i.text === "Save")?.selector).toBe("#save");
      expect(items.find((i) => i.text === "A")?.selector).toMatch(/^:root > body:nth-child\(2\) > /);
      await expectEachAlone(items, ["Save", "One", "Two", "A", "B"]);
    } finally {
      await evaluateInTab(`(function(){performance.now=window.__realNow;return true})()`, null, PORT);
    }
  });

  it("lists an element's text without a script inside it (internal #420, after #1015)", async () => {
    await page(`<button id="buy">Buy<script>window.track=1</script> now</button>`);
    expect((await overview()).find((i) => i.selector === "#buy")?.text).toBe("Buy now");
  });

  it("still lists a page whose form has a control named \"matches\" (/code-review on #1016)", async () => {
    // form.matches is that input, not the method: the text walker called it and the whole script threw.
    await page(`<button id="open">Open <form><input name="matches" value="x"><span>inside</span></form></button>`);
    expect((await overview()).find((i) => i.selector === "#open")?.text).toBe("Open inside");
  });

  it("reports a masked button with only a script inside as having no caption (/code-review on #1016)", async () => {
    await page(`<form id="f"><button id="m" style="-webkit-text-security:disc"><script>window.t=1</script></button><button id="n" style="-webkit-text-security:disc">Pay</button></form>`);
    const r = await browserGetFormHandler({ selector: "#f", includeHidden: false, maxResults: 50, port: PORT, includeContext: false });
    const t = (r.content[0] as { text: string }).text;
    const fields = (JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)) as { fields: Array<{ id: string; hasValue?: boolean }> }).fields;
    expect(fields.map((f) => [f.id, f.hasValue])).toEqual([["m", false], ["n", true]]);
  });

  it("names 200 alike buttons in a list with selectors that match one each", async () => {
    await page(`<ul>${Array.from({ length: 200 }, (_, i) => `<li><span><button data-testid="row">Row ${i}</button></span></li>`).join("")}</ul>`);
    const items = await overview();
    expect(items).toHaveLength(200);
    expect(new Set(items.map((i) => i.selector)).size).toBe(200);
    expect((await reads(items)).every((x) => x.n === 1)).toBe(true);
  });
});
