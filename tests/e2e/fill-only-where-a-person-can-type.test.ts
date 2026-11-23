/**
 * internal #420 — browser_fill wrote into fields a person could not reach and answered ok:true "delivered": a field
 * behind a modal <dialog> or inside a part of the page marked inert (booking.com's sign-in prompt, measured by win2), a
 * disabled one (by selector), one not shown. Both roads now refuse those, by what the page's structure says, and write
 * nothing; context.focusAt names where focus is. Nothing that waits on a page's focus handler is judged: a read-only
 * field and one that hands focus on are written as before (a separate item).
 *
 * Headless Chrome gives the page no focus, as a hidden tab or a window behind has. `focused()` turns on CDP's focus
 * emulation from outside, as a window in front has: the structural answers are the same either way.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { browserFillInputHandler } from "../../src/tools/browser.js";

const PORT = 9245;
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

// The page: a field named by its label and aria-label, a textarea, and whatever the cell adds. `open` runs last.
async function page(extra: string, open = ""): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<main id="bg"><label for="em">Email</label><input id="em" aria-label="Email address"><textarea id="ta" aria-label="Notes"></textarea>${extra}</main>` +
    `<script>window.__ev=[];document.addEventListener('input',function(e){window.__ev.push((e.target.id||'?')+':input')},true);${open}</script></body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, null, PORT);
  await sleep(150);
}
const val = async (id: string): Promise<unknown> => evaluateInTab(`document.getElementById(${JSON.stringify(id)}).value`, null, PORT);
const inputs = async (): Promise<string[]> => (await evaluateInTab("window.__ev", null, PORT)) as string[];
// A modal dialog holding a field, opened with showModal: its field has focus. The body by Document's own getter: a
// cell's <img name="body"> shadows document.body.
const openModal = (inner = `<input id="inner" aria-label="Inner field">`) =>
  evaluateInTab(`Object.getOwnPropertyDescriptor(Document.prototype,'body').get.call(document).insertAdjacentHTML('beforeend',${JSON.stringify(`<dialog id="dlg">${inner}</dialog>`)});document.getElementById('dlg').showModal();true`, null, PORT);

function payload(r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = r.content[0]?.type === "text" ? r.content[0].text ?? "{}" : "{}";
  try { return JSON.parse(text.split("\n")[0]) as Record<string, unknown>; } catch { return { text }; }
}
async function fill(args: Record<string, unknown>) {
  return payload(await browserFillInputHandler({ port: PORT, includeContext: false, value: "SPK", ...args } as Parameters<typeof browserFillInputHandler>[0]));
}
const focusAt = (r: Record<string, unknown>) => (r.context as { focusAt?: unknown }).focusAt;
// Both roads, by selector and by name.
const ROADS = (sel: string, name: string): Array<Record<string, unknown>> => [{ selector: sel }, { by: "ariaLabel", pattern: name }];

const BEHIND_MODAL = "browser_fill: a modal dialog is open and the field is outside it, so typing would not reach it; context.focusAt is where focus is. Nothing was written.";
const INERT = "browser_fill: the field is in a part of the page marked inert, which takes no input; context.focusAt is where focus is. Nothing was written.";
const DISABLED = "browser_fill: the field is disabled. Nothing was written.";
const NOT_SHOWN = "browser_fill: the field is not shown. Nothing was written.";
const HINT = ["browser_overview lists the page's controls and any dialog in front of the page"];
const HINT_OTHER = ["browser_overview lists the page's controls; name a field it shows and that is enabled"];

// Runs `body` with CDP's focus emulation on: the page has focus, and its focus handlers run as the field takes focus.
async function focused(body: () => Promise<void>): Promise<void> {
  const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const ws = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const send = (method: string, params: object) => new Promise((res, rej) => {
    const n = ++id;
    const t = setTimeout(() => { ws.off("message", on); rej(new Error(`${method}: no reply`)); }, 5000);
    const on = (m: WebSocket.RawData) => {
      const msg = JSON.parse(String(m)) as { id?: number; error?: { message: string } };
      if (msg.id !== n) return;
      clearTimeout(t); ws.off("message", on);
      if (msg.error) rej(new Error(`${method}: ${msg.error.message}`)); else res(null);
    };
    ws.on("message", on);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  try {
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await body();
  } finally {
    await send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
    ws.close();
  }
}
// The same cell on a page without focus (headless) and with it.
async function bothFocus(body: () => Promise<void>): Promise<void> {
  await body();
  await focused(body);
}

describe.skipIf(!CHROME)("browser_fill does not type where a person cannot reach (internal #420)", () => {
  it("a field behind a modal <dialog> is not written; focusAt names the dialog's field, with and without page focus", async () => {
    await bothFocus(async () => {
      for (const args of [...ROADS("#em", "Email address"), ...ROADS("#ta", "Notes")]) {
        await page("");
        await openModal();
        const r = await fill(args);
        expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
        expect(r.code).toBe("BrowserNoActionableTarget");
        expect(r.suggest).toEqual(HINT);
        expect(focusAt(r)).toEqual({ name: "Inner field", tag: "input" });
        expect([await val("em"), await val("ta")]).toEqual(["", ""]);
        expect(await inputs()).toEqual([]);
      }
    });
  });

  it("the dialog's own field is written", async () => {
    for (const args of ROADS("#inner", "Inner field")) {
      await page("");
      await openModal();
      const r = await fill(args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await val("inner")).toBe("SPK");
    }
  });

  it("a read-only field behind a modal <dialog> answers the dialog", async () => {
    await page(`<input id="ro" aria-label="Read only" readonly>`);
    await openModal();
    const r = await fill({ selector: "#ro" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(await val("ro")).toBe("");
  });

  it("a contenteditable, and a part inside one, behind a modal <dialog> are not written", async () => {
    for (const sel of ["#ce", "#cep"]) {
      await page(`<div id="ce" contenteditable="true" aria-label="Editor"><p id="cep">old</p></div>`);
      await openModal();
      const r = await fill({ selector: sel });
      expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
      expect(await evaluateInTab("document.getElementById('ce').textContent", null, PORT)).toBe("old");
    }
  });

  it("a <select> behind a modal <dialog> is not changed, on both roads; with no dialog it is", async () => {
    for (const args of ROADS("#sel", "Fruit")) {
      const sel = `<select id="sel" aria-label="Fruit"><option value="a">Apple</option><option value="b">Banana</option></select>`;
      await page(sel);
      await openModal();
      const r = await fill({ ...args, value: "b" });
      expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
      expect(await val("sel")).toBe("a");
      await page(sel);
      expect((await fill({ ...args, value: "b" })).ok).toBe(true);
      expect(await val("sel")).toBe("b");
    }
  });

  it("stacked modal dialogs: a field in the lower one is behind the top one; the top one's field is written", async () => {
    await page("");
    await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="d1"><input id="low" aria-label="Lower field"></dialog><dialog id="d2"><input id="up" aria-label="Upper field"></dialog>');` +
      `document.getElementById('d1').showModal();document.getElementById('d2').showModal();true`, null, PORT);
    const r = await fill({ selector: "#low" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(focusAt(r)).toEqual({ name: "Upper field", tag: "input" });
    expect((await fill({ selector: "#up" })).ok).toBe(true);
    expect([await val("low"), await val("up")]).toEqual(["", "SPK"]);
  });

  it("two modal dialogs open and the focus in neither: a field outside both is behind them", async () => {
    await page("");
    await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="d1"><p>One</p></dialog><dialog id="d2"><p>Two</p></dialog>');` +
      `document.getElementById('d1').showModal();document.getElementById('d2').showModal();Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get.call(document).blur();true`, null, PORT);
    const r = await fill({ selector: "#em" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(await val("em")).toBe("");
  });

  it("a modal <dialog> inside a shadow root, its field focused: a field of the page is behind it", async () => {
    await page(`<x-host id="xh"></x-host>`,
      "customElements.define('x-host',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<dialog><input aria-label=\"Shadow inner\"></dialog>';}});" +
      "document.getElementById('xh').shadowRoot.querySelector('dialog').showModal();");
    const r = await fill({ selector: "#em" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(focusAt(r)).toEqual({ name: "Shadow inner", tag: "input" });
    expect(await val("em")).toBe("");
  });

  it("a field slotted into a component's modal dialog is inside it: written; a field of the page is behind it", async () => {
    // Defined once: the second page shares the window's registry, and a second define would throw before showModal.
    const open = "if(!customElements.get('x-sd'))customElements.define('x-sd',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<dialog><slot></slot></dialog>';}});" +
      "document.getElementById('xs').shadowRoot.querySelector('dialog').showModal();document.getElementById('slotted').focus();";
    await page(`<x-sd id="xs"><input id="slotted" aria-label="Slotted field"></x-sd>`, open);
    const r = await fill({ selector: "#slotted" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await val("slotted")).toBe("SPK");
    await page(`<x-sd id="xs"><input id="slotted" aria-label="Slotted field"></x-sd>`, open);
    const b = await fill({ selector: "#em" });
    expect(b.error, JSON.stringify(b)).toBe(BEHIND_MODAL);
    expect(focusAt(b)).toEqual({ name: "Slotted field", tag: "input" });
  });

  it("stacked dialogs, the top one's focus inside a component in it: a field in the lower one is behind the top one", async () => {
    await page("", "customElements.define('x-dg2',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open',delegatesFocus:true}).innerHTML='<input aria-label=\"Component field\">';}});");
    await evaluateInTab(`document.getElementById('bg').insertAdjacentHTML('beforeend','<dialog id="d1"><input id="low" aria-label="Lower field"></dialog><dialog id="d2"><x-dg2 id="comp"></x-dg2></dialog>');` +
      `document.getElementById('d1').showModal();document.getElementById('d2').showModal();document.getElementById('comp').focus();true`, null, PORT);
    const r = await fill({ selector: "#low" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(focusAt(r)).toEqual({ name: "Component field", tag: "input" });
    expect(await val("low")).toBe("");
  });

  it("one modal dialog open and the focus outside it (blurred), on a page whose <img name=\"querySelectorAll\"> shadows the document's: a field of the page is behind it", async () => {
    await page(`<img name="querySelectorAll">`);
    await openModal();
    await evaluateInTab("Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get.call(document).blur();true", null, PORT);
    const r = await fill({ selector: "#em" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(focusAt(r)).toBeNull();
    expect(await val("em")).toBe("");
  });

  it("a modal <dialog> in an open shadow root, focus blurred: a field of the page is behind it", async () => {
    await page(`<x-ob id="xo"></x-ob>`,
      "if(!customElements.get('x-ob'))customElements.define('x-ob',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<dialog><p>Hi</p></dialog>';}});" +
      "document.getElementById('xo').shadowRoot.querySelector('dialog').showModal();document.activeElement&&document.activeElement.blur&&document.activeElement.blur();");
    const r = await fill({ selector: "#em" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(await val("em")).toBe("");
  });

  it("not seen, written as before: a modal in a closed shadow root; with two open and the focus in neither, a field in the lower one", async () => {
    await page(`<x-cs id="xc"></x-cs>`,
      "if(!customElements.get('x-cs'))customElements.define('x-cs',class extends HTMLElement{constructor(){super();const r=this.attachShadow({mode:'closed'});r.innerHTML='<dialog><input aria-label=\"Closed inner\"></dialog>';r.querySelector('dialog').showModal();}});");
    expect((await fill({ selector: "#em" })).ok).toBe(true);
    await page("");
    await evaluateInTab(`document.getElementById('bg').insertAdjacentHTML('beforeend','<dialog id="d1"><input id="low" aria-label="Lower field"></dialog><dialog id="d2"><p>Two</p></dialog>');` +
      `document.getElementById('d1').showModal();document.getElementById('d2').showModal();Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get.call(document).blur();true`, null, PORT);
    expect((await fill({ selector: "#low" })).ok).toBe(true);
  });

  it("a refused field is not focused first: its focus handler does not run (behind a dialog; a focusable custom element that says it is disabled)", async () => {
    for (const args of ROADS("#em", "Email address")) {
      await page("", "window.__f=0;document.getElementById('em').addEventListener('focus',function(){window.__f++});");
      await openModal();
      expect((await fill(args)).error).toBe(BEHIND_MODAL);
      expect(await evaluateInTab("window.__f", null, PORT)).toBe(0);
    }
    await focused(async () => {
      await page(`<x-dis2 id="xd2" tabindex="0"></x-dis2>`, "window.__f=0;if(!customElements.get('x-dis2'))customElements.define('x-dis2',class extends HTMLElement{get disabled(){return true}get value(){return this._v||''}set value(v){this._v=String(v)}});document.getElementById('xd2').addEventListener('focus',function(){window.__f++});");
      expect((await fill({ selector: "#xd2" })).error).toBe(DISABLED);
      expect(await evaluateInTab("window.__f", null, PORT)).toBe(0);
    });
  });

  it("a field inside a part of the page marked inert is not written, with nothing focused (focusAt null)", async () => {
    await bothFocus(async () => {
      for (const args of ROADS("#em", "Email address")) {
        await page("", "document.getElementById('bg').inert=true;");
        const r = await fill(args);
        expect(r.error, JSON.stringify(r)).toBe(INERT);
        expect(r.suggest).toEqual(HINT);
        expect(focusAt(r)).toBeNull();
        expect(await val("em")).toBe("");
      }
    });
  });

  it("an aria-modal prompt over an inert page (booking.com's sign-in): focus on its close button, the field behind not written", async () => {
    const prompt = `</main><div role="dialog" aria-modal="true" aria-label="Sign in" style="position:fixed;inset:0"><button id="x" aria-label="Close sign-in">x</button></div><main>`;
    for (const args of ROADS("#em", "Email address")) {
      await page(prompt, "document.getElementById('bg').inert=true;document.getElementById('x').focus();");
      const r = await fill(args);
      expect(r.error, JSON.stringify(r)).toBe(INERT);
      expect(focusAt(r)).toEqual({ name: "Close sign-in", tag: "button" });
      expect(await val("em")).toBe("");
    }
  });

  it("an inert shadow host: the field in its shadow root is not written", async () => {
    await page(`<x-in id="xi" inert></x-in>`,
      "customElements.define('x-in',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<input>';}get value(){return this.shadowRoot.querySelector('input').value}set value(v){this.shadowRoot.querySelector('input').value=v}});");
    const r = await fill({ selector: "#xi" });
    expect(r.error, JSON.stringify(r)).toBe(INERT);
    expect(await val("xi")).toBe("");
  });

  it("an aria-modal div without inert: the page's fields still take focus (Tab reaches them), and are written as before", async () => {
    const prompt = `</main><div role="dialog" aria-modal="true" aria-label="Promo" style="position:fixed;left:0;top:200px;width:200px;height:50px;background:#fff"><input id="inner2" aria-label="Promo field"></div><main>`;
    for (const args of ROADS("#em", "Email address")) {
      await page(prompt, "document.getElementById('inner2').focus();");
      const r = await fill(args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await val("em")).toBe("SPK");
    }
  });

  it("a dialog opened with show() leaves the page usable: written", async () => {
    for (const args of ROADS("#em", "Email address")) {
      await page(`<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>`, "document.getElementById('dlg').show();");
      const r = await fill(args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await val("em")).toBe("SPK");
    }
  });

  it("a page whose named images shadow document.activeElement, querySelectorAll, body: behind a dialog refused with focusAt; plain written", async () => {
    const imgs = `<img name="activeElement"><img name="querySelectorAll"><img name="body"><img name="documentElement">`;
    await page(imgs);
    await openModal();
    const r = await fill({ selector: "#em" });
    expect(r.error, JSON.stringify(r)).toBe(BEHIND_MODAL);
    expect(focusAt(r)).toEqual({ name: "Inner field", tag: "input" });
    await page(imgs, "document.getElementById('bg').inert=true;");
    expect(focusAt(await fill({ selector: "#em" }))).toBeNull();
    await page(imgs);
    for (const args of ROADS("#em", "Email address")) expect((await fill(args)).ok).toBe(true);
    expect(await val("em")).toBe("SPK");
  });

  it("a page that removed ShadowRoot.prototype.activeElement still fills a plain field", async () => {
    await page("", "delete ShadowRoot.prototype.activeElement;");
    for (const args of ROADS("#em", "Email address")) {
      const r = await fill(args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  it("focusAt gives a masked field's name, never its value", async () => {
    await page("");
    await openModal(`<input id="pw" type="password" aria-label="Passcode" value="hunter2">`);
    const r = await fill({ selector: "#em" });
    expect(focusAt(r)).toEqual({ name: "Passcode", tag: "input" });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("a disabled field named by selector is not written (by name it was never a target)", async () => {
    await page(`<input id="dis" aria-label="Disabled field" disabled>`);
    const r = await fill({ selector: "#dis" });
    expect(r.error, JSON.stringify(r)).toBe(DISABLED);
    expect(r.suggest).toEqual(HINT_OTHER);
    expect(await val("dis")).toBe("");
    expect((await fill({ by: "ariaLabel", pattern: "Disabled field" })).code).toBe("BrowserNoActionableTarget");
    expect(await val("dis")).toBe("");
  });

  it("a field inside a <fieldset disabled> is disabled too (by name, it was never a target)", async () => {
    await page(`<fieldset disabled><input id="fd" aria-label="Fieldset field"></fieldset>`);
    const r = await fill({ selector: "#fd" });
    expect(r.error, JSON.stringify(r)).toBe(DISABLED);
    expect((await fill({ by: "ariaLabel", pattern: "Fieldset field" })).code).toBe("BrowserNoActionableTarget");
    expect(await val("fd")).toBe("");
  });

  it("a custom element that says it is disabled (its own disabled property) is not written", async () => {
    await page(`<x-dis id="xd" tabindex="0"></x-dis>`, "customElements.define('x-dis',class extends HTMLElement{get disabled(){return true}get value(){return this._v||''}set value(v){this._v=String(v)}});");
    const r = await fill({ selector: "#xd" });
    expect(r.error, JSON.stringify(r)).toBe(DISABLED);
    expect(await val("xd")).toBe("");
  });

  it("a native field not shown (a hidden input, display:none, visibility hidden or collapse, inside a closed <details>) says so", async () => {
    for (const html of [`<input id="nh" type="hidden">`, `<textarea id="nh" style="display:none"></textarea>`, `<input id="nh" style="visibility:hidden">`,
      `<input id="nh" style="visibility:collapse">`, `<details><summary>More</summary><input id="nh"></details>`]) {
      await page(html);
      const r = await fill({ selector: "#nh" });
      expect(r.error, JSON.stringify(r)).toBe(NOT_SHOWN);
      expect(r.suggest).toEqual(HINT_OTHER);
      expect(await val("nh")).toBe("");
    }
  });

  it("not judged here, written as before, with and without page focus: read-only, one that drops readonly on focus, one that hands focus on", async () => {
    await bothFocus(async () => {
      await page(`<input id="ro" aria-label="Read only" readonly><input id="ar" aria-label="Anti autofill" readonly onfocus="this.removeAttribute('readonly')">` +
        `<input id="fr" aria-label="Hands focus on"><input id="fr2" aria-label="Focus target">`,
        "document.getElementById('fr').addEventListener('focus',function(){document.getElementById('fr2').focus()});");
      for (const args of [...ROADS("#ro", "Read only"), ...ROADS("#ar", "Anti autofill"), ...ROADS("#fr", "Hands focus on")]) {
        const r = await fill(args);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect("pageFocused" in r).toBe(false);
      }
      expect([await val("ro"), await val("ar"), await val("fr")]).toEqual(["SPK", "SPK", "SPK"]);
    });
  });

  it("custom elements are written as before: delegatesFocus, a slotted input, a closed shadow root, one that takes no focus", async () => {
    const defs: Array<[string, string]> = [
      [`<x-dg id="c"></x-dg>`, "customElements.define('x-dg',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open',delegatesFocus:true}).innerHTML='<input>';}get value(){return this.shadowRoot.querySelector('input').value}set value(v){this.shadowRoot.querySelector('input').value=v}});"],
      [`<x-sl id="c"><input></x-sl>`, "customElements.define('x-sl',class extends HTMLElement{focus(){this.querySelector('input').focus()}get value(){return this.querySelector('input').value}set value(v){this.querySelector('input').value=v}});"],
      [`<x-cl id="c"></x-cl>`, "customElements.define('x-cl',class extends HTMLElement{constructor(){super();this._r=this.attachShadow({mode:'closed'});this._r.innerHTML='<input>';}get value(){return this._r.querySelector('input').value}set value(v){this._r.querySelector('input').value=v}});"],
      [`<x-vo id="c"></x-vo>`, "customElements.define('x-vo',class extends HTMLElement{get value(){return this._v||''}set value(v){this._v=String(v)}});"],
    ];
    for (const [html, def] of defs) {
      await page(html, def);
      const r = await fill({ selector: "#c" });
      expect(r.ok, `${html} ${JSON.stringify(r)}`).toBe(true);
      expect(await val("c")).toBe("SPK");
    }
  });

  it("an ion-input-style element (no focus of its own, a light-DOM input) behind a modal dialog is not written", async () => {
    await page(`<x-ion id="xi"><input></x-ion>`, "customElements.define('x-ion',class extends HTMLElement{get value(){return this.querySelector('input').value}set value(v){this.querySelector('input').value=v}});");
    await openModal();
    expect((await fill({ selector: "#xi" })).error).toBe(BEHIND_MODAL);
    expect(await val("xi")).toBe("");
  });

  it("plain fields and contenteditables are written on both roads, with and without page focus", async () => {
    await bothFocus(async () => {
      for (const args of [...ROADS("#em", "Email address"), ...ROADS("#ta", "Notes")]) {
        await page("");
        const r = await fill(args);
        expect(r.ok, JSON.stringify(r)).toBe(true);
      }
      for (const sel of ["#ce", "#cep"]) {
        await page(`<div id="ce" contenteditable="true" aria-label="Editor"><p id="cep">old</p></div>`);
        expect((await fill({ selector: sel })).ok).toBe(true);
      }
    });
  });
});
