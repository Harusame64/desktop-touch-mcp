/**
 * internal #420 — browser_search by:'role' and by:'ariaLabel' read the browser's accessibility tree, as browser_click
 * does (#1008, #1010), so what a click finds by these words a search lists too. The DOM reading still runs beside the
 * tree and the two are merged: the tree adds, it takes nothing away (/code-review on this PR).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserSearchHandler } from "../../src/tools/browser.js";

const PORT = 9240;
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);margin:-1px;padding:0;border:0}</style></head><body>${body}</body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, null, PORT);
  await sleep(150);
}
type Hit = { selector: string; role?: string; confidence: number; matchedBy: string };
type Body = { ok?: boolean; code?: string; total?: number; returned?: number; truncated?: boolean; results?: Hit[] };
async function search(a: { by: "role" | "ariaLabel" | "text"; pattern: string; scope?: string; visibleOnly?: boolean; inViewportOnly?: boolean; maxResults?: number; offset?: number; caseSensitive?: boolean }): Promise<Body> {
  const r = await browserSearchHandler({
    maxResults: 50, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive: false, port: PORT, ...a,
  });
  return JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as Body;
}
const sels = (b: Body): string[] => (b.results ?? []).map((h) => h.selector).sort();
const marks = async (): Promise<number> => (await evaluateInTab("document.querySelectorAll('[data-dtm-ax]').length", null, PORT)) as number;

const SR = `<input type="checkbox" id="terms" class="sr"><label for="terms" style="position:absolute;left:100px;top:100px">Accept terms</label>`;
const SELECT2 = `<label for="fruit" style="position:absolute;left:100px;top:270px">Fruit</label><select id="fruit" class="sr" tabindex="-1" aria-hidden="true"><option>Apple</option><option>Banana</option></select>
  <span class="select2" style="position:absolute;left:100px;top:300px;width:240px"><span class="select2-selection" id="s2" role="combobox" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-labelledby="select2-fruit-container" style="display:block;height:28px;border:1px solid #aaa"><span id="select2-fruit-container" role="textbox" aria-readonly="true">Apple</span></span></span>`;

describe.skipIf(!CHROME)("browser_search by:'role' and by:'ariaLabel' read the accessibility tree (internal #420)", () => {
  it("finds an sr-only checkbox by the name its <label> gives it, with the role the browser computed", async () => {
    await page(SR);
    const b = await search({ by: "ariaLabel", pattern: "Accept terms" });
    expect(b.total).toBe(1);
    expect(b.results?.[0]).toMatchObject({ selector: "#terms", role: "checkbox", matchedBy: "ariaLabel" });
  });

  it("finds by role what the tag implies: a native checkbox and a div role=checkbox, a submit input as a button", async () => {
    await page(`<input type="checkbox" id="n"><div role="checkbox" id="d" tabindex="0" aria-checked="false">x</div><input type="submit" id="go" value="Go">`);
    expect(sels(await search({ by: "role", pattern: "checkbox" }))).toEqual(["#d", "#n"]);
    expect(sels(await search({ by: "role", pattern: "button" }))).toEqual(["#go"]);
  });

  it("finds Select2's combobox by the label of the select it hides, never the select (W12)", async () => {
    await page(SELECT2);
    expect(sels(await search({ by: "ariaLabel", pattern: "Fruit" }))).toEqual(["#s2"]);
  });

  it("returns a selector that matches the element alone: Select2 with no ids, a repeated id (win2 on #1011)", async () => {
    await page(`<div><label for="fr">Fruit</label><select id="fr" class="sr" tabindex="-1" aria-hidden="true"><option>Apple</option></select><span class="select2"><span class="select2-selection" role="combobox" tabindex="0" aria-haspopup="true" aria-labelledby="r1"><span id="r1" role="textbox" aria-readonly="true">Apple</span></span></span></div>
      <span><span id="dup" role="button" tabindex="0">One</span></span><span><span id="dup" role="button" tabindex="0">Two</span></span>`);
    const one = async (sel: string) => (await evaluateInTab(`document.querySelectorAll(${JSON.stringify(sel)}).length`, null, PORT)) as number;
    const w = await search({ by: "ariaLabel", pattern: "Fruit" });
    expect(w.total).toBe(1);
    expect(await one(w.results![0].selector)).toBe(1);
    expect(await evaluateInTab(`document.querySelector(${JSON.stringify(w.results![0].selector)}).className`, null, PORT)).toBe("select2-selection");
    const d = await search({ by: "role", pattern: "button" });
    expect(d.total).toBe(2);
    for (const h of d.results!) expect(await one(h.selector)).toBe(1);
  });

  it("finds a name given by aria-labelledby, which the attribute reading never saw", async () => {
    await page(`<span id="lb">Close dialog</span><div role="button" id="x" tabindex="0" aria-labelledby="lb">×</div>`);
    const b = await search({ by: "ariaLabel", pattern: "Close dialog" });
    expect(sels(b)).toContain("#x");
    expect(b.results?.find((h) => h.selector === "#x")?.confidence).toBe(0.95);
  });

  it("leaves no marks in the page: after results, after none, after a bad scope", async () => {
    await page(SR + `<button>Save</button>`);
    expect((await search({ by: "role", pattern: "button" })).total).toBe(1);
    expect(await marks()).toBe(0);
    expect((await search({ by: "ariaLabel", pattern: "Nothing like this" })).code).toBe("BrowserSearchNoResults");
    expect(await marks()).toBe(0);
    expect((await search({ by: "role", pattern: "button", scope: "#nope" })).code).toBe("ScopeNotFound");
    expect(await marks()).toBe(0);
  });

  it("keeps the DOM reading's answer when the tree finds nothing (a button under a misused aria-hidden, as before)", async () => {
    await page(`<div aria-hidden="true"><button id="c" aria-label="Close">×</button></div>`);
    expect(sels(await search({ by: "ariaLabel", pattern: "Close" }))).toEqual(["#c"]);
    expect(sels(await search({ by: "role", pattern: "button" }))).toEqual(["#c"]);
  });

  it("keeps what the DOM reading found beside the tree's matches: one filter or another, the same set (/code-review)", async () => {
    await page(`<div aria-hidden="true"><button id="c" aria-label="Close">×</button></div><button id="far" style="position:absolute;top:5000px">Close</button>`);
    expect(sels(await search({ by: "ariaLabel", pattern: "Close" }))).toEqual(["#c", "#far"]);
    expect(sels(await search({ by: "ariaLabel", pattern: "Close", inViewportOnly: true }))).toEqual(["#c"]);
    expect(await marks()).toBe(0);
  });

  it("reports the role the browser computed, not a role attribute it ignored (/code-review)", async () => {
    await page(`<button id="p" role="presentation">OK</button><div id="s" role="switch checkbox" tabindex="0" aria-checked="false">x</div>`);
    expect((await search({ by: "role", pattern: "button" })).results?.find((h) => h.selector === "#p")?.role).toBe("button");
    expect((await search({ by: "role", pattern: "switch" })).results?.find((h) => h.selector === "#s")?.role).toBe("switch");
  });

  it("counts every link past the marks' cap, as the DOM reading did (/code-review)", async () => {
    await page(Array.from({ length: 1100 }, (_, i) => `<a href="#${i}" id="l${i}">L${i}</a> `).join(""));
    const b = await search({ by: "role", pattern: "link", maxResults: 50, offset: 1050 });
    expect([b.total, b.returned, b.truncated]).toEqual([1100, 50, false]);
    expect(await marks()).toBe(0);
  });

  it("adds hidden elements with visibleOnly:false (the tree leaves them out), and not with visibleOnly:true", async () => {
    await page(`<button id="v" aria-label="Menu">≡</button><button id="h" aria-label="Menu" style="display:none">≡</button>`);
    expect(sels(await search({ by: "ariaLabel", pattern: "Menu" }))).toEqual(["#v"]);
    const all = await search({ by: "ariaLabel", pattern: "Menu", visibleOnly: false });
    expect(sels(all)).toEqual(["#h", "#v"]);
    expect(all.results?.[0].selector).toBe("#v");
  });

  it("pages through more than 200 matches, as the DOM reading did (control for the tree's cap)", async () => {
    await page(Array.from({ length: 260 }, (_, i) => `<button id="b${i}">B${i}</button>`).join(""));
    const b = await search({ by: "role", pattern: "button", maxResults: 10, offset: 250 });
    expect(b.total).toBe(260);
    expect(b.returned).toBe(10);
    expect(await marks()).toBe(0);
  });

  it("marks past 200 when the page asks for more: 300 native checkboxes only the tree calls checkboxes (/code-review)", async () => {
    await page(Array.from({ length: 300 }, (_, i) => `<input type="checkbox" id="c${i}">`).join(""));
    const b = await search({ by: "role", pattern: "checkbox", maxResults: 50, offset: 250 });
    expect([b.total, b.returned]).toEqual([300, 50]);
    expect(await marks()).toBe(0);
  });

  it("counts all 300 on the first page too, when the tree found more than it first marked (win2 on #1011)", async () => {
    await page(Array.from({ length: 300 }, (_, i) => `<input type="checkbox" id="c${i}">`).join(""));
    const b = await search({ by: "role", pattern: "checkbox" });
    expect([b.total, b.returned, b.truncated]).toEqual([300, 50, true]);
    expect(await marks()).toBe(0);
  });

  it("says more may exist past the tree's 1000 (truncated), and leaves no marks", async () => {
    await page(Array.from({ length: 1100 }, (_, i) => `<input type="checkbox" id="c${i}">`).join(""));
    const b = await search({ by: "role", pattern: "checkbox", maxResults: 50, offset: 950 });
    expect([b.total, b.returned, b.truncated]).toEqual([1000, 50, true]);
    expect(await marks()).toBe(0);
  });

  it("keeps matchedBy 'roleImplicit' for a native button the tree also found (/code-review on #1011)", async () => {
    await page(`<button id="sv">Save</button>`);
    expect((await search({ by: "role", pattern: "button" })).results?.[0]).toMatchObject({ selector: "#sv", matchedBy: "roleImplicit", role: "button" });
  });

  it("reports no Chrome-internal role name: a label named by aria-label has no role (/code-review on #1011)", async () => {
    await page(`<label id="lt" aria-label="Terms">Terms</label>`);
    const b = await search({ by: "ariaLabel", pattern: "Terms" });
    expect(b.results?.find((h) => h.selector === "#lt")).toBeDefined();
    expect(b.results?.find((h) => h.selector === "#lt")?.role).toBeUndefined();
  });

  it("returns a selector that matches inside an SVG foreignObject (Chrome matches the lowercased tag in an HTML document; control)", async () => {
    // Two alike, so the path has to climb through foreignObject to tell them apart.
    const FO = `<svg width="200" height="60"><foreignObject width="200" height="60"><div xmlns="http://www.w3.org/1999/xhtml"><span role="button" tabindex="0">In svg</span></div></foreignObject></svg>`;
    await page(FO + FO);
    const b = await search({ by: "role", pattern: "button" });
    expect(b.total).toBe(2);
    for (const h of b.results!) expect(await evaluateInTab(`document.querySelectorAll(${JSON.stringify(h.selector)}).length`, null, PORT)).toBe(1);
  });

  it("does not say truncated for links the tree found inside shadow roots and never marked (/code-review on #1011)", async () => {
    await page(`<div id="host"></div>` + Array.from({ length: 10 }, (_, i) => `<a href="#${i}">L${i}</a> `).join(""));
    await evaluateInTab(`(function(){var r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML=Array.from({length:1100},function(_,i){return '<a href="#s'+i+'">S'+i+'</a> '}).join('');return true})()`, null, PORT);
    const b = await search({ by: "role", pattern: "link", maxResults: 50 });
    expect([b.total, b.truncated]).toEqual([10, false]);
    expect(await marks()).toBe(0);
  });

  it("returns a unique selector for blocks built alike deeper than eight levels (win2 on #1011: Amazon's tiles)", async () => {
    const deep = (n: number, inner: string): string => (n === 0 ? inner : `<div>${deep(n - 1, inner)}</div>`);
    const block = deep(11, `<a href="#t">Tile</a>`);
    await page(`<div>${block}</div><div>${block}</div>`);
    const b = await search({ by: "role", pattern: "link" });
    expect(b.total).toBe(2);
    expect(new Set(b.results!.map((h) => h.selector)).size).toBe(2);
    for (const h of b.results!) expect(await evaluateInTab(`document.querySelectorAll(${JSON.stringify(h.selector)}).length`, null, PORT)).toBe(1);
  });

  it("leaves by:'text' on DOM text (control)", async () => {
    await page(SR);
    expect(sels(await search({ by: "text", pattern: "Accept terms" }))).toEqual(["body:nth-child(2) > label:nth-child(2)"]);
  });
});
