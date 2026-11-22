/**
 * internal #420 — a `scope` limits a search to every element the selector matches, not only the first (win2 on
 * #1022: `scope:"#s1, #s2"` acted as if only #s1 were in scope). Each road that takes a scope is asked: the DOM
 * reading (by:'text' / 'selector'), the accessibility tree's reading (by:'role' / 'ariaLabel', a label carried to a
 * widget over a hidden select), browser_search, browser_fill and browser_overview.
 *
 * The press cells ask the resolver which element it would press (a press itself needs the Windows engine), so the
 * wrong element (the first section's, or the one outside the scope) shows; a stop is asked through browser_click,
 * and the page's record shows nothing was pressed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll, clearAxMarks, markAxMatches } from "../../src/engine/cdp-bridge.js";
import { resolveBrowserActionTarget } from "../../src/tools/browser-resolver.js";
import {
  browserClickElementHandler, browserFillInputHandler, browserGetInteractiveHandler, browserSearchHandler,
} from "../../src/tools/browser.js";

const PORT = 9243;
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

// Every press is recorded by the id of what was pressed.
async function page(body: string): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}section{padding:4px}</style></head><body>${body}` +
    `<script>window.__pressed=[];document.addEventListener('click',function(e){var t=e.target.closest('[id]');window.__pressed.push(t?t.id:'?')},true)</script></body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, null, PORT);
  await sleep(150);
}
const pressed = async (): Promise<string[]> => (await evaluateInTab("window.__pressed", null, PORT)) as string[];

function payload(r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = r.content[0]?.type === "text" ? r.content[0].text ?? "{}" : "{}";
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { text }; }
}
async function click(args: Record<string, unknown>) {
  return payload(await browserClickElementHandler({ port: PORT, ...args } as Parameters<typeof browserClickElementHandler>[0]));
}
// The element browser_click would press: its id, or the outcome's kind.
async function presses(args: { by: "text" | "selector" | "role" | "ariaLabel"; pattern: string; scope: string }): Promise<string> {
  const o = await resolveBrowserActionTarget({ ...args, action: "click", requireReceivesEvents: true, port: PORT, tabId: null });
  if (o.kind === "resolved" && o.axMark !== undefined) await clearAxMarks(o.axMark, null, PORT);
  return o.kind === "resolved" ? `#${o.matched.id ?? ""}` : o.kind;
}

const TWO = `<section id="s1"><p>Account</p></section><section id="s2"><button id="save2">Save</button></section><button id="saveOut">Save</button>`;

describe.skipIf(!CHROME)("a scope reads every element it matches (internal #420)", () => {
  it("by:'text' finds a match in the second element of a comma scope", async () => {
    await page(TWO);
    expect(await presses({ by: "text", pattern: "Save", scope: "#s1, #s2" })).toBe("#save2");
  });

  it("by:'text' with a match in each element of a comma scope is ambiguous, and nothing is pressed", async () => {
    await page(`<section id="s1"><button id="a">Save</button></section><section id="s2"><button id="b">Save</button></section>`);
    const r = await click({ by: "text", pattern: "Save", scope: "#s1, #s2" });
    expect(r.code, JSON.stringify(r)).toBe("BrowserAmbiguousTarget");
    expect(await pressed()).toEqual([]);
  });

  it("a class scope reaches the third card", async () => {
    await page(`<div class="card"><p>One</p></div><div class="card"><p>Two</p></div><div class="card"><button id="buy3">Buy</button></div><button id="buyOut">Buy</button>`);
    expect(await presses({ by: "text", pattern: "Buy", scope: ".card" })).toBe("#buy3");
  });

  it("a match inside another match is searched once: one control is not two", async () => {
    await page(`<div class="box"><div class="box"><button id="go">Go</button></div></div>`);
    expect(await presses({ by: "text", pattern: "Go", scope: ".box" })).toBe("#go");
  });

  it("by:'selector' is limited to every element of the scope", async () => {
    await page(`<section id="s1"><a id="l1" href="#x">x</a></section><section id="s2"><button id="act" class="act">Act</button></section><button id="actOut" class="act">Act</button>`);
    expect(await presses({ by: "selector", pattern: ".act", scope: "#s1, #s2" })).toBe("#act");
  });

  it("by:'role' (the accessibility tree) asks the tree under each element of the scope", async () => {
    // A native checkbox has no role attribute: only the tree finds it, so the DOM reading cannot stand in.
    await page(`<section id="s1"><p>x</p></section><section id="s2"><input type="checkbox" id="agree" aria-label="Agree"></section><input type="checkbox" id="agreeOut" aria-label="Out">`);
    expect(await presses({ by: "role", pattern: "checkbox", scope: "#s1, #s2" })).toBe("#agree");
    await page(`<section id="s1"><button id="a">A</button></section><section id="s2"><button id="b">B</button></section>`);
    const two = await click({ by: "role", pattern: "button", scope: "#s1, #s2" });
    expect(two.code, JSON.stringify(two)).toBe("BrowserAmbiguousTarget");
    expect(await pressed()).toEqual([]);
  });

  it("by:'ariaLabel' (the accessibility tree) finds a name in the second element", async () => {
    // Named by aria-labelledby: only the tree has that name, so the DOM reading (aria-label) cannot stand in.
    await page(`<span id="cp">Close panel</span><section id="s1"><p>x</p></section><section id="s2"><button id="close" aria-labelledby="cp">×</button></section><button id="closeOut" aria-labelledby="cp">×</button>`);
    expect(await presses({ by: "ariaLabel", pattern: "Close panel", scope: "#s1, #s2" })).toBe("#close");
  });

  it("by:'ariaLabel' carries a hidden select's label to its widget in the second element", async () => {
    // The tree leaves the hidden select out; its name is carried to the combobox around it (W12).
    await page(`<section id="s1"><p>x</p></section><section id="s2"><div id="fruit" role="combobox" tabindex="0" style="display:inline-block;padding:4px;border:1px solid">Pick<select hidden aria-label="Fruit"><option>Apple</option></select></div></section>`);
    expect(await presses({ by: "ariaLabel", pattern: "Fruit", scope: "#s1, #s2" })).toBe("#fruit");
  });

  it("a scope that matches 2,000 rows asks the tree under them together, not one after another", async () => {
    // Asked one after another, this took 33 s on a Mac (/code-review on this change); together, about 0.3 s.
    const rows = Array.from({ length: 2000 }, (_, i) => `<tr><td>${i}</td><td><button id="b${i}">Row ${i}</button></td></tr>`).join("");
    await page(`<table>${rows}</table>`);
    const t = Date.now();
    expect(await presses({ by: "role", pattern: "button", scope: "tr" })).toBe("ambiguous");
    expect(Date.now() - t).toBeLessThan(8000);
  }, 60_000);

  it("a node aria-owns places under two elements of the scope is marked once", async () => {
    await page(`<div id="menu"><button aria-owns="popup">Menu</button></div><div id="popup" role="listbox"><div role="option">A</div><div role="option">B</div></div>`);
    let found = -1;
    const n = await markAxMatches({ by: "role", pattern: "option", caseSensitive: false, nonce: "own1", scope: "#menu, #popup", onFound: (f) => { found = f; } }, null, PORT);
    await clearAxMarks("own1", null, PORT);
    expect([n, found]).toEqual([2, 2]);
  });

  it("browser_search lists matches from every element of the scope", async () => {
    await page(`<section id="s1"><p id="p1">Needle one</p></section><p id="p0">Needle out</p><section id="s2"><p id="p2">Needle two</p></section>`);
    const r = payload(await browserSearchHandler({
      by: "text", pattern: "Needle", scope: "#s1, #s2", maxResults: 10, offset: 0, visibleOnly: true, inViewportOnly: false,
      caseSensitive: false, port: PORT,
    } as Parameters<typeof browserSearchHandler>[0])) as { results?: Array<{ text: string }> };
    expect((r.results ?? []).map((x) => x.text)).toEqual(["Needle one", "Needle two"]);
    // A scope into text the page never draws (a noscript while scripts run) is answered as asked, also when it is
    // not the first element the scope matches.
    // Built through the DOM: parsed while scripts run, a noscript holds raw text, not an element to search.
    await page(`<section id="s1"><p>x</p></section>`);
    await evaluateInTab("(function(){var n=document.createElement('noscript');var sp=document.createElement('span');sp.textContent='Needle hidden';n.appendChild(sp);document.body.appendChild(n);return true})()", null, PORT);
    const ns = payload(await browserSearchHandler({
      by: "text", pattern: "Needle hidden", scope: "#s1, noscript", maxResults: 10, offset: 0, visibleOnly: false, inViewportOnly: false,
      caseSensitive: false, port: PORT,
    } as Parameters<typeof browserSearchHandler>[0])) as { results?: Array<{ text: string }> };
    expect((ns.results ?? []).map((x) => x.text)).toEqual(["Needle hidden"]);
  });

  it("browser_search by:'role' adds the DOM's implicit roles from every element of the scope", async () => {
    // Under a misused aria-hidden the tree leaves the button out; the DOM reading finds it by its tag.
    await page(`<section id="s1"><p>x</p></section><section id="s2" aria-hidden="true"><button id="hb">Hidden from the tree</button></section>`);
    const r = payload(await browserSearchHandler({
      by: "role", pattern: "button", scope: "#s1, #s2", maxResults: 10, offset: 0, visibleOnly: true, inViewportOnly: false,
      caseSensitive: false, port: PORT,
    } as Parameters<typeof browserSearchHandler>[0])) as { results?: Array<{ text: string }> };
    expect((r.results ?? []).map((x) => x.text)).toEqual(["Hidden from the tree"]);
  });

  it("browser_fill (by-axis) reaches a field in the second element", async () => {
    // Named by its <label>, which only the tree reads.
    await page(`<section id="s1"><p>x</p></section><section id="s2"><label for="e2">Email</label><input id="e2"></section><label for="eOut">Email</label><input id="eOut">`);
    const r = payload(await browserFillInputHandler({
      by: "ariaLabel", pattern: "Email", scope: "#s1, #s2", value: "a@b.c", includeContext: false, port: PORT,
    } as Parameters<typeof browserFillInputHandler>[0]));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await evaluateInTab("[document.getElementById('e2').value, document.getElementById('eOut').value]", null, PORT)).toEqual(["a@b.c", ""]);
  });

  it("browser_overview lists every element of the scope, and says when the scope matches nothing", async () => {
    await page(`<section id="s1"><button>One</button></section><button>Out</button><section id="s2"><button>Two</button></section>`);
    const r = await browserGetInteractiveHandler({ scope: "#s1, #s2", types: ["all"], inViewportOnly: false, maxResults: 50, port: PORT, includeContext: false });
    const t = (r.content[0] as { text: string }).text;
    const items = JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1)) as Array<{ text: string }>;
    expect(items.map((i) => i.text)).toEqual(["One", "Two"]);
    const none = payload(await browserGetInteractiveHandler({ scope: "#nothing", types: ["all"], inViewportOnly: false, maxResults: 50, port: PORT, includeContext: false }));
    expect(none.code, JSON.stringify(none)).toBe("ScopeNotFound");
    // A match inside another match is listed once.
    await page(`<div class="box"><div class="box"><button>Go</button></div></div>`);
    const nested = await browserGetInteractiveHandler({ scope: ".box", types: ["all"], inViewportOnly: false, maxResults: 50, port: PORT, includeContext: false });
    const nt = (nested.content[0] as { text: string }).text;
    expect((JSON.parse(nt.slice(nt.indexOf("["), nt.lastIndexOf("]") + 1)) as Array<{ text: string }>).map((i) => i.text)).toEqual(["Go"]);
  });
});

describe.skipIf(!CHROME)("nothing matching is said as such (internal #420)", () => {
  it("a scope that matches the control itself finds nothing inside it, and says so with the scope's rule", async () => {
    await page(`<button class="save" id="a">Save</button>`);
    const r = await click({ by: "role", pattern: "button", scope: "button.save" });
    expect(r.code, JSON.stringify(r)).toBe("BrowserNoActionableTarget");
    expect(r.error).toBe("browser_click: nothing matches. Nothing was done.");
    expect((r.suggest as string[]).some((x) => x.startsWith("scope searches inside every element it matches"))).toBe(true);
    expect(await pressed()).toEqual([]);
  });

  it("without a scope, the answer leaves the scope's rule out; browser_fill says the same", async () => {
    await page(`<button id="a">Save</button>`);
    const r = await click({ by: "text", pattern: "No such words" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: nothing matches. Nothing was done.");
    expect((r.suggest as string[]).some((x) => x.includes("scope"))).toBe(false);
    const f = payload(await browserFillInputHandler({ by: "ariaLabel", pattern: "No such field", value: "x", includeContext: false, port: PORT } as Parameters<typeof browserFillInputHandler>[0]));
    expect(f.error, JSON.stringify(f)).toBe("browser_fill: nothing matches. Nothing was done.");
  });

  it("matches that are all hidden are said to be hidden, not missing; the answer states counts, not what to show", async () => {
    await page(`<a id="set" href="#s" style="display:none">Settings</a>`);
    const r = await click({ by: "text", pattern: "Settings" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: 1 match(es), none to act on: 1 hidden (no box, or display/visibility/opacity hides it). Nothing was done.");
    expect(r.suggest).toEqual(["browser_search with the same by/pattern and visibleOnly:false lists these matches, hidden ones too, with each one's role", "by:'ariaLabel' matches a control by the name the browser gives it (aria-label, its label), which text hidden inside it does not change"]);
    expect((r.context as { matched: number; hidden: number; offRole: number }).hidden).toBe(1);
  });

  it("a label hidden inside a shown button points at by:'ariaLabel', which names the button", async () => {
    await page(`<button id="sb" aria-label="Search docs"><svg width="16" height="16"></svg><span style="display:none">Search docs</span></button>`);
    const r = await click({ by: "text", pattern: "Search docs" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: 1 match(es), none to act on: 1 hidden (no box, or display/visibility/opacity hides it). Nothing was done.");
    expect((r.suggest as string[]).at(-1)).toBe("by:'ariaLabel' matches a control by the name the browser gives it (aria-label, its label), which text hidden inside it does not change");
    expect(await presses({ by: "ariaLabel", pattern: "Search docs", scope: "body" })).toBe("#sb");
  });

  it("matches of another role are counted on both tests", async () => {
    await page(`<button id="a">Save</button><span id="h" style="display:none">Save</span>`);
    const r = await click({ by: "text", pattern: "Save", role: "link" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: 2 match(es), none to act on: 1 hidden (no box, or display/visibility/opacity hides it); 2 not of role 'link' (a match can be counted in both). Nothing was done.");
    expect(r.suggest).toEqual(["browser_search with the same by/pattern and visibleOnly:false lists these matches, hidden ones too, with each one's role", "by:'ariaLabel' matches a control by the name the browser gives it (aria-label, its label), which text hidden inside it does not change"]);
  });

  it("the tree's road keeps its own count when the DOM reading finds none either", async () => {
    // Named by its <label>, which only the tree reads; hidden (opacity 0), so the tree's match is filtered out and the
    // DOM reading, which reads aria-label, finds nothing.
    await page(`<label for="e">Email</label><input id="e" style="opacity:0">`);
    const f = payload(await browserFillInputHandler({ by: "ariaLabel", pattern: "Email", value: "x", includeContext: false, port: PORT } as Parameters<typeof browserFillInputHandler>[0]));
    expect(f.error, JSON.stringify(f)).toBe("browser_fill: 1 match(es), none to act on: 1 hidden (no box, or display/visibility/opacity hides it). Nothing was done.");
    expect(f.suggest).toEqual(["browser_search with the same by/pattern and visibleOnly:false lists these matches, hidden ones too, with each one's role"]);
    expect(await evaluateInTab("document.getElementById('e').value", null, PORT)).toBe("");
  });

  it("a count from the tree's list that reached its cap says not every match was read", async () => {
    const fields = Array.from({ length: 230 }, (_, i) => `<label for="f${i}">Item ${i}</label><input id="f${i}" style="opacity:0">`).join("");
    await page(fields);
    const f = payload(await browserFillInputHandler({ by: "ariaLabel", pattern: "Item", value: "x", includeContext: false, port: PORT } as Parameters<typeof browserFillInputHandler>[0]));
    expect(f.error, JSON.stringify(f).slice(0, 400)).toBe("browser_fill: 200 match(es), none to act on: 200 hidden (no box, or display/visibility/opacity hides it). The search stopped before reading every match. Nothing was done.");
    expect((f.suggest as string[])[0]).toMatch(/^Narrow the search with a scope/);
  }, 30_000);

  it("the selector road's hidden match is said to be hidden, not that the selector matches nothing", async () => {
    await page(`<button class="save" id="a" style="display:none">Save</button>`);
    const r = await click({ selector: "button.save" });
    expect(r.code, JSON.stringify(r)).toBe("BrowserNoActionableTarget");
    expect(r.error).toBe("browser_click: 1 match(es), none to act on: 1 hidden (no box, or display/visibility/opacity hides it). Nothing was done.");
  });

  it("a match that cannot be pressed keeps its own answer", async () => {
    await page(`<p id="t">Just a label</p>`);
    const r = await click({ by: "text", pattern: "Just a label" });
    expect(r.code, JSON.stringify(r)).toBe("BrowserNoActionableTarget");
    expect(r.error).toBe("browser_click: 1 match(es) found but none is an auto-actionable target.");
  });
});
