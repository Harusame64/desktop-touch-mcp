/**
 * internal #420 — while a modal <dialog> is open, the browser's accessibility tree gives the page behind it no name and
 * no role (ignoredReasons activeModalDialog), so by:'role' / by:'ariaLabel' read no match there. A control named only
 * by the tree (aria-labelledby, its <label>) read as "nothing matches" with the dialog open. The answer now says the
 * dialog is open and what the tree leaves out; it does not say the target is behind it (nothing counted that).
 *
 * A stop is asked through browser_click / browser_fill, and the page's record shows nothing was pressed or written.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll, clearAxMarks } from "../../src/engine/cdp-bridge.js";
import { resolveBrowserActionTarget } from "../../src/tools/browser-resolver.js";
import { browserClickElementHandler, browserFillInputHandler } from "../../src/tools/browser.js";

const PORT = 9244;
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

// The page behind: a button named by aria-labelledby, a field named by its <label>, a native checkbox. `open` is the
// script that opens the dialog (showModal, show, or none).
async function page(open: string, dialog = `<dialog id="dlg"><p>Hello</p><button id="close">Close</button></dialog>`): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<span id="lb">Settings</span><button id="set" aria-labelledby="lb">*</button>` +
    `<label for="em">Email</label><input id="em"><input type="checkbox" id="cb">${dialog}` +
    `<script>window.__pressed=[];document.addEventListener('click',function(e){var t=e.target.closest('[id]');window.__pressed.push(t?t.id:'?')},true);${open}</script></body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, null, PORT);
  await sleep(150);
}
const pressed = async (): Promise<string[]> => (await evaluateInTab("window.__pressed", null, PORT)) as string[];
const SHOW_MODAL = "document.getElementById('dlg').showModal();";

function payload(r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = r.content[0]?.type === "text" ? r.content[0].text ?? "{}" : "{}";
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { text }; }
}
async function click(args: Record<string, unknown>) {
  return payload(await browserClickElementHandler({ port: PORT, includeContext: false, ...args } as Parameters<typeof browserClickElementHandler>[0]));
}
async function fill(args: Record<string, unknown>) {
  return payload(await browserFillInputHandler({ port: PORT, includeContext: false, value: "x", ...args } as Parameters<typeof browserFillInputHandler>[0]));
}
// The one fact the answer adds: the tree the axis reads leaves out the page behind the dialog.
const note = (by: string) => ` A modal dialog is open: the browser's accessibility tree, which by:'${by}' reads, leaves out the page behind it.`;
// The element browser_click would press (a press itself needs the Windows engine): its id, or the outcome's kind.
async function presses(args: { by: "role" | "ariaLabel"; pattern: string; scope?: string }): Promise<string> {
  const o = await resolveBrowserActionTarget({ ...args, action: "click", requireReceivesEvents: true, port: PORT, tabId: null });
  if (o.kind === "resolved" && o.axMark !== undefined) await clearAxMarks(o.axMark, null, PORT);
  return o.kind === "resolved" ? `#${o.matched.id ?? ""}` : o.kind;
}

describe.skipIf(!CHROME)("a modal dialog hides the page behind it from the tree (internal #420)", () => {
  it("by:'ariaLabel' for a button named by aria-labelledby behind the dialog says the dialog is open", async () => {
    await page(SHOW_MODAL);
    const r = await click({ by: "ariaLabel", pattern: "Settings" });
    expect(r.code, JSON.stringify(r)).toBe("BrowserNoActionableTarget");
    expect(r.error).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
    // No step to take: the control may be in the dialog, with the pattern wrong, and closing it can lose a form.
    expect(r.suggest).toEqual(["Check the pattern and the axis: browser_search with the same by/pattern lists what matches, and browser_overview lists the page's controls"]);
    expect((r.context as { behindModal?: boolean }).behindModal).toBe(true);
    expect(await pressed()).toEqual([]);
  });

  it("browser_fill by:'ariaLabel' for a field named by its <label> behind the dialog says the same, and writes nothing", async () => {
    await page(SHOW_MODAL);
    const f = await fill({ by: "ariaLabel", pattern: "Email" });
    expect(f.error, JSON.stringify(f)).toBe(`browser_fill: nothing matches.${note("ariaLabel")} Nothing was done.`);
    expect(await evaluateInTab("document.getElementById('em').value", null, PORT)).toBe("");
  });

  it("by:'role' for a native checkbox behind the dialog says the same", async () => {
    await page(SHOW_MODAL);
    const r = await click({ by: "role", pattern: "checkbox" });
    expect(r.error, JSON.stringify(r)).toBe(`browser_click: nothing matches.${note("role")} Nothing was done.`);
    expect(await pressed()).toEqual([]);
  });

  it("with the dialog closed the same controls are found: the note is about the dialog, not the name", async () => {
    await page("");
    expect(await presses({ by: "ariaLabel", pattern: "Settings" })).toBe("#set");
    expect(await presses({ by: "role", pattern: "checkbox" })).toBe("#cb");
    const r = await click({ by: "ariaLabel", pattern: "No such name" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: nothing matches. Nothing was done.");
    expect((r.context as { behindModal?: boolean }).behindModal).toBeUndefined();
    const f = await fill({ by: "ariaLabel", pattern: "Email", value: "a@b" });
    expect(f.ok, JSON.stringify(f)).toBe(true);
  });

  it("a search scoped inside the open dialog leaves the note out: nothing there is hidden from the tree", async () => {
    await page(SHOW_MODAL);
    const r = await click({ by: "ariaLabel", pattern: "Settings", scope: "#dlg" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: nothing matches. Nothing was done.");
    expect((r.context as { behindModal?: boolean }).behindModal).toBeUndefined();
  });

  it("a search scoped to an element that holds the dialog keeps the note: part of it lies behind", async () => {
    await page(SHOW_MODAL);
    const r = await click({ by: "ariaLabel", pattern: "Settings", scope: "body" });
    expect(r.error, JSON.stringify(r)).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
  });

  it("by:'text' reads the page itself, so its answer leaves the note out", async () => {
    await page(SHOW_MODAL);
    const r = await click({ by: "text", pattern: "No such words" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: nothing matches. Nothing was done.");
  });

  it("a dialog opened with show() (not modal) leaves the page in the tree, and the note out", async () => {
    await page("document.getElementById('dlg').show();");
    const r = await click({ by: "ariaLabel", pattern: "No such name" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: nothing matches. Nothing was done.");
    const f = await fill({ by: "ariaLabel", pattern: "Email", value: "a@b" });
    expect(f.ok, JSON.stringify(f)).toBe(true);
  });

  it("an aria-modal div leaves the page in the tree: the control behind it is found, and the dialog blocks it", async () => {
    await page("", `<div role="dialog" aria-modal="true" id="am" style="position:fixed;inset:0;background:#fff"><button id="x">X</button></div>`);
    const r = await click({ by: "ariaLabel", pattern: "Settings" });
    expect(r.code, JSON.stringify(r)).toBe("BrowserModalBlocking");
    expect(await pressed()).toEqual([]);
  });

  it("two stacked modal dialogs: the lower one is behind the top one, which holds the focus", async () => {
    const two = `<dialog id="d1"><button id="b1">One</button></dialog><dialog id="d2"><button id="b2">Two</button></dialog>`;
    const open = "document.getElementById('d1').showModal();document.getElementById('d2').showModal();";
    await page(open, two);
    const low = await click({ by: "ariaLabel", pattern: "One", scope: "#d1" });
    expect(low.error, JSON.stringify(low)).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
    const top = await click({ by: "ariaLabel", pattern: "No such name", scope: "#d2" });
    expect(top.error, JSON.stringify(top)).toBe("browser_click: nothing matches. Nothing was done.");
    expect(await presses({ by: "ariaLabel", pattern: "Two", scope: "#d2" })).toBe("#b2");
  });

  it("a page that shadows document.activeElement in the lower of two dialogs does not make that one the top", async () => {
    await page(
      "document.getElementById('d1').showModal();document.getElementById('d2').showModal();",
      `<dialog id="d1"><img name="activeElement"><button id="b1">One</button></dialog><dialog id="d2"><button id="b2">Two</button></dialog>`,
    );
    const low = await click({ by: "ariaLabel", pattern: "One", scope: "#d1" });
    expect(low.error, JSON.stringify(low)).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
  });

  it("a modal dialog inside a web component's shadow root is found through its host", async () => {
    const comp = `<x-dlg id="host"></x-dlg>`;
    const open = "customElements.define('x-dlg', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({mode:'open'}); r.innerHTML = '<dialog><button>Shadow close</button></dialog>'; r.querySelector('dialog').showModal(); } });";
    await page(open, comp);
    const r = await click({ by: "ariaLabel", pattern: "Settings" });
    expect(r.error, JSON.stringify(r)).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
    // A scope on the host holds the dialog: inside it, nothing is said.
    const inHost = await click({ by: "ariaLabel", pattern: "No such name", scope: "#host" });
    expect(inHost.error, JSON.stringify(inHost)).toBe("browser_click: nothing matches. Nothing was done.");
  });

  it("a light-DOM control slotted into a web component's dialog holds the focus: the dialog is found through the slot", async () => {
    const comp = `<x-slot id="host"><button id="ok">OK</button></x-slot>`;
    const open = "customElements.define('x-slot', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({mode:'open'}); r.innerHTML = '<dialog><slot></slot></dialog>'; r.querySelector('dialog').showModal(); document.getElementById('ok').focus(); } });";
    await page(open, comp);
    expect(await evaluateInTab("document.activeElement.id", null, PORT)).toBe("ok");
    const r = await click({ by: "ariaLabel", pattern: "Settings" });
    expect(r.error, JSON.stringify(r)).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
  });

  it("with the focus out of the dialog, a single open modal dialog stands for it, past a page that shadows document.activeElement", async () => {
    await page(SHOW_MODAL + "Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get.call(document).blur();", `<img name="activeElement"><dialog id="dlg"><p>Text only</p></dialog>`);
    expect(await evaluateInTab("Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get.call(document) === document.body && document.activeElement.tagName === 'IMG'", null, PORT)).toBe(true);
    const r = await click({ by: "ariaLabel", pattern: "Settings" });
    expect(r.error, JSON.stringify(r)).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
  });

  it("a match the DOM reading counted behind the dialog (an aria-label) is stated with the fact, which does not deny it", async () => {
    await page(SHOW_MODAL, `<button id="hs" aria-label="Save" style="opacity:0">S</button><dialog id="dlg"><button id="close">Close</button></dialog>`);
    const r = await click({ by: "ariaLabel", pattern: "Save" });
    expect(r.error, JSON.stringify(r)).toBe(`browser_click: 1 match(es), none to act on: 1 hidden (no box, or display/visibility/opacity hides it).${note("ariaLabel")} Nothing was done.`);
    expect((r.context as { behindModal?: boolean }).behindModal).toBe(true);
  });
});
