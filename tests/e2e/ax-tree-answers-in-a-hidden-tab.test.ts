/**
 * internal #420 — the by-axis questions (by:'role', by:'ariaLabel', desktop_discover's controls, browser_search) read
 * the browser's accessibility tree, and answer in a tab that is not shown. Accessibility.queryAXTree waits there for a
 * frame that does not come: each call ran into the 15 s command timeout and fell back to the DOM reading (win2: a
 * by:'ariaLabel' fill took ~15 s in a hidden tab). There the tree is now read whole (getFullAXTree), which answers;
 * the front tab still asks queryAXTree. Each cell runs in both, with the same expected values: the hidden tab's reading
 * keeps queryAXTree's answer — the same nodes, under a scope too (with what it owns by aria-owns), in queryAXTree's
 * order (a slot's assigned nodes where the slot is), which decides which ones a cap keeps.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll, markAxMatches, clearAxMarks, AX_WHOLE_TREE_MAX_ELEMENTS } from "../../src/engine/cdp-bridge.js";
import { browserFillInputHandler } from "../../src/tools/browser.js";

const PORT = 9246;
const CHROME = tryFindChrome() !== null;
let chrome: ChromeInstance;
let tab = "";
let other = "";

const cdp = async (path: string, method = "GET"): Promise<{ id: string }> =>
  (await (await fetch(`http://127.0.0.1:${PORT}${path}`, { method })).json()) as { id: string };

beforeAll(async () => {
  if (!CHROME) return;
  chrome = await launchChrome(PORT, !process.env.HEADED, "about:blank");
  tab = (await cdp("/json/new?about:blank", "PUT")).id;
  other = (await cdp("/json/new?about:blank", "PUT")).id;
}, 20_000);
afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

// By the prototype's getter: a cell below gives the document its own visibilityState, which document.write keeps.
const state = async (): Promise<string> =>
  (await evaluateInTab("Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get.call(document)", tab, PORT)) as string;
/** Bring one tab to the front; the page's tab is then shown or hidden, checked (/code-review on #1037). */
async function front(id: string): Promise<void> {
  expect((await fetch(`http://127.0.0.1:${PORT}/json/activate/${id}`)).ok).toBe(true);
  const want = id === tab ? "visible" : "hidden";
  for (let t0 = Date.now(); Date.now() - t0 < 5_000 && (await state()) !== want;) await sleep(100);
  expect(await state()).toBe(want);
}

async function page(body: string): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}</style></head><body>${body}</body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, tab, PORT);
  await sleep(150);
}
/** The ids of the elements one markAxMatches call marked, in document order. */
async function marked(nonce: string): Promise<string[]> {
  return (await evaluateInTab(
    `Array.prototype.map.call(document.querySelectorAll('[data-dtm-ax*="${nonce}:"]'), function(n){return n.id;})`, tab, PORT)) as string[];
}
async function mark(by: "role" | "ariaLabel" | "controls", pattern: string, extra: { scope?: string; cap?: number } = {}):
  Promise<{ count: number | null; ids: string[]; ms: number }> {
  const nonce = `t${Math.random().toString(36).slice(2, 8)}`;
  const t0 = Date.now();
  const count = await markAxMatches({ by, pattern, caseSensitive: false, nonce, ...extra }, tab, PORT);
  const ms = Date.now() - t0;
  const ids = await marked(nonce);
  await clearAxMarks(nonce, tab, PORT);
  return { count, ids, ms };
}

const FORM = `<h1>Account</h1>
  <form id="f"><label>Email <input id="email"></label><button id="save" aria-label="Save changes">Save</button>
    <div id="sw" role="switch" aria-checked="false" tabindex="0" aria-label="Notifications">o</div></form>
  <aside id="side"><button id="save2" aria-label="Save draft">Save</button></aside>`;

// Light children a shadow root slots in the other order: the flat tree reads b before a.
const SLOTTED = `<button id="first" aria-label="Item">x</button>
  <x-host id="host"><button id="la" slot="a" aria-label="Item">a</button><button id="lb" slot="b" aria-label="Item">b</button></x-host>
  <button id="last" aria-label="Item">y</button>
  <script>
    if (!customElements.get('x-host')) customElements.define('x-host', class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<slot name="b"></slot><slot name="a"></slot>'; }
    });
  </script>`;

describe.skipIf(!CHROME)("the accessibility tree answers in a hidden tab (internal #420)", () => {
  for (const shown of [true, false]) {
    const where = shown ? "in the front tab" : "in a hidden tab";

    it(`by:'ariaLabel' finds a field by its label's name ${where}, at once`, async () => {
      await front(shown ? tab : other);
      await page(FORM);
      const r = await mark("ariaLabel", "Email");
      expect(r.count).toBe(1);
      expect(r.ids).toEqual(["email"]);
      expect(r.ms).toBeLessThan(10_000);
    });

    it(`by:'role' and controls read the tree ${where}`, async () => {
      await front(shown ? tab : other);
      await page(FORM);
      expect((await mark("role", "button")).ids).toEqual(["save", "save2"]);
      expect((await mark("role", "Switch")).ids).toEqual(["sw"]);
      expect((await mark("controls", "")).ids).toEqual(["sw"]);
    });

    it(`a scope keeps the nodes under it ${where}`, async () => {
      await front(shown ? tab : other);
      await page(FORM);
      expect((await mark("ariaLabel", "Save", { scope: "#f" })).ids).toEqual(["save"]);
      expect((await mark("ariaLabel", "Save", { scope: "#side" })).ids).toEqual(["save2"]);
      expect((await mark("ariaLabel", "Save", { scope: "form, aside" })).ids).toEqual(["save", "save2"]);
      expect((await mark("ariaLabel", "Save", { scope: "#nothing" })).count).toBeNull();
    });

    it(`a scope takes what it owns by aria-owns, as queryAXTree does, and nothing for a root not in the tree ${where}`, async () => {
      await front(shown ? tab : other);
      await page(`<div id="box"><div id="lb" role="listbox" aria-label="Fruit" aria-owns="o1 o2"></div></div>
        <div id="pop"><div id="o1" role="option" aria-label="Apple">Apple</div><div id="o2" role="option" aria-label="Pear">Pear</div></div>
        <div id="gone" style="display:none"><button id="g" aria-label="Apple">x</button></div>`);
      expect((await mark("role", "option", { scope: "#box" })).ids).toEqual(["o1", "o2"]);
      expect((await mark("role", "option", { scope: "#pop" })).ids).toEqual([]);
      expect((await mark("ariaLabel", "Apple", { scope: "#gone" })).count).toBe(0);
    });

    it(`a cap keeps the first in the flat tree's order, a slot's nodes where the slot is ${where}`, async () => {
      await front(shown ? tab : other);
      await page(SLOTTED);
      expect((await mark("ariaLabel", "Item")).ids).toEqual(["first", "la", "lb", "last"]);
      expect((await mark("ariaLabel", "Item", { cap: 2 })).ids).toEqual(["first", "lb"]);
      expect((await mark("ariaLabel", "Item", { cap: 3 })).ids).toEqual(["first", "la", "lb"]);
    });

    it(`reads a change made while the tab is hidden ${where}`, async () => {
      await front(tab);
      await page(FORM);
      await front(shown ? tab : other);
      await evaluateInTab(`document.getElementById('email').setAttribute('aria-label','Work email');
        document.getElementById('save').style.display='none'; true`, tab, PORT);
      expect((await mark("ariaLabel", "Work email")).ids).toEqual(["email"]);
      expect((await mark("role", "button")).ids).toEqual(["save2"]);
    });

    it(`a page that says it is shown is still read as hidden ${where} (/code-review on #1037)`, async () => {
      await front(shown ? tab : other);
      await page(FORM + `<script>Object.defineProperty(document, 'visibilityState', { configurable: true, get: function() { return 'visible'; } });</script>`);
      expect(await evaluateInTab("document.visibilityState", tab, PORT)).toBe("visible");
      try {
        const r = await mark("ariaLabel", "Email");
        expect(r.ids).toEqual(["email"]);
        expect(r.ms).toBeLessThan(10_000);
      } finally {
        expect(await evaluateInTab("delete document.visibilityState", tab, PORT)).toBe(true);
      }
    });

    it(`a hidden page too large to read whole falls back at once, a shown one reads the tree ${where} (/code-review on #1037)`, async () => {
      await front(shown ? tab : other);
      const n = AX_WHOLE_TREE_MAX_ELEMENTS + 100;
      await page(`<div id="many"></div><button id="big" aria-label="Find me">x</button>
        <script>var m = document.getElementById('many'), f = document.createDocumentFragment();
          for (var i = 0; i < ${n}; i++) f.appendChild(document.createElement('i')); m.appendChild(f);</script>`);
      const r = await mark("ariaLabel", "Find me");
      expect(r.ms).toBeLessThan(10_000);
      if (shown) expect(r.ids).toEqual(["big"]);
      else expect(r.count).toBeNull();
    });

    it(`elements in shadow roots count toward that limit ${where} (/code-review on #1037)`, async () => {
      await front(shown ? tab : other);
      const n = AX_WHOLE_TREE_MAX_ELEMENTS + 100;
      await page(`<div id="host"></div><button id="big" aria-label="Find me">x</button>
        <script>var sr = document.getElementById('host').attachShadow({ mode: 'open' }), f = document.createDocumentFragment();
          for (var i = 0; i < ${n}; i++) f.appendChild(document.createElement('i')); sr.appendChild(f);</script>`);
      const r = await mark("ariaLabel", "Find me");
      expect(r.ms).toBeLessThan(10_000);
      if (shown) expect(r.ids).toEqual(["big"]);
      else expect(r.count).toBeNull();
    });

    it(`browser_fill by:'ariaLabel' writes the field ${where}, without waiting out a timeout`, async () => {
      await front(shown ? tab : other);
      await page(FORM);
      const t0 = Date.now();
      const r = await browserFillInputHandler({ by: "ariaLabel", pattern: "Email", value: "a@b.c", tabId: tab, port: PORT, includeContext: false } as Parameters<typeof browserFillInputHandler>[0]);
      const ms = Date.now() - t0;
      const text = (r.content[0] as { text: string }).text;
      expect(text).toContain('"ok":true');
      expect(await evaluateInTab("document.getElementById('email').value", tab, PORT)).toBe("a@b.c");
      expect(ms).toBeLessThan(10_000);
    });
  }
});
