/**
 * internal #420 — browser_search by:'role' and by:'ariaLabel' read the browser's accessibility tree, as browser_click
 * does (#1008, #1010), so a search and a click on the same words find the same elements. With nothing in the tree, the
 * DOM reading answers as before; visibleOnly:false adds what the tree leaves out (hidden elements).
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

  it("keeps the DOM reading when the tree finds nothing (a button under a misused aria-hidden, as before)", async () => {
    await page(`<div aria-hidden="true"><button id="c" aria-label="Close">×</button></div>`);
    expect(sels(await search({ by: "ariaLabel", pattern: "Close" }))).toEqual(["#c"]);
    expect(sels(await search({ by: "role", pattern: "button" }))).toEqual(["#c"]);
  });

  it("keeps the DOM reading when every mark is filtered out (the tree's one match is off the viewport asked for)", async () => {
    await page(`<div aria-hidden="true"><button id="c" aria-label="Close">×</button></div><button id="far" style="position:absolute;top:5000px">Close</button>`);
    expect(sels(await search({ by: "ariaLabel", pattern: "Close" }))).toEqual(["#far"]);
    expect(sels(await search({ by: "ariaLabel", pattern: "Close", inViewportOnly: true }))).toEqual(["#c"]);
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

  it("leaves by:'text' on DOM text (control)", async () => {
    await page(SR);
    expect(sels(await search({ by: "text", pattern: "Accept terms" }))).toEqual(["body:nth-child(2) > label:nth-child(2)"]);
  });
});
