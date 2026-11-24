/**
 * internal #420 — the by-axis questions (by:'role', by:'ariaLabel', desktop_discover's controls, browser_search) read
 * the browser's accessibility tree, and answer in a tab that is not shown. Accessibility.queryAXTree waits there for a
 * frame that does not come: each call ran into the 15 s command timeout and fell back to the DOM reading (win2: a
 * by:'ariaLabel' fill took ~15 s in a hidden tab). There the tree is now read in pieces (getChildAXNodes, internal
 * #423) when the DOM under the scope is small enough, which answers; the front tab still asks queryAXTree. Each cell runs in both, with the same expected values: the hidden tab's reading
 * keeps queryAXTree's answer — the same nodes, under a scope too (with what it owns by aria-owns), in queryAXTree's
 * order (a slot's assigned nodes where the slot is), which decides which ones a cap keeps.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll, markAxMatches, clearAxMarks, AX_HIDDEN_READ_MAX_DOM_NODES } from "../../src/engine/cdp-bridge.js";
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

    // 20,100 elements: past #1037's element limit, under the DOM budget (an empty element is no node of the tree, but
    // it is counted).
    it(`a page of many elements is read ${where}, in a shadow root too (internal #423: #1037 gave up past 20,000)`, async () => {
      for (const inShadow of [false, true]) {
        await front(shown ? tab : other);
        await page(`<div id="host"></div><button id="big" aria-label="Find me">x</button>
          <script>var h = document.getElementById('host'), r = ${inShadow} ? h.attachShadow({ mode: 'open' }) : h, f = document.createDocumentFragment();
            for (var i = 0; i < 20100; i++) f.appendChild(document.createElement('i')); r.appendChild(f);</script>`);
        const r = await mark("ariaLabel", "Find me");
        expect(r.ms).toBeLessThan(10_000);
        expect(r.ids).toEqual(["big"]);
      }
    });

    it(`a hidden page past the DOM budget falls back before reading, a scope under it is read; a shown one reads the tree ${where}`, async () => {
      await front(shown ? tab : other);
      // Each paragraph is two DOM nodes (it and its text).
      const n = AX_HIDDEN_READ_MAX_DOM_NODES / 2 + 100;
      await page(`<div id="many"></div><form id="f"><button id="big" aria-label="Find me">x</button></form>
        <script>var m = document.getElementById('many'), f = document.createDocumentFragment();
          for (var i = 0; i < ${n}; i++) { var p = document.createElement('p'); p.textContent = 'p' + i; f.appendChild(p); } m.appendChild(f);</script>`);
      const r = await mark("ariaLabel", "Find me");
      expect(r.ms).toBeLessThan(shown ? 10_000 : 2_000);
      if (shown) expect(r.ids).toEqual(["big"]);
      else expect(r.count).toBeNull();
      const scoped = await mark("ariaLabel", "Find me", { scope: "#f" });
      expect(scoped.ids).toEqual(["big"]);
      expect(scoped.ms).toBeLessThan(5_000);
    });

    it(`one list wider than the node budget is not asked for in a hidden tab, and read in a shown one ${where} (/code-review on #1038)`, async () => {
      await front(shown ? tab : other);
      const n = AX_HIDDEN_READ_MAX_DOM_NODES + 100;
      await page(`<ul id="wide"></ul><button id="big" aria-label="Find me">x</button>
        <script>var u = document.getElementById('wide'), f = document.createDocumentFragment();
          for (var i = 0; i < ${n}; i++) { var li = document.createElement('li'); li.textContent = 'row ' + i; f.appendChild(li); } u.appendChild(f);</script>`);
      const r = await mark("ariaLabel", "Find me");
      expect(r.ms).toBeLessThan(10_000);
      if (shown) expect(r.ids).toEqual(["big"]);
      else expect(r.count).toBeNull();
    });

    it(`elements in a shadow root count toward the DOM budget ${where} (/code-review on #1037 and #1038)`, async () => {
      await front(shown ? tab : other);
      const n = AX_HIDDEN_READ_MAX_DOM_NODES + 100;
      await page(`<div id="host"></div><button id="big" aria-label="Find me">x</button>
        <script>var sr = document.getElementById('host').attachShadow({ mode: 'open' }), f = document.createDocumentFragment();
          for (var i = 0; i < ${n}; i++) f.appendChild(document.createElement('i')); sr.appendChild(f);</script>`);
      const r = await mark("ariaLabel", "Find me");
      if (shown) expect(r.ids).toEqual(["big"]);
      else { expect(r.count).toBeNull(); expect(r.ms).toBeLessThan(2_000); }
    });

    it(`a hidden page of few elements and very long text falls back before reading ${where} (/code-review on #1038)`, async () => {
      await front(shown ? tab : other);
      await page(`<pre id="long"></pre><button id="big" aria-label="Find me">x</button>
        <script>document.getElementById('long').textContent = 'a'.repeat(10000100);</script>`);
      const r = await mark("ariaLabel", "Find me", shown ? { scope: "#big" } : {});
      if (shown) expect(r.ids).toEqual(["big"]);
      else { expect(r.count).toBeNull(); expect(r.ms).toBeLessThan(2_000); }
      const scoped = await mark("ariaLabel", "Find me", { scope: "#big" });
      expect(scoped.ids).toEqual(["big"]);
    });

    it(`a page that keeps replacing rows during the read still answers from the tree ${where} (/code-review on #1038)`, async () => {
      await front(shown ? tab : other);
      await page(`<button id="stable" aria-label="Keep me">k</button><div id="feed"></div>
        <script>var feed = document.getElementById('feed'), k = 0;
          function fill() { var f = document.createDocumentFragment();
            for (var i = 0; i < 300; i++) { var d = document.createElement('div'); d.innerHTML = '<p><span>item ' + (k++) + '</span> <b>x</b></p>'; f.appendChild(d); }
            feed.replaceChildren(f); }
          // A hidden tab runs a timer at most once a second; a message channel's task is not held back.
          window.__ch = new MessageChannel(); __ch.port1.onmessage = function() { fill(); __ch.port2.postMessage(0); };
          fill(); __ch.port2.postMessage(0);</script>`);
      try {
        for (let i = 0; i < 5; i++) {
          const r = await mark("ariaLabel", "Keep me");
          expect(r.ids).toEqual(["stable"]);
        }
      } finally {
        // document.write keeps the window, and the loop with it: stopped here (/code-review round 2 on #1038).
        await evaluateInTab("__ch.port1.onmessage = null; __ch.port1.close(); true", tab, PORT);
      }
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
