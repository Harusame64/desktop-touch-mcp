/**
 * internal #420 — browser_fill wrote into fields a person could not type into and answered ok:true "delivered": a field
 * behind a modal <dialog> or under inert (focus stays where it was; booking.com's sign-in prompt, measured by win2), a
 * read-only field, a disabled one (by selector), a field that hands focus on to another. Both roads now focus the field,
 * then write only if it holds focus and is not read-only or disabled; otherwise nothing is written and context.focusAt
 * names where focus is.
 *
 * Headless Chrome gives the page no focus, as a hidden tab or a window behind has: its focus handlers do not run.
 * `focused()` turns on CDP's focus emulation from outside, as a window in front has, for the cells that need it.
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

function payload(r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = r.content[0]?.type === "text" ? r.content[0].text ?? "{}" : "{}";
  try { return JSON.parse(text.split("\n")[0]) as Record<string, unknown>; } catch { return { text }; }
}
async function fill(args: Record<string, unknown>) {
  return payload(await browserFillInputHandler({ port: PORT, includeContext: false, value: "SPK", ...args } as Parameters<typeof browserFillInputHandler>[0]));
}
// Both roads, by selector and by name.
const ROADS = (sel: string, name: string): Array<Record<string, unknown>> => [{ selector: sel }, { by: "ariaLabel", pattern: name }];

const NO_FOCUS = "browser_fill: the field does not hold focus once focused, so typing would not reach it; context.focusAt is where focus is. Nothing was written.";
const READ_ONLY = "browser_fill: the field is read-only. Nothing was written.";
const DISABLED = "browser_fill: the field is disabled. Nothing was written.";
const READ_ONLY_UNFOCUSED = "browser_fill: the field is read-only. The page does not have focus (a hidden tab or a window behind), so its focus handlers, which can make a field writable, have not run. Nothing was written.";
const NOT_SHOWN = "browser_fill: the field is not shown. Nothing was written.";
const HINT = ["browser_overview lists the page's controls and any dialog in front of the page"];

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

describe.skipIf(!CHROME)("browser_fill writes only where a person can type (internal #420)", () => {
  it("a field behind a modal <dialog> is not written; focus stays on the dialog's field, named in context.focusAt", async () => {
    for (const args of ROADS("#em", "Email address")) {
      await page("", "");
      await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>');document.getElementById('dlg').showModal();true`, null, PORT);
      const r = await fill(args);
      expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
      expect(r.code).toBe("BrowserNoActionableTarget");
      expect(r.suggest).toEqual(HINT);
      expect((r.context as { focusAt?: unknown }).focusAt).toEqual({ name: "Inner field", tag: "input" });
      expect(await val("em")).toBe("");
      expect(await inputs()).toEqual([]);
    }
  });

  it("a part inside a contenteditable behind a modal <dialog> is not written (its editing host takes no focus either)", async () => {
    await page(`<div id="ce" contenteditable="true" aria-label="Editor"><p id="cep">old</p></div>`);
    await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>');document.getElementById('dlg').showModal();true`, null, PORT);
    const r = await fill({ selector: "#cep" });
    expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
    expect(await evaluateInTab("document.getElementById('ce').textContent", null, PORT)).toBe("old");
  });

  it("a read-only field behind a modal <dialog> answers the dialog, not read-only: the dialog is what stops a person", async () => {
    for (const args of ROADS("#ro", "Read only")) {
      await page(`<input id="ro" aria-label="Read only" readonly>`);
      await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>');document.getElementById('dlg').showModal();true`, null, PORT);
      const r = await fill(args);
      expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
      expect((r.context as { focusAt?: unknown }).focusAt).toEqual({ name: "Inner field", tag: "input" });
      expect(await val("ro")).toBe("");
    }
  });

  it("the dialog's own field is written", async () => {
    for (const args of [{ selector: "#inner" }, { by: "ariaLabel", pattern: "Inner field" }]) {
      await page("");
      await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>');document.getElementById('dlg').showModal();true`, null, PORT);
      const r = await fill(args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await val("inner")).toBe("SPK");
    }
  });

  it("a field under inert is not written, with nothing focused (focusAt null)", async () => {
    for (const args of ROADS("#em", "Email address")) {
      await page("", "document.getElementById('bg').inert=true;");
      const r = await fill(args);
      expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
      expect((r.context as { focusAt?: unknown }).focusAt).toBeNull();
      expect(await val("em")).toBe("");
    }
  });

  it("an aria-modal prompt over an inert page (booking.com's sign-in): focus on its close button, the field behind not written", async () => {
    const prompt = `</main><div role="dialog" aria-modal="true" aria-label="Sign in" style="position:fixed;inset:0"><button id="x" aria-label="Close sign-in">x</button></div><main>`;
    for (const args of ROADS("#em", "Email address")) {
      await page(prompt, "document.getElementById('bg').inert=true;document.getElementById('x').focus();");
      const r = await fill(args);
      expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
      expect((r.context as { focusAt?: unknown }).focusAt).toEqual({ name: "Close sign-in", tag: "button" });
      expect(await val("em")).toBe("");
    }
  });

  it("an aria-modal div without inert: the field takes focus (Tab reaches it), and is written as before", async () => {
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

  it("a page whose <img name=\"activeElement\"> shadows document.activeElement still reads focus (behind a dialog: refused; plain: written)", async () => {
    await page(`<img name="activeElement"><img name="hasFocus">`);
    await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>');document.getElementById('dlg').showModal();true`, null, PORT);
    const r = await fill({ selector: "#em" });
    expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
    await page(`<img name="activeElement"><img name="hasFocus">`);
    for (const args of ROADS("#em", "Email address")) {
      const w = await fill(args);
      expect(w.ok, JSON.stringify(w)).toBe(true);
    }
    expect(await val("em")).toBe("SPK");
  });

  it("on a page with focus whose <img name=\"hasFocus\"> shadows document.hasFocus, a read-only field is still refused", async () => {
    await focused(async () => {
      await page(`<img name="activeElement"><img name="hasFocus"><input id="ro" aria-label="Read only" readonly>`);
      const r = await fill({ selector: "#ro" });
      expect(r.error, JSON.stringify(r)).toBe(READ_ONLY);
      expect(await val("ro")).toBe("");
    });
  });

  it("focusAt reads through a shadow root: the input inside a component that took focus", async () => {
    await focused(async () => {
      await page(`<input id="fr" aria-label="Hands focus on"><x-sh id="sh"></x-sh>`,
        "customElements.define('x-sh',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open',delegatesFocus:true}).innerHTML='<input aria-label=\"Shadow inner\">';}});" +
        "document.getElementById('fr').addEventListener('focus',function(){document.getElementById('sh').focus()});");
      const r = await fill({ selector: "#fr" });
      expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
      expect((r.context as { focusAt?: unknown }).focusAt).toEqual({ name: "Shadow inner", tag: "input" });
    });
  });

  it("a field that hands focus on to another is not written; focusAt names the one that has it", async () => {
    await focused(async () => {
      for (const args of ROADS("#fr", "Hands focus on")) {
        await page(`<input id="fr" aria-label="Hands focus on"><input id="fr2" aria-label="Focus target">`, "document.getElementById('fr').addEventListener('focus',function(){document.getElementById('fr2').focus()});");
        const r = await fill(args);
        expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
        expect((r.context as { focusAt?: unknown }).focusAt).toEqual({ name: "Focus target", tag: "input" });
        expect(await val("fr")).toBe("");
        expect(await val("fr2")).toBe("");
      }
    });
  });

  it("focusAt gives a masked field's name, never its value", async () => {
    await focused(async () => {
      await page(`<input id="fr" aria-label="Hands focus on"><input id="pw" type="password" aria-label="Passcode" value="hunter2">`, "document.getElementById('fr').addEventListener('focus',function(){document.getElementById('pw').focus()});");
      const r = await fill({ selector: "#fr" });
      expect((r.context as { focusAt?: unknown }).focusAt).toEqual({ name: "Passcode", tag: "input" });
      expect(JSON.stringify(r)).not.toContain("hunter2");
    });
  });

  it("a read-only field is not written, on a page with focus", async () => {
    await focused(async () => {
      for (const args of ROADS("#ro", "Read only")) {
        await page(`<input id="ro" aria-label="Read only" readonly>`);
        const r = await fill(args);
        expect(r.error, JSON.stringify(r)).toBe(READ_ONLY);
        expect(r.suggest).toEqual(HINT);
        expect(await val("ro")).toBe("");
        expect(await inputs()).toEqual([]);
      }
    });
  });

  it("a field that drops readonly as it takes focus (a guard against autofill) is written", async () => {
    await focused(async () => {
      for (const args of ROADS("#ro", "Read only")) {
        await page(`<input id="ro" aria-label="Read only" readonly onfocus="this.removeAttribute('readonly')">`);
        const r = await fill(args);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(await val("ro")).toBe("SPK");
      }
    });
  });

  it("a page without focus (a hidden tab) has not run its focus handlers: read-only is said with pageFocused:false; a field that hands focus on is not seen", async () => {
    await page(`<input id="ro" aria-label="Read only" readonly><input id="fr" aria-label="Hands focus on"><input id="fr2" aria-label="Focus target">` +
      `<input id="ar" aria-label="Anti autofill" readonly onfocus="this.removeAttribute('readonly')">`,
      "document.getElementById('fr').addEventListener('focus',function(){document.getElementById('fr2').focus()});" +
      "window.__win=[];window.addEventListener('focus',function(e){if(e.target===window)window.__win.push('focus')});window.addEventListener('blur',function(e){if(e.target===window)window.__win.push('blur')});");
    if (process.env.HEADED) return;
    expect(await evaluateInTab("document.hasFocus()", null, PORT)).toBe(false);
    for (const args of [...ROADS("#ro", "Read only"), ...ROADS("#ar", "Anti autofill")]) {
      const r = await fill(args);
      expect(r.error, JSON.stringify(r)).toBe(READ_ONLY_UNFOCUSED);
      expect((r.context as { pageFocused?: unknown }).pageFocused).toBe(false);
    }
    expect((await fill({ by: "ariaLabel", pattern: "Hands focus on" })).ok).toBe(true);
    expect([await val("ro"), await val("ar"), await val("fr"), await val("fr2")]).toEqual(["", "", "SPK", ""]);
    // Nothing was done to the page's focus: no window focus or blur.
    expect(await evaluateInTab("window.__win", null, PORT)).toEqual([]);
  });

  it("a read-only custom text field (sl-input readonly: the input inside holds focus) is not written", async () => {
    await focused(async () => {
      await page(`<x-ro id="xr"></x-ro>`,
        "customElements.define('x-ro',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open',delegatesFocus:true}).innerHTML='<input readonly>';}get value(){return this.shadowRoot.querySelector('input').value}set value(v){this.shadowRoot.querySelector('input').value=v}});");
      const r = await fill({ selector: "#xr" });
      expect(r.error, JSON.stringify(r)).toBe(READ_ONLY);
      expect(await val("xr")).toBe("");
    });
  });

  it("an ion-input-style element whose text control is disabled says disabled", async () => {
    await page(`<x-iond id="xd"><input disabled></x-iond>`, "customElements.define('x-iond',class extends HTMLElement{get value(){return this.querySelector('input').value}set value(v){this.querySelector('input').value=v}});");
    const r = await fill({ selector: "#xd" });
    expect(r.error, JSON.stringify(r)).toBe(DISABLED);
    expect(await val("xd")).toBe("");
  });

  it("a field not shown (a hidden input, display:none, visibility:hidden) says so, not the focus answer", async () => {
    for (const html of [`<input id="nh" type="hidden">`, `<textarea id="nh" style="display:none"></textarea>`, `<input id="nh" style="visibility:hidden">`]) {
      await page(html);
      const r = await fill({ selector: "#nh" });
      expect(r.error, JSON.stringify(r)).toBe(NOT_SHOWN);
      expect(await val("nh")).toBe("");
    }
  });

  it("a page that removed ShadowRoot.prototype.activeElement still fills a plain field", async () => {
    await page("", "delete ShadowRoot.prototype.activeElement;");
    for (const args of ROADS("#em", "Email address")) {
      const r = await fill(args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  it("a <select> behind a modal <dialog> is not changed, on both roads", async () => {
    for (const args of ROADS("#sel", "Fruit")) {
      await page(`<select id="sel" aria-label="Fruit"><option value="a">Apple</option><option value="b">Banana</option></select>`);
      await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>');document.getElementById('dlg').showModal();true`, null, PORT);
      const r = await fill({ ...args, value: "b" });
      expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
      expect(await val("sel")).toBe("a");
      await page(`<select id="sel" aria-label="Fruit"><option value="a">Apple</option><option value="b">Banana</option></select>`);
      expect((await fill({ ...args, value: "b" })).ok).toBe(true);
      expect(await val("sel")).toBe("b");
    }
  });

  it("a custom element that takes no focus itself but holds a text control (Ionic's ion-input) is written; behind a dialog it is not", async () => {
    const def = "customElements.define('x-ion',class extends HTMLElement{connectedCallback(){if(!this.firstChild)this.innerHTML='<input>'}get value(){return this.querySelector('input').value}set value(v){this.querySelector('input').value=v}});";
    await page(`<x-ion id="xi"></x-ion>`, def);
    const r = await fill({ selector: "#xi" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await val("xi")).toBe("SPK");
    await page(`<x-ion id="xi"></x-ion>`, def);
    await evaluateInTab(`document.body.insertAdjacentHTML('beforeend','<dialog id="dlg"><input id="inner" aria-label="Inner field"></dialog>');document.getElementById('dlg').showModal();true`, null, PORT);
    expect((await fill({ selector: "#xi" })).error).toBe(NO_FOCUS);
    expect(await val("xi")).toBe("");
  });

  it("a custom element whose text control sits in its shadow root, with no delegatesFocus, is written through that control", async () => {
    await page(`<x-sr id="xr"></x-sr>`,
      "customElements.define('x-sr',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<input>';}get value(){return this.shadowRoot.querySelector('input').value}set value(v){this.shadowRoot.querySelector('input').value=v}});");
    const r = await fill({ selector: "#xr" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await val("xr")).toBe("SPK");
  });

  it("a page whose <img name=\"body\"> shadows document.body: nothing focused still reads focusAt null", async () => {
    await page(`<img name="body"><img name="documentElement">`, "document.getElementById('bg').inert=true;");
    const r = await fill({ selector: "#em" });
    expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
    expect((r.context as { focusAt?: unknown }).focusAt).toBeNull();
  });

  it("a disabled field named by selector is not written (by name it was never a target)", async () => {
    await page(`<input id="dis" aria-label="Disabled field" disabled>`);
    const r = await fill({ selector: "#dis" });
    expect(r.error, JSON.stringify(r)).toBe(DISABLED);
    expect(await val("dis")).toBe("");
    expect((await fill({ by: "ariaLabel", pattern: "Disabled field" })).code).toBe("BrowserNoActionableTarget");
    expect(await val("dis")).toBe("");
  });

  it("a custom element that says it is disabled (its own disabled property) is not written, though it takes focus", async () => {
    await page(`<x-dis id="xd" tabindex="0"></x-dis>`, "customElements.define('x-dis',class extends HTMLElement{get disabled(){return true}get value(){return this._v||''}set value(v){this._v=String(v)}});");
    const r = await fill({ selector: "#xd" });
    expect(r.error, JSON.stringify(r)).toBe(DISABLED);
    expect(await val("xd")).toBe("");
  });

  it("a field inside a <fieldset disabled> is disabled too (by name, it was never a target)", async () => {
    await page(`<fieldset disabled><input id="fd" aria-label="Fieldset field"></fieldset>`);
    const r = await fill({ selector: "#fd" });
    expect(r.error, JSON.stringify(r)).toBe(DISABLED);
    expect((await fill({ by: "ariaLabel", pattern: "Fieldset field" })).code).toBe("BrowserNoActionableTarget");
    expect(await val("fd")).toBe("");
  });

  it("a custom element that hands focus to its own input (delegatesFocus, a value property) is written", async () => {
    await focused(async () => {
      await page(`<x-field id="xf"></x-field>`,
        "customElements.define('x-field',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open',delegatesFocus:true}).innerHTML='<input>';}get value(){return this.shadowRoot.querySelector('input').value}set value(v){this.shadowRoot.querySelector('input').value=v}});");
      const r = await fill({ selector: "#xf" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await val("xf")).toBe("SPK");
    });
  });

  it("a custom element that focuses a slotted <input> of its own (Vaadin's text field) is written", async () => {
    await focused(async () => {
      await page(`<x-slot id="xs"><input id="xsi"></x-slot>`,
        "customElements.define('x-slot',class extends HTMLElement{focus(){this.querySelector('input').focus()}get value(){return this.querySelector('input').value}set value(v){this.querySelector('input').value=v}});");
      const r = await fill({ selector: "#xs" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(await val("xsi")).toBe("SPK");
    });
  });

  it("an element with a value property that takes no focus at all is not written (nothing a person can type into)", async () => {
    await page(`<x-val id="xv"></x-val>`, "customElements.define('x-val',class extends HTMLElement{get value(){return this._v||''}set value(v){this._v=String(v)}});");
    const r = await fill({ selector: "#xv" });
    expect(r.error, JSON.stringify(r)).toBe(NO_FOCUS);
    expect(await val("xv")).toBe("");
  });

  it("a part inside a contenteditable whose host masks itself as it takes focus, then replaces the part: the value is withheld (codex on #1036)", async () => {
    await focused(async () => {
      for (const args of [{ selector: "#cep" }]) {
        await page(`<div id="ce" contenteditable="true" aria-label="PIN"><p id="cep">old</p></div>`,
          "var ce=document.getElementById('ce');ce.addEventListener('focus',function(){ce.style.webkitTextSecurity='disc'});" +
          "ce.addEventListener('input',function(){var p=document.createElement('p');p.textContent='x';ce.replaceChildren(p)});");
        const r = await fill(args);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.valueWithheld).toBe("masked");
        expect(JSON.stringify(r)).not.toContain("SPK");
      }
    });
  });

  it("a contenteditable, and a part inside one, are written", async () => {
    await focused(async () => {
      await page(`<div id="ce" contenteditable="true" aria-label="Editor"><p id="cep">old</p></div>`);
      expect((await fill({ selector: "#ce" })).ok).toBe(true);
      expect(await evaluateInTab("document.getElementById('ce').textContent", null, PORT)).toBe("SPK");
      await page(`<div id="ce" contenteditable="true" aria-label="Editor"><p id="cep">old</p></div>`);
      const r = await fill({ selector: "#cep" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });
  });

  it("plain fields are written on both roads, with and without page focus", async () => {
    for (const withFocus of [false, true]) {
      const run = async () => {
        for (const args of [...ROADS("#em", "Email address"), ...ROADS("#ta", "Notes")]) {
          await page("");
          const r = await fill(args);
          expect(r.ok, JSON.stringify(r)).toBe(true);
        }
      };
      if (withFocus) await focused(run); else await run();
    }
  });
});
