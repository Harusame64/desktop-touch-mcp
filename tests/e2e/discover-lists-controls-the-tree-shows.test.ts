/**
 * internal #420 (PR-C2b) — desktop_discover's browser lane lists the controls the browser's accessibility tree shows,
 * as browser_click's by-axis road reads them since #1008: a checkbox under a skin (iCheck's opacity: 0 input), a 0x0
 * radio pressed through its label, Select2's combobox, Choices' select, a role=checkbox div. A checkbox or radio reads
 * as a button, as UIA's do; a widget's combobox is a button named by the label of the control it stands for, then the
 * value it shows; the original a widget hides from people (tabindex -1, aria-hidden) is not listed. Before this, a native
 * checkbox read "textbox" and none of these widgets were listed (win2 on #1003, #1002 note 5).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll, rememberTabPort, AX_MARK_ATTR } from "../../src/engine/cdp-bridge.js";
import { fetchBrowserCandidates, interactiveScript } from "../../src/tools/desktop-providers/browser-provider.js";
import { cdpDispatchClickAndVerify } from "../../src/tools/browser.js";

const PORT = 9239;
const CHROME = tryFindChrome() !== null;
let chrome: ChromeInstance;
let tabId = "";

beforeAll(async () => {
  if (!CHROME) return;
  chrome = await launchChrome(PORT, !process.env.HEADED, "about:blank");
  const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Array<{ id: string; type: string }>;
  tabId = tabs.find((t) => t.type === "page")!.id;
  rememberTabPort(tabId, PORT);
}, 20_000);
afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

async function page(body: string): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}</style></head><body>${body}</body></html>`;
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, tabId, PORT);
  await sleep(150);
}
type Row = { role: string; label: string; selector: string; actions: string };
async function list(): Promise<Row[]> {
  const r = await fetchBrowserCandidates({ tabId } as never);
  return r.candidates.map((c) => ({ role: c.role, label: c.label, selector: c.locator.cdp!.selector, actions: (c.actionability ?? []).join("/") }));
}
const marks = async (): Promise<number> => (await evaluateInTab("document.querySelectorAll('[data-dtm-ax]').length", tabId, PORT)) as number;
const one = async (selector: string): Promise<string> =>
  (await evaluateInTab(`(function(){var n=document.querySelectorAll(${JSON.stringify(selector)});return n.length===1?(n[0].id||n[0].className||n[0].tagName):'count:'+n.length})()`, tabId, PORT)) as string;

const ICHECK = `<div style="position:relative;display:inline-block;width:22px;height:22px;margin:40px"><input type="checkbox" id="ic" style="position:absolute;top:-20%;left:-20%;width:140%;height:140%;opacity:0;margin:0;padding:0;border:0"><ins style="position:absolute;inset:0;border:2px solid #333"></ins></div><label for="ic">Subscribe</label>`;
const SELECT2 = `<label for="fr">Fruit</label><select id="fr" tabindex="-1" aria-hidden="true" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden"><option>Apple</option><option>Banana</option></select>
  <span class="select2" style="display:inline-block;width:200px"><span class="selection"><span class="select2-selection" role="combobox" aria-haspopup="true" aria-expanded="false" tabindex="0" aria-labelledby="s2c" style="display:block;height:28px;border:1px solid #aaa"><span class="select2-selection__rendered" id="s2c" role="textbox" aria-readonly="true" title="Apple">Apple</span></span></span></span>`;
const CHOICES = `<label for="col">Colour</label><div class="wrap"><div class="choices" role="listbox" tabindex="0" aria-haspopup="true" aria-expanded="false" style="width:240px;height:40px;border:1px solid"><div class="choices__inner"><select id="col" hidden><option>Red</option></select><div class="choices__item">Red</div></div></div></div>`;

describe.skipIf(!CHROME)("desktop_discover's browser lane lists the controls the tree shows (internal #420, PR-C2b)", () => {
  it("reads a native checkbox and radio as buttons a person presses, not textboxes", async () => {
    await page(`<label><input type="checkbox" id="cb"> Accept terms</label><label><input type="radio" id="rb" name="r"> Yes</label><input id="tx" aria-label="Title">`);
    const rows = await list();
    expect(rows.find((r) => r.selector === "#cb")).toMatchObject({ role: "button", label: "Accept terms", actions: "invoke/click" });
    expect(rows.find((r) => r.selector === "#rb")).toMatchObject({ role: "button", label: "Yes" });
    expect(rows.find((r) => r.selector === "#tx")).toMatchObject({ role: "textbox", actions: "type/click" });
    expect(await marks()).toBe(0);
  });

  it("lists iCheck's opacity: 0 checkbox under its skin, and a CDP press there checks it", async () => {
    await page(ICHECK);
    const row = (await list()).find((r) => r.selector === "#ic");
    expect(row).toMatchObject({ role: "button", label: "Subscribe" });
    await cdpDispatchClickAndVerify(row!.selector, tabId, PORT);
    expect(await evaluateInTab("document.getElementById('ic').checked", tabId, PORT)).toBe(true);
  });

  it("lists a 0x0 radio pressed through its label", async () => {
    await page(`<input type="radio" name="p" id="dk" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="dk" style="display:inline-block;padding:6px 12px">Dark</label>`);
    expect((await list()).find((r) => r.selector === "#dk")).toMatchObject({ role: "button", label: "Dark" });
  });

  it("still leaves out a 0x0 radio with no label, and an opacity: 0 text field (control)", async () => {
    await page(`<input type="radio" id="z0" style="width:0;height:0;margin:0;padding:0;border:0"><input id="hp" name="email" style="opacity:0">`);
    const rows = await list();
    expect(rows.find((r) => r.selector === "#z0")).toBeUndefined();
    expect(rows.find((r) => r.selector === "#hp")).toBeUndefined();
  });

  it("lists Select2's combobox as a button named by its select's label, not its hidden select or its rendered text", async () => {
    await page(SELECT2);
    const rows = await list();
    const combo = rows.filter((r) => r.label === "Fruit");
    expect(combo).toHaveLength(1);
    expect(combo[0]).toMatchObject({ role: "button", actions: "invoke/click" });
    expect(await one(combo[0]!.selector)).toBe("select2-selection");
    expect(rows.find((r) => r.selector === "#fr")).toBeUndefined();
    expect(rows.find((r) => r.selector === "#s2c")).toBeUndefined();
  });

  it("lists Choices' select (a listbox that opens a popup) named by the label of the select it stands for, by a selector that names it alone", async () => {
    await page(`<div class="wrap"><div>first</div></div>${CHOICES}`);
    const row = (await list()).find((r) => r.label === "Colour");
    expect(row).toMatchObject({ role: "button", actions: "invoke/click" });
    expect(await one(row!.selector)).toBe("choices");
  });

  it("lists a role=checkbox div", async () => {
    await page(`<div role="checkbox" id="dc" aria-checked="false" tabindex="0" style="display:inline-block;padding:4px">Remember me</div>`);
    expect((await list()).find((r) => r.selector === "#dc")).toMatchObject({ role: "button", label: "Remember me" });
  });

  it("keeps a plain list as before when the tree adds nothing (links and buttons)", async () => {
    await page(`<a href="#a" id="la">Home</a><button id="bb">Save</button>`);
    const rows = await list();
    expect(rows.find((r) => r.selector === "#la")).toMatchObject({ role: "link", label: "Home" });
    expect(rows.find((r) => r.selector === "#bb")).toMatchObject({ role: "button", label: "Save" });
    expect(await marks()).toBe(0);
  });

  it("reads a native checkbox as a toggle even when the tree could not be read (no marks)", async () => {
    await page(`<label><input type="checkbox" id="cb"> Accept terms</label>`);
    const rows = (await evaluateInTab(interactiveScript(null), tabId, PORT)) as Array<{ type: string; selector: string }>;
    expect(rows.find((r) => r.selector === "#cb")?.type).toBe("toggle[checkbox]");
  });

  // ── /code-review high on #1009 ───────────────────────────────────────────────────────────────────────────────
  it("keeps an unnamed checkbox (a table's row-select box) under its type and selector", async () => {
    await page(`<table><tr><td><input type="checkbox" id="row1"></td><td>Alice</td></tr></table>`);
    expect((await list()).find((r) => r.selector === "#row1")).toMatchObject({ role: "button", label: "toggle[checkbox] #row1" });
  });

  it("does not offer typing into a div the tree calls a textbox (the CDP fill writes only to inputs)", async () => {
    await page(`<div role="textbox" contenteditable="true" tabindex="0" aria-label="Comment" id="ce" style="width:200px;height:40px;border:1px solid"></div>`);
    expect((await list()).find((r) => r.selector === "#ce")).toBeUndefined();
  });

  it("names two Select2 boxes showing the same placeholder by their selects' labels, so they stay two", async () => {
    const box = (id: string, label: string): string => `<label for="${id}">${label}</label><select id="${id}" tabindex="-1" aria-hidden="true" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden"><option></option></select><span class="select2" style="display:inline-block;width:200px"><span class="selection"><span class="select2-selection" role="combobox" aria-haspopup="true" aria-expanded="false" tabindex="0" aria-labelledby="${id}-c" style="display:block;height:28px;border:1px solid #aaa"><span id="${id}-c" role="textbox" aria-readonly="true">Select an option</span></span></span></span>`;
    await page(`<div>${box("country", "Country")}</div><div>${box("billing", "Billing country")}</div>`);
    const rows = (await list()).filter((r) => r.role === "button");
    expect(rows.map((r) => r.label).sort()).toEqual(["Billing country", "Country"]);
    const c = await fetchBrowserCandidates({ tabId } as never);
    expect(c.candidates.find((x) => x.label === "Country")?.value).toBe("Select an option");
  });

  it("keeps the text field inside an ARIA 1.0 combobox as a textbox", async () => {
    await page(`<div role="combobox" aria-expanded="false" aria-haspopup="listbox" style="display:inline-block"><input type="text" id="q" aria-label="Search" aria-autocomplete="list"></div>`);
    expect((await list()).find((r) => r.selector === "#q")).toMatchObject({ role: "textbox", actions: "type/click" });
  });

  it("gives each radio of a group a selector that names it alone (they share a name)", async () => {
    await page(`<label><input type="radio" name="size" value="S"> S</label><label><input type="radio" name="size" value="M"> M</label>`);
    const rows = await list();
    const m = rows.find((r) => r.label === "M")!;
    expect(m.selector).not.toBe('input[name="size"]');
    expect(await evaluateInTab(`document.querySelectorAll(${JSON.stringify(m.selector)}).length===1 && document.querySelector(${JSON.stringify(m.selector)}).value`, tabId, PORT)).toBe("M");
  });

  it("does not lean on an id two elements share: the selector still names the element alone", async () => {
    await page(`<div id="opts"><span>a</span><div role="listbox" tabindex="0" aria-haspopup="true" aria-label="First" style="width:100px;height:20px"></div></div><div id="opts"><span>b</span><div role="listbox" tabindex="0" aria-haspopup="true" aria-label="Second" style="width:100px;height:20px"></div></div>`);
    const sel = (await list()).find((r) => r.label === "Second")!.selector;
    expect(await evaluateInTab(`document.querySelectorAll(${JSON.stringify(sel)}).length===1 && document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-label')`, tabId, PORT)).toBe("Second");
  });

  it("does not list a div slider it could not press", async () => {
    await page(`<div role="slider" id="vol" aria-label="Volume" tabindex="0" aria-valuenow="5" style="width:100px;height:10px;background:#ccc"></div>`);
    expect((await list()).find((r) => r.selector === "#vol")).toBeUndefined();
  });

  it("marks more than a by-axis question's 200 when the page has more checkboxes (discover reads the whole page)", async () => {
    await page(Array.from({ length: 260 }, (_, i) => `<input type="checkbox" aria-label="c${i}">`).join(""));
    const { markAxMatches, clearAxMarks } = await import("../../src/engine/cdp-bridge.js");
    expect(await markAxMatches({ by: "controls", pattern: "", caseSensitive: false, nonce: "cap" }, tabId, PORT)).toBe(260);
    await clearAxMarks("cap", tabId, PORT);
  });

  it("names the attribute the page-side list reads as the one the tree marks with", () => {
    expect(interactiveScript("n0nce")).toContain(`[${AX_MARK_ATTR}*=`);
  });
});
