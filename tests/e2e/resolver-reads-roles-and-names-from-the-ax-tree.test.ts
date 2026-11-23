/**
 * internal #420 (PR-C2a) — browser_click / browser_fill by:'role' and by:'ariaLabel' read the browser's own
 * accessibility tree (CDP), not a hand-rolled reading of roles and names. The spike on #420 measured the tree right on
 * every shape here, real Select2 / Choices / iCheck included; PR #1007's hand-rolled reading kept growing edges.
 *
 * Hand-built copies of the libraries' DOM (no CDN). The presses are measured on Windows (win2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll, markAxMatches, clearAxMarks, getScrollAncestorsCdp } from "../../src/engine/cdp-bridge.js";
import { resolveBrowserActionTarget, type ResolveActionOutcome } from "../../src/tools/browser-resolver.js";
import { browserClickElementHandler, readPressLanding, browserFillInputHandler } from "../../src/tools/browser.js";
import { buildPressPointJs, buildCoverJs, buildSaveScrollJs } from "../../src/tools/press-landing.js";

const PORT = 9238;
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
type A = { by: "text" | "role" | "ariaLabel"; pattern: string; role?: string };
const resolve = (a: A, gate = true, action: "click" | "fill" = "click"): Promise<ResolveActionOutcome> =>
  resolveBrowserActionTarget({ ...a, action, requireReceivesEvents: gate, port: PORT, tabId: null });
const what = (o: ResolveActionOutcome): string => (o.kind === "resolved" ? `${o.matched.tag}#${o.matched.id ?? ""}` : o.kind);
const marks = async (): Promise<number> => (await evaluateInTab("document.querySelectorAll('[data-dtm-ax]').length", null, PORT)) as number;

const SR = `<input type="checkbox" id="terms" class="sr"><label for="terms" style="position:absolute;left:100px;top:100px">Accept terms</label>`;
const ICHECK = `<div style="position:absolute;left:100px;top:200px;width:22px;height:22px"><input type="checkbox" id="ic" style="position:absolute;opacity:0;margin:0"><ins style="position:absolute;inset:0;border:2px solid #333"></ins></div><label for="ic" style="position:absolute;left:130px;top:200px">Subscribe</label>`;
const SELECT2 = `<label for="fruit" style="position:absolute;left:100px;top:270px">Fruit</label><select id="fruit" class="sr" tabindex="-1" aria-hidden="true"><option>Apple</option><option>Banana</option></select>
  <span class="select2" style="position:absolute;left:100px;top:300px;width:240px"><span class="select2-selection" id="s2" role="combobox" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-labelledby="select2-fruit-container" style="display:block;height:28px;border:1px solid #aaa"><span id="select2-fruit-container" role="textbox" aria-readonly="true">Apple</span></span></span>`;
const CHOICES = `<div class="choices" id="ch" role="combobox" tabindex="0" aria-haspopup="true" aria-expanded="false" style="position:absolute;left:100px;top:400px;width:240px;height:30px;border:1px solid #aaa"><select id="flavour" hidden><option>Vanilla</option></select><div class="choices__item">Vanilla</div></div>`;

describe.skipIf(!CHROME)("by:'role' and by:'ariaLabel' read the accessibility tree (internal #420)", () => {
  it("finds an sr-only checkbox by the name its <label> gives it, and by role", async () => {
    await page(SR);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Accept terms" }, false))).toBe("input#terms");
    expect(what(await resolve({ by: "role", pattern: "checkbox" }, false))).toBe("input#terms");
  });

  it("finds iCheck's opacity: 0 checkbox under its skin, by role and by its label's name", async () => {
    await page(ICHECK);
    expect(what(await resolve({ by: "role", pattern: "checkbox" }, false))).toBe("input#ic");
    expect(what(await resolve({ by: "ariaLabel", pattern: "Subscribe" }, false))).toBe("input#ic");
  });

  it("resolves Select2's combobox by role, never the aria-hidden native select", async () => {
    await page(SELECT2);
    expect(what(await resolve({ by: "role", pattern: "combobox" }))).toBe("span#s2");
    expect(what(await resolve({ by: "role", pattern: "combobox" }, false))).toBe("span#s2");
  });

  it("finds Select2's combobox, never its aria-hidden native select, by the select's label (W12)", async () => {
    await page(SELECT2);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit" }, false))).toBe("span#s2");
  });

  it("finds Choices' select by the label of the select it hides, and presses it (win2 on #1008, W12)", async () => {
    const CH = `<label for="fr2" style="position:absolute;left:100px;top:60px">Fruit</label><div class="choices" id="chw" role="listbox" tabindex="0" aria-haspopup="true" aria-expanded="false" style="position:absolute;left:100px;top:100px;width:260px;height:40px;border:1px solid"><div class="choices__inner"><select id="fr2" hidden tabindex="-1"><option>Apple</option></select><div>Apple</div></div></div>`;
    await page(CH);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit" }))).toBe("div#chw");
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit", role: "listbox" }))).toBe("div#chw");
    await page(CH); // the resolves above leave their marks for a caller; the click starts clean
    const r = await browserClickElementHandler({ by: "ariaLabel", pattern: "Fruit", port: PORT } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; ok?: boolean };
    expect(await marks()).toBe(0);
    if (body.ok !== true) expect(["BrowserNoActionableTarget", "BrowserAmbiguousTarget", "BrowserPointCovered"]).not.toContain(body.code);
  });

  it("does not lend a hidden select's label to a widget that is not drawn for it (control)", async () => {
    await page(`<label for="hs">Country</label><select id="hs" hidden><option>JP</option></select><div class="row"><div><div><div><div><div role="combobox" id="other" tabindex="0" aria-label="State" style="position:absolute;left:100px;top:100px;width:200px;height:28px;border:1px solid">--</div></div></div></div></div></div>`);
    expect((await resolve({ by: "ariaLabel", pattern: "Country" })).kind).not.toBe("resolved");
    expect(await marks()).toBe(0);
  });

  // ── /code-review high on #1010 ───────────────────────────────────────────────────────────────────────────────
  it("does not lend a merely hidden select's label to a combobox right after it (another field)", async () => {
    await page(`<label for="ct">Country</label><select id="ct" hidden></select><div role="combobox" tabindex="0" aria-label="State" style="position:absolute;left:100px;top:100px;width:200px;height:28px;border:1px solid">--</div>`);
    expect((await resolve({ by: "ariaLabel", pattern: "Country" })).kind).not.toBe("resolved");
  });

  it("names a select by its label's own words, not the options of the select it wraps", async () => {
    await page(`<label>Fruit <div role="listbox" id="wf" tabindex="0" aria-haspopup="true" style="display:inline-block;width:200px;height:30px;border:1px solid"><select hidden><option>Apple</option><option>Banana</option></select>Apple</div></label>`);
    const o = await resolve({ by: "ariaLabel", pattern: "Fruit" });
    expect(what(o)).toBe("div#wf");
    expect(await evaluateInTab("document.getElementById('wf').getAttribute('data-dtm-ax').split(':')[1]", null, PORT)).toBe("0.95");
    await page(`<label>Fruit <div role="listbox" id="wf" tabindex="0" aria-haspopup="true" style="display:inline-block;width:200px;height:30px;border:1px solid"><select hidden><option>Apple</option><option>Banana</option></select>Apple</div></label>`);
    expect((await resolve({ by: "ariaLabel", pattern: "Banana" })).kind).not.toBe("resolved");
  });

  it("keeps the tree's better mark on a widget named exactly so, when its select's label only contains the pattern", async () => {
    await page(`<label for="fb2">Fruit basket</label><div role="combobox" id="wn" aria-label="Fruit" tabindex="0" style="position:absolute;left:100px;top:100px;width:200px;height:30px;border:1px solid"><select id="fb2" hidden></select></div>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit" }))).toBe("div#wn");
    expect(await evaluateInTab("document.getElementById('wn').getAttribute('data-dtm-ax').split(' ').length + ':' + document.getElementById('wn').getAttribute('data-dtm-ax').split(':')[1]", null, PORT)).toBe("1:0.95");
  });

  it("does not make a listbox with no popup pressable by lending it a name (a press there picks an option)", async () => {
    await page(`<label for="tp">Toppings</label><div role="listbox" id="lt" tabindex="0" style="position:absolute;left:100px;top:100px;width:200px"><select id="tp" hidden multiple></select><div role="option">Cheese</div><div role="option">Ham</div></div>`);
    expect((await resolve({ by: "ariaLabel", pattern: "Toppings" })).kind).not.toBe("resolved");
  });

  it("lends a Select2 select's aria-label too", async () => {
    await page(`<select aria-label="Fruit" tabindex="-1" aria-hidden="true" style="position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden"></select><span class="select2"><span class="selection"><span role="combobox" id="s2a" tabindex="0" aria-haspopup="true" style="display:block;width:200px;height:28px;border:1px solid"><span role="textbox" aria-readonly="true">Apple</span></span></span></span>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit" }))).toBe("span#s2a");
  });

  it("keeps a shown select found by its own label (it is in the tree; nothing is lent)", async () => {
    await page(`<label for="vs" style="position:absolute;left:100px;top:60px">Size</label><select id="vs" style="position:absolute;left:100px;top:100px"><option>M</option></select>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Size" }))).toBe("select#vs");
  });

  it("lends a label only inside the scope asked for", async () => {
    await page(`<div id="a"><label for="fa">Fruit</label><div role="listbox" id="wa" tabindex="0" aria-haspopup="true" style="position:absolute;left:100px;top:100px;width:200px;height:30px;border:1px solid"><select id="fa" hidden></select>A</div></div><div id="b"><label for="fb">Fruit</label><div role="listbox" id="wb" tabindex="0" aria-haspopup="true" style="position:absolute;left:100px;top:200px;width:200px;height:30px;border:1px solid"><select id="fb" hidden></select>B</div></div>`);
    expect((await resolve({ by: "ariaLabel", pattern: "Fruit" })).kind).toBe("ambiguous");
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit", scope: "#b" } as never))).toBe("div#wb");
  });

  it("resolves a Choices-style combobox by role, not its hidden select", async () => {
    await page(CHOICES);
    expect(what(await resolve({ by: "role", pattern: "combobox" }))).toBe("div#ch");
  });

  it("finds a plain select by role combobox (control)", async () => {
    await page(`<select id="plain" style="position:absolute;left:100px;top:100px"><option>One</option></select>`);
    expect(what(await resolve({ by: "role", pattern: "combobox" }))).toBe("select#plain");
  });

  it("does not offer a native multi-row select for a listbox press (a press picks the option under the centre)", async () => {
    await page(`<select multiple size="4" id="m" style="position:absolute;left:100px;top:100px"><option selected>a</option><option selected>b</option><option>c</option></select>`);
    expect((await resolve({ by: "role", pattern: "listbox" })).kind).not.toBe("resolved");
  });

  it("reads input types as ARIA does: a search field is a searchbox, not a textbox", async () => {
    await page(`<input type="search" id="s" aria-label="Find" style="position:absolute;left:100px;top:100px">`);
    expect((await resolve({ by: "role", pattern: "textbox" })).kind).not.toBe("resolved");
    expect(what(await resolve({ by: "role", pattern: "searchbox" }))).toBe("input#s");
  });

  it("finds both a native checkbox with an explicit role and a div role=checkbox (both are checkboxes: ambiguous)", async () => {
    await page(`<input type="checkbox" role="checkbox" aria-label="A" style="position:absolute;left:100px;top:100px"><div role="checkbox" aria-checked="false" tabindex="0" style="position:absolute;left:100px;top:200px">B</div>`);
    expect((await resolve({ by: "role", pattern: "checkbox" })).kind).toBe("ambiguous");
  });

  it("names a Search field and a Search button alike, and role narrows them", async () => {
    await page(`<label for="q" class="sr">Search</label><input id="q" type="search" style="position:absolute;left:100px;top:100px"><button aria-label="Search" id="go" style="position:absolute;left:300px;top:100px">Go</button>`);
    expect((await resolve({ by: "ariaLabel", pattern: "Search" })).kind).toBe("ambiguous");
    expect(what(await resolve({ by: "ariaLabel", pattern: "Search", role: "button" }))).toBe("button#go");
  });

  it("reads a name from aria-labelledby ids split by a newline", async () => {
    await page(`<span id="first">Ship</span><span id="last">status</span><input type="checkbox" id="ss" aria-labelledby="first
      last" style="position:absolute;left:100px;top:100px">`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Ship status" }))).toBe("input#ss");
  });

  it("matches a part of a name (containing), as the attribute match did", async () => {
    await page(`<button aria-label="Save draft now" id="sd" style="position:absolute;left:100px;top:100px">S</button>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "draft" }))).toBe("button#sd");
  });

  it("leaves by:'text' on DOM text: a link stays unique beside a form label that shares its words (control)", async () => {
    await page(`<label for="pw" style="position:absolute;left:100px;top:100px">Password</label><input id="pw" type="password" style="position:absolute;left:200px;top:100px"><a href="/reset" id="forgot" style="position:absolute;left:100px;top:200px">Forgot password?</a>`);
    expect(what(await resolve({ by: "text", pattern: "password" }))).toBe("a#forgot");
  });

  it("leaves no marks in the page after a resolve that stops, or a click", async () => {
    await page(SR);
    await resolve({ by: "role", pattern: "radio" });
    expect(await marks()).toBe(0);
    await browserClickElementHandler({ by: "ariaLabel", pattern: "Accept terms", port: PORT } as never);
    expect(await marks()).toBe(0);
  });

  it("leaves no marks when the click stops before marking its target (a match off the screen)", async () => {
    await page(`<div style="height:3000px"></div><input type="checkbox" id="far" aria-label="Far away">`);
    const r = await browserClickElementHandler({ by: "ariaLabel", pattern: "Far away", port: PORT } as never);
    expect((r.content[0] as { text: string }).text).toContain("ElementNotInViewport");
    expect(await marks()).toBe(0);
  });

  it("takes browser_click by:'ariaLabel' on the sr-only checkbox to a press (its label), not a stop (#1006 X2a)", async () => {
    await page(SR);
    const r = await browserClickElementHandler({ by: "ariaLabel", pattern: "Accept terms", port: PORT } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; ok?: boolean };
    if (body.ok === true) return; // a machine that can press
    expect(body.code).not.toBe("BrowserNoActionableTarget");
    expect(body.code).not.toBe("BrowserPointCovered");
  });

  it("fills by role textbox the one text field, and leaves no marks", async () => {
    await page(`<input type="text" id="t" aria-label="Title" style="position:absolute;left:100px;top:100px">`);
    const { browserFillInputHandler } = await import("../../src/tools/browser.js");
    const r = await browserFillInputHandler({ by: "role", pattern: "textbox", value: "hello", port: PORT } as never);
    expect((r.content[0] as { text: string }).text).toContain('"ok":true');
    expect(await evaluateInTab("document.getElementById('t').value", null, PORT)).toBe("hello");
    expect(await marks()).toBe(0);
  });

  // ── /code-review on #1008 ─────────────────────────────────────────────────────────────────────────────────────
  it("does not see a 0x0 or opacity: 0 honeypot text field: the one visible field is filled", async () => {
    await page(`<input type="email" id="em" aria-label="Email" style="position:absolute;left:100px;top:100px"><input type="text" id="hp" name="website" style="opacity:0;position:absolute;width:0;height:0">`);
    expect(what(await resolve({ by: "role", pattern: "textbox" }, false, "fill"))).toBe("input#em");
  });

  it("does not take three collapsed 0x0 radios for one target", async () => {
    await page(`<input type="radio" name="p" id="r0" aria-label="Light" style="position:absolute;width:0;height:0;margin:0"><input type="radio" name="p" id="r1" aria-label="Dark" style="position:absolute;width:0;height:0;margin:0"><input type="radio" name="p" id="r2" aria-label="System" style="position:absolute;width:0;height:0;margin:0">`);
    expect((await resolve({ by: "role", pattern: "radio" }, false)).kind).not.toBe("resolved");
  });

  it("lets an equal name win over names that contain it", async () => {
    await page(`<input id="em" aria-label="Email" style="position:absolute;left:100px;top:100px"><button id="up" style="position:absolute;left:100px;top:200px">Email me updates</button>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Email" }))).toBe("input#em");
  });

  it("asks the tree inside the scope, so a scope's matches are not lost to a page full of others", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `<a href="#a${i}">Top ${i}</a> `).join("");
    await page(`<div>${many}</div><footer id="footer" style="position:fixed;left:0;bottom:0"><a href="#imprint" id="imp">Imprint</a></footer>`);
    expect(what(await resolve({ by: "role", pattern: "link", scope: "#footer" } as A))).toBe("a#imp");
  });

  it("marks nothing inside a shadow root (the gather cannot see it, and nothing could clear it)", async () => {
    await page(`<div id="host"></div><button id="light" aria-label="Go" style="position:absolute;left:100px;top:200px">Go</button><script>var r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button aria-label="Go">Go</button>';</script>`);
    await resolve({ by: "ariaLabel", pattern: "Go" });
    expect(await evaluateInTab("document.getElementById('host').shadowRoot.querySelector('button').hasAttribute('data-dtm-ax')", null, PORT)).toBe(false);
  });

  it("keeps the DOM reading when the tree finds nothing (a control under a misused aria-hidden, as before)", async () => {
    await page(`<div aria-hidden="true"><button id="x" aria-label="Close panel" style="position:absolute;left:100px;top:100px">x</button></div>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Close panel" }))).toBe("button#x");
  });

  it("filters by the role the browser computes: a plain select named Fruit is role combobox", async () => {
    await page(`<label for="f" style="position:absolute;left:100px;top:80px">Fruit</label><select id="f" style="position:absolute;left:100px;top:100px"><option>Apple</option></select>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit", role: "combobox" }))).toBe("select#f");
  });

  it("keeps two calls' marks on the same element apart: neither overwrites the other (/code-review on #1009)", async () => {
    await page(`<button aria-label="One" style="position:absolute;left:100px;top:100px">1</button>`);
    expect(await markAxMatches({ by: "ariaLabel", pattern: "One", caseSensitive: false, nonce: "aaa" }, null, PORT)).toBe(1);
    expect(await markAxMatches({ by: "role", pattern: "button", caseSensitive: false, nonce: "bbb" }, null, PORT)).toBe(1);
    expect(await evaluateInTab("document.querySelector('button').getAttribute('data-dtm-ax').split(' ').map(function(t){return t.split(':')[0]})", null, PORT)).toEqual(["aaa", "bbb"]);
    await clearAxMarks("aaa", null, PORT);
    expect(await evaluateInTab("document.querySelector('button').getAttribute('data-dtm-ax').split(':')[0]", null, PORT)).toBe("bbb");
    await clearAxMarks("bbb", null, PORT);
    expect(await marks()).toBe(0);
  });

  it("clears only its own marks: another call's marks on the tab stay", async () => {
    await page(`<button aria-label="One" style="position:absolute;left:100px;top:100px">1</button><button aria-label="Two" style="position:absolute;left:200px;top:100px">2</button>`);
    expect(await markAxMatches({ by: "ariaLabel", pattern: "One", caseSensitive: false, nonce: "aaa" }, null, PORT)).toBe(1);
    expect(await markAxMatches({ by: "ariaLabel", pattern: "Two", caseSensitive: false, nonce: "bbb" }, null, PORT)).toBe(1);
    await clearAxMarks("aaa", null, PORT);
    expect(await evaluateInTab("Array.from(document.querySelectorAll('[data-dtm-ax]')).map(function(n){return n.getAttribute('data-dtm-ax').split(':')[0]})", null, PORT)).toEqual(["bbb"]);
    await clearAxMarks("bbb", null, PORT);
    expect(await marks()).toBe(0);
  });

  it("sees 0x0 radios through their shown labels, tells them apart, and picks the one named (MkDocs' palette toggle)", async () => {
    await page(`<form><input type="radio" name="p" id="p0" style="position:absolute;width:0;height:0;margin:0;opacity:0"><label for="p0" style="position:absolute;left:100px;top:100px">Light</label>
      <input type="radio" name="p" id="p1" style="position:absolute;width:0;height:0;margin:0;opacity:0"><label for="p1" style="position:absolute;left:200px;top:100px">Dark</label>
      <input type="radio" name="p" id="p2" style="position:absolute;width:0;height:0;margin:0;opacity:0"><label for="p2" style="position:absolute;left:300px;top:100px">System</label></form>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Dark" }, false))).toBe("input#p1");
    expect((await resolve({ by: "role", pattern: "radio" }, false)).kind).toBe("ambiguous");
  });

  it("sees a select a widget replaces (opacity 0, with a box), so the landing read can press the widget (Choices)", async () => {
    await page(`<label for="fl" style="position:absolute;left:100px;top:80px">Flavour</label><select id="fl" style="position:absolute;left:100px;top:100px;width:200px;opacity:0"><option>Vanilla</option></select><div role="combobox" tabindex="0" style="position:absolute;left:100px;top:100px;width:200px;height:24px;border:1px solid">Vanilla</div>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Flavour" }, false))).toBe("select#fl");
  });

  it("finds where to press a 0x0 radio: its own label (the landing read no longer stops at its zero size)", async () => {
    await page(`<input type="radio" name="p" id="z" style="position:absolute;width:0;height:0;margin:0;opacity:0"><label for="z" style="position:absolute;left:200px;top:100px">Dark</label>`);
    await evaluateInTab("document.getElementById('z').setAttribute('data-t','1');true", null, PORT);
    expect(await readPressLanding("[data-t]", null, PORT)).toMatchObject({ how: "own_label" });
  });

  it("takes browser_click on a 0x0 radio named by its label to a press through the label, not a stop (win2 on #1008, W11)", async () => {
    await page(`<input type="radio" name="c" id="g0" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="g0" style="display:inline-block;padding:6px 12px;margin:40px 4px">Red</label><input type="radio" name="c" id="g1" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="g1" style="display:inline-block;padding:6px 12px">Green</label>`);
    const r = await browserClickElementHandler({ by: "ariaLabel", pattern: "Green", role: "radio", port: PORT } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; ok?: boolean };
    expect(await marks()).toBe(0);
    if (body.ok === true) return; // a machine that can press
    expect(body.code).not.toBe("BrowserNoActionableTarget");
    expect(body.code).not.toBe("BrowserPointCovered");
  });

  it("answers several 0x0 radios pressed through their labels as ambiguous, not as none actionable (win2 on #1008, W11a)", async () => {
    await page(`<input type="radio" name="c" id="g0" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="g0" style="display:inline-block;padding:6px 12px;margin:40px 4px">Red</label><input type="radio" name="c" id="g1" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="g1" style="display:inline-block;padding:6px 12px">Green</label>`);
    const r = await browserClickElementHandler({ by: "role", pattern: "radio", port: PORT } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; context?: { total?: number } };
    expect(body.code).toBe("BrowserAmbiguousTarget");
    expect(body.context?.total).toBe(2);
    expect(await marks()).toBe(0);
  });

  it("names ambiguity candidates as a person reads them: an aria-label over the text, a widget by its select's label (internal #420)", async () => {
    const cand = async (a: { by: string; pattern: string; role?: string }) => {
      const r = await browserClickElementHandler({ ...a, port: PORT } as never);
      const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; context?: { candidates?: Array<{ name: string }> } };
      expect(body.code).toBe("BrowserAmbiguousTarget");
      return (body.context?.candidates ?? []).map((c) => c.name).sort();
    };
    // Listed by their text, both read "X" (seen on main): the names a person hears are "Close dialog" and "Close panel".
    await page(`<button aria-label="Close dialog" style="margin:40px">X</button><button aria-label="Close panel">X</button>`);
    expect(await cand({ by: "role", pattern: "button" })).toEqual(["Close dialog", "Close panel"]);
    // A name from aria-labelledby, by ids holding an "s" and listing two: the ids are split on whitespace.
    await page(`<span id="ss-a">Save</span><span id="ss-b">settings</span><button aria-labelledby="ss-a ss-b" style="margin:40px">S</button><span id="sx">Send</span><button aria-labelledby="sx">S</button>`);
    expect(await cand({ by: "role", pattern: "button" })).toEqual(["Save settings", "Send"]);
    // Two Select2 widgets found through the labels their hidden selects lend: listed with an empty name before.
    const s2 = (id: string, label: string, top: number) => `<label for="${id}" style="position:absolute;left:100px;top:${top}px">${label}</label><select id="${id}" class="sr" tabindex="-1" aria-hidden="true"><option>Apple</option></select><span class="select2" style="position:absolute;left:100px;top:${top + 30}px;width:240px"><span class="select2-selection" role="combobox" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-labelledby="r-${id}" style="display:block;height:28px;border:1px solid #aaa"><span id="r-${id}" role="textbox" aria-readonly="true"></span></span></span>`;
    // Both only contain the pattern: an equal name would win alone (#1008).
    await page(s2("f1", "Fruit kind", 100) + s2("f2", "Fruit colour", 200));
    expect(await cand({ by: "ariaLabel", pattern: "Fruit" })).toEqual(["Fruit colour", "Fruit kind"]);
    // A select named by aria-label lends that name too, and a role written "Combobox" is still a widget's.
    const s2a = (id: string, label: string, top: number) => `<select id="${id}" aria-label="${label}" class="sr" tabindex="-1" aria-hidden="true"><option>Apple</option></select><span class="select2" style="position:absolute;left:100px;top:${top}px;width:240px"><span class="select2-selection" role="combobox" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-labelledby="r-${id}" style="display:block;height:28px;border:1px solid #aaa"><span id="r-${id}" role="textbox" aria-readonly="true"></span></span></span>`;
    await page(s2a("g1", "Veg kind", 100) + s2a("g2", "Veg colour", 200));
    expect(await cand({ by: "ariaLabel", pattern: "Veg" })).toEqual(["Veg colour", "Veg kind"]);
    expect(await marks()).toBe(0);
  });

  it("reads a 0x0 radio pressed through its own label as receiving events, a covered one as not (internal #420)", async () => {
    // Listed with receivesEvents:false although a press on its label reaches it, as browser_click presses it.
    await page(`<input type="radio" name="c" id="z0" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="z0" style="display:inline-block;padding:6px 12px;margin:40px 4px">Zero</label>
      <input type="radio" name="c" id="p1" style="margin:20px"><label for="p1">Plain</label>
      <div style="position:relative;display:inline-block;margin:20px"><input type="radio" name="c" id="cv" aria-label="Covered"><div style="position:absolute;inset:-4px;background:#fff"></div></div>
      <div style="position:relative;display:inline-block;margin:20px"><input type="radio" name="c" id="zc" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="zc" style="display:inline-block;padding:6px 12px">Label covered</label><div style="position:absolute;inset:0;background:#fff"></div></div>`);
    // As browser_click asks first (no occlusion gate), so no press is made here.
    const o = await resolve({ by: "role", pattern: "radio" }, false);
    expect(o.kind).toBe("ambiguous");
    const cands = o.kind === "ambiguous" ? o.candidates : [];
    // receivesEvents stays the centre test the gate used; viaLabel says a press on its own label reaches it, so a
    // refusal and its list agree (/code-review on #1018). A label under a cover is not a way in.
    const got = Object.fromEntries(cands.map((c) => [c.name, [c.actionability.receivesEvents, c.actionability.viaLabel ?? false]]));
    expect(got).toEqual({ Zero: [false, true], Plain: [true, false], Covered: [false, false], "Label covered": [false, false] });
    // Shown, never the gate: the strict pass still refuses the 0x0 radio, so browser_click's loose pass and landing
    // read press its label, not its own 0x0 point (/code-review on #1018).
    expect((await resolve({ by: "ariaLabel", pattern: "Zero", role: "radio" }, true)).kind).toBe("noActionable");
    // A resolved answer leaves its mark for the caller to clear, as browser_click does.
    const loose = await resolve({ by: "ariaLabel", pattern: "Zero", role: "radio" }, false);
    expect(loose.kind).toBe("resolved");
    if (loose.kind === "resolved" && loose.axMark !== undefined) await clearAxMarks(loose.axMark, null, PORT);
    expect(await marks()).toBe(0);
  });

  it("still gathers on a page that shadows closest: the label probe's failure leaves viaLabel unsaid (/code-review on #1018)", async () => {
    // A click-through label over a form whose control is named "closest": the probe's hit is the form, and
    // form.closest is that control.
    await page(`<form id="f" style="padding:40px"><input name="closest" aria-label="Closest field"><input type="radio" id="zr" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="zr" style="display:inline-block;padding:6px 12px;pointer-events:none">Zed</label></form>`);
    const o = await resolve({ by: "role", pattern: "radio" }, false);
    expect(o.kind).toBe("resolved");
    if (o.kind === "resolved" && o.axMark !== undefined) await clearAxMarks(o.axMark, null, PORT);
    expect(await marks()).toBe(0);
  });

  it("reads a press point and a cover on a page that shadows closest, matches and contains (win2 on #1018)", async () => {
    // A click-through label sends the hit test to the <form>, whose closest, matches and contains are its controls:
    // the press rule threw "hit.closest is not a function" on main and failed the click with ToolError.
    await page(`<form id="fc" style="padding:40px"><input name="closest"><input name="matches"><input name="contains"><input type="radio" id="rc" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="rc" style="display:inline-block;padding:6px 12px;pointer-events:none">Closest radio</label></form>`);
    expect(await evaluateInTab("typeof document.getElementById('fc').closest", null, PORT)).toBe("object");
    const point = (await evaluateInTab(buildPressPointJs("#rc"), null, PORT)) as Record<string, unknown>;
    expect(point.error ?? null).toBeNull();
    const cover = (await evaluateInTab(buildCoverJs("#rc"), null, PORT)) as Record<string, unknown> | null;
    // The hit is the form, which holds the radio (typeof null is "object", so the value is asked for).
    expect(cover).toMatchObject({ container: true });
    // A real by-axis click reaches the press rule through the gather, which climbs to the form and called
    // form.contains (/code-review on #1019): it resolves now, and a text search over the form's words works.
    const o = await resolve({ by: "role", pattern: "radio" }, false);
    expect(o.kind).toBe("resolved");
    if (o.kind === "resolved" && o.axMark !== undefined) await clearAxMarks(o.axMark, null, PORT);
    // A text hit on the form itself: its own words, so the text axes judge the form (notDrawnText on it).
    await evaluateInTab(`document.getElementById('fc').insertAdjacentText('afterbegin', 'Shadowing form words ');true`, null, PORT);
    const t = await resolve({ by: "text", pattern: "Shadowing form words" }, false);
    expect(t.kind === "error" ? t.message : t.kind).not.toMatch(/is not a function/);
    expect(t.kind).not.toBe("error");
    expect(await marks()).toBe(0);
  });

  it("answers on a page whose form has controls named parentElement and querySelectorAll (win2 on #1019)", async () => {
    // form.parentElement is the input and the input's parent is the form again: every walk up the tree looped and
    // the page script hung until the CDP timeout (main too). form.querySelectorAll is an input: the press rule threw.
    for (const lab of ["", "pointer-events:none"]) {
      await page(`<form id="fp" style="padding:40px"><input name="parentElement"><input name="querySelectorAll"><input type="radio" id="rp" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="rp" style="display:inline-block;padding:6px 12px;${lab}">Parent radio</label></form>`);
      expect(await evaluateInTab("document.getElementById('fp').parentElement.tagName", null, PORT)).toBe("INPUT");
      const o = await resolve({ by: "role", pattern: "radio" }, false);
      expect(o.kind).toBe("resolved");
      if (o.kind === "resolved" && o.axMark !== undefined) await clearAxMarks(o.axMark, null, PORT);
      const point = (await evaluateInTab(buildPressPointJs("#rp"), null, PORT)) as Record<string, unknown>;
      expect(point.error ?? null).toBeNull();
      // The scroll saved before a press walks every ancestor: on main it ran until the 15 s CDP timeout here.
      expect(await evaluateInTab(buildSaveScrollJs("#rp"), null, PORT)).toBe(true);
      // The cover read answers with what is at the point: the label, or the form under a click-through one.
      const cover = (await evaluateInTab(buildCoverJs("#rp"), null, PORT)) as { cover?: unknown } | null;
      expect(typeof cover?.cover).toBe("string");
      expect(await marks()).toBe(0);
    }
  }, 60_000);

  it("reads an element's scroll ancestors inside a form with a control named parentNode (/code-review on #1020)", async () => {
    // form.parentNode is the input, and the walk (smart scroll) ran to the CDP timeout: nothing scrolls, so depth
    // never rose.
    await page(`<form id="fn"><input name="parentNode"><div id="tn">target</div></form>`);
    expect(await evaluateInTab("document.getElementById('fn').parentNode.tagName", null, PORT)).toBe("INPUT");
    const t0 = Date.now();
    const r = await getScrollAncestorsCdp("#tn", null, PORT);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(Array.isArray((r as { ancestors?: unknown[] }).ancestors)).toBe(true);
  }, 60_000);

  it("does not guess one of several radios a person can each press: two are pressed through their labels (win2 on #1018)", async () => {
    // main pressed the plain radio: the strict pass saw only it pass the centre test.
    const z = (id: string, t: string) => `<input type="radio" name="g" id="${id}" style="width:0;height:0;margin:0;padding:0;border:0;appearance:none"><label for="${id}" style="display:inline-block;padding:6px 12px;margin:20px">${t}</label>`;
    await page(z("ga", "Alpha") + z("gb", "Beta") + `<input type="radio" name="g" id="gp" style="margin:20px"><label for="gp">Plain</label>`);
    const o = await resolve({ by: "role", pattern: "radio" });
    expect(o.kind).toBe("ambiguous");
    // A checkbox shown beside an sr-only one with a label: two choices, not the shown one alone.
    await page(`<input type="checkbox" id="srx" class="sr"><label for="srx" style="display:inline-block;margin:40px">Accept terms</label><input type="checkbox" id="shown" style="margin:20px"><label for="shown">Subscribe</label>`);
    expect((await resolve({ by: "role", pattern: "checkbox" })).kind).toBe("ambiguous");
    // A widget drawn over the hidden select it stands for, which has its own <label>: one control a person sees
    // (/code-review on #1022).
    await page(`<label for="fl2" style="position:absolute;left:100px;top:80px">Flavour</label><select id="fl2" style="position:absolute;left:100px;top:100px;width:200px;opacity:0"><option>Vanilla</option></select><div role="combobox" id="cb2" tabindex="0" style="position:absolute;left:100px;top:100px;width:200px;height:30px;background:#fff;border:1px solid">Vanilla</div>`);
    const w = await resolve({ by: "role", pattern: "combobox" });
    expect(what(w)).toBe("div#cb2");
    if (w.kind === "resolved" && w.axMark !== undefined) await clearAxMarks(w.axMark, null, PORT);
    // One plain radio and a covered one: still the plain one alone.
    await page(`<input type="radio" name="h" id="hp" style="margin:20px"><label for="hp">Plain</label><div style="position:relative;display:inline-block;margin:20px"><input type="radio" name="h" id="hc" aria-label="Covered"><div style="position:absolute;inset:-4px;background:#fff"></div></div>`);
    const one = await resolve({ by: "role", pattern: "radio" });
    expect(one.kind).toBe("resolved");
    if (one.kind === "resolved" && one.axMark !== undefined) await clearAxMarks(one.axMark, null, PORT);
    expect(await marks()).toBe(0);
  });

  it("points a fill on a choice at choosing, not at role:'textbox' (internal #420)", async () => {
    const fill = async (a: { by: "ariaLabel"; pattern: string }) => {
      const r = await browserFillInputHandler({ ...a, value: "Banana", port: PORT, includeContext: false } as never);
      return JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; suggest?: string[] };
    };
    // Select2's combobox, found by the label its hidden select lends: a widget that opens a list.
    await page(SELECT2);
    const w = await fill({ by: "ariaLabel", pattern: "Fruit" });
    expect(w.code).toBe("BrowserNoActionableTarget");
    expect(w.suggest?.[0]).toMatch(/^A choice widget/);
    // A native <select> found by its name is set in one call, by the selector road's pick rule (the user's decision
    // after #1024): by an option's value, or by the shown text of one option; a value no option has is refused untouched.
    await page(`<label for="ns">Size</label><select id="ns" style="margin:40px"><option value="s">Small</option><option value="m">Medium</option></select>`);
    const byAxis = async (value: string) => JSON.parse(((await browserFillInputHandler({ by: "ariaLabel", pattern: "Size", value, port: PORT, includeContext: false } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { ok?: boolean; code?: string; chose?: string };
    expect((await byAxis("m")).ok).toBe(true);
    expect(await evaluateInTab("document.getElementById('ns').value", null, PORT)).toBe("m");
    expect(await byAxis("Small")).toMatchObject({ ok: true, chose: "s" });
    expect((await byAxis("Large")).code).toBe("InvalidArgs");
    expect(await evaluateInTab("document.getElementById('ns').value", null, PORT)).toBe("s");
    // As the selector road (/code-review on #1025): a re-pick fires nothing; a refusal leaves focus where it was; a
    // focus handler that rebuilds the list does not move the choice to another option; a mask put on at focus holds.
    await evaluateInTab(`(function(){var s=document.getElementById('ns');window.ch=0;s.addEventListener('change',function(){window.ch++});document.body.insertAdjacentHTML('beforeend','<input id="other" style="margin:40px">');document.getElementById('other').focus();return true})()`, null, PORT);
    expect((await byAxis("Huge")).code).toBe("InvalidArgs");
    expect(await evaluateInTab("JSON.stringify([document.activeElement.id, window.ch])", null, PORT)).toBe(JSON.stringify(["other", 0]));
    expect((await byAxis("s")).ok).toBe(true);
    expect(await evaluateInTab("window.ch", null, PORT)).toBe(0);
    await page(`<label for="rb">Tier</label><select id="rb" style="margin:40px"><option value="b">Bronze</option><option value="g">Gold</option></select>`);
    // Headless Chrome fires no focus event (the page has no focus), so what a focus handler does is put in focus() itself.
    await evaluateInTab(`(function(){var s=document.getElementById('rb');s.focus=function(){HTMLElement.prototype.focus.call(this);if(!this.querySelector('option[value=""]'))this.insertAdjacentHTML('afterbegin','<option value="">Choose…</option>');};return true})()`, null, PORT);
    const rb = JSON.parse(((await browserFillInputHandler({ by: "ariaLabel", pattern: "Tier", value: "g", port: PORT, includeContext: false } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { ok?: boolean };
    expect(rb.ok).toBe(true);
    expect(await evaluateInTab("JSON.stringify([document.getElementById('rb').value, document.getElementById('rb').options.length])", null, PORT)).toBe(JSON.stringify(["g", 3]));
    // A focus that changes the asked-for option's value: the pick again after focus no longer finds it, refused unset
    // (codex on #1025).
    await page(`<label for="cv">Plan</label><select id="cv" style="margin:40px"><option value="a">Alpha</option><option value="c">Charlie</option></select>`);
    await evaluateInTab(`(function(){var s=document.getElementById('cv');s.focus=function(){HTMLElement.prototype.focus.call(this);this.options[1].value='d';};return true})()`, null, PORT);
    const cvr = JSON.parse(((await browserFillInputHandler({ by: "ariaLabel", pattern: "Plan", value: "c", port: PORT, includeContext: false } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { ok?: boolean; code?: string };
    expect(cvr.code).toBe("InvalidArgs");
    expect(await evaluateInTab("document.getElementById('cv').value", null, PORT)).toBe("a");
    await page(`<label for="pm">PIN</label><select id="pm" style="margin:40px"><option value="k1">Key one</option><option value="k2">Key two</option></select>`);
    // Masked at focus, and replaced by its change handler: the detached element reads unmasked after the events, so only
    // the read right after focus withholds the value (/code-review on #1025).
    await evaluateInTab(`(function(){var s=document.getElementById('pm');s.focus=function(){HTMLElement.prototype.focus.call(this);this.style.setProperty('-webkit-text-security','disc');};s.addEventListener('change',function(e){var n=e.target.cloneNode(true);n.id='pm2';e.target.replaceWith(n);});return true})()`, null, PORT);
    const pm = (await browserFillInputHandler({ by: "ariaLabel", pattern: "PIN", value: "Key two", port: PORT, includeContext: false } as never)).content[0] as { text: string };
    expect(pm.text).not.toContain("k2");
    // A select a person does not see stands behind a widget (Choices): the widget's next steps, not the select's.
    await page(`<label for="hs">Flavour</label><select id="hs" style="position:absolute;opacity:0;width:200px"><option value="v">Vanilla</option></select><span role="combobox" tabindex="0" style="display:inline-block;margin-left:220px">Vanilla</span>`);
    expect((await fill({ by: "ariaLabel", pattern: "Flavour" })).suggest?.[0]).toMatch(/^A choice widget/);
    // A button that opens a list (Headless UI / MUI: aria-haspopup, no role attribute): a choice widget.
    await page(`<button aria-haspopup="listbox" aria-label="Country" style="margin:40px">Japan</button>`);
    expect((await fill({ by: "ariaLabel", pattern: "Country" })).suggest?.[0]).toMatch(/^A choice widget/);
    // MUI v4's select: a div role=button with aria-haspopup, which the tree still calls a button.
    await page(`<div role="button" tabindex="0" aria-haspopup="listbox" aria-label="Region" style="margin:40px">Kanto</div>`);
    expect((await fill({ by: "ariaLabel", pattern: "Region" })).suggest?.[0]).toMatch(/^A choice widget/);
    // An option itself, in a list shown as it is.
    await page(`<div role="listbox" aria-label="Colours" tabindex="0" style="margin:40px"><div role="option" aria-selected="false" tabindex="-1">Red</div><div role="option" aria-selected="false" tabindex="-1">Green</div></div>`);
    expect((await fill({ by: "ariaLabel", pattern: "Red" } as never)).suggest?.[0]).toMatch(/^An option is pressed/);
    // A toggle is pressed; something named a text field that takes no text is not sent back to role textbox; an option
    // of a listbox select is the select's (/code-review on #1023).
    await page(`<input type="checkbox" aria-label="Accept terms" style="margin:40px">`);
    expect((await fill({ by: "ariaLabel", pattern: "Accept terms" })).suggest?.[0]).toMatch(/^A checkbox, radio or switch/);
    await page(`<div role="textbox" tabindex="0" aria-label="Notes" style="margin:40px;width:200px;height:40px;border:1px solid">x</div>`);
    expect((await fill({ by: "ariaLabel", pattern: "Notes" })).suggest?.[0]).toMatch(/^It is named a text field/);
    await page(`<select multiple aria-label="Fruits" style="margin:40px"><option value="b">Banana</option><option value="c">Cherry</option></select>`);
    expect((await fill({ by: "text", pattern: "Banana" } as never)).suggest?.[0]).toMatch(/^A multiple-choice <select>/);
    // Anything else: a neutral next step, no role named.
    await page(`<button style="margin:40px">Send</button>`);
    expect((await fill({ by: "ariaLabel", pattern: "Send" })).suggest?.[0]).toMatch(/^The match takes no text/);
    expect(await marks()).toBe(0);
  });

  it("does not type into a read-only input that is a choice widget, on either road (internal #420, /code-review on #1023)", async () => {
    const out = async (a: Record<string, unknown>) => JSON.parse(((await browserFillInputHandler({ ...a, value: "Banana", port: PORT, includeContext: false } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { ok?: boolean; code?: string; suggest?: string[] };
    const val = () => evaluateInTab("document.getElementById('ro').value", null, PORT);
    // Vuetify / MUI: a read-only input the tree calls a combobox. On main both roads wrote "Banana" and said delivered.
    // Refused before focus moves: focus stays where it was.
    const RO = `<label for="ro">Fruit</label><input id="ro" role="combobox" readonly aria-expanded="false" value="Apple" style="margin:40px"><button id="other" style="margin:40px">Other</button>`;
    for (const a of [{ selector: "#ro" }, { by: "ariaLabel", pattern: "Fruit" }]) {
      await page(RO);
      await evaluateInTab("document.getElementById('other').focus();true", null, PORT);
      const r = await out(a);
      expect(r.code).toBe("BrowserNoActionableTarget");
      expect(r.suggest?.[0]).toMatch(/^A choice widget/);
      expect(await val()).toBe("Apple");
      expect(await evaluateInTab("document.activeElement.id", null, PORT)).toBe("other");
    }
    // Ant Design: the read-only search input inside the selector, which opens a listbox; no role on the input itself.
    await page(`<div class="ant-select" role="combobox" aria-haspopup="listbox" style="margin:40px"><span><input id="ro" readonly value="Apple"></span></div>`);
    expect((await out({ selector: "#ro" })).code).toBe("BrowserNoActionableTarget");
    expect(await val()).toBe("Apple");
    // Vuetify 3's v-select (win2 on #1027, R2): the input asks for no keyboard (inputmode=none, not read-only), and the
    // combobox is the field around it. On the PR's first head it was written and its text cleared.
    await page(`<div class="v-field" role="combobox" aria-haspopup="listbox" style="margin:40px"><div class="v-select__selection">Apple</div><input id="ro" inputmode="none" aria-label="Open" value="Apple"></div>`);
    expect((await out({ selector: "#ro" })).code).toBe("BrowserNoActionableTarget");
    expect(await val()).toBe("Apple");
    // The box around Ant's input (.ant-select-selector) is the widget's: the widget's next steps, not "name the field"
    // (R5b). A box holding two widgets, or a widget and a text field, is not one widget (controls).
    const ANT = (id: string) => `<div class="ant-select-selector" id="${id}"><span><input role="combobox" readonly aria-haspopup="listbox" value="Apple"></span><span>Apple</span></div>`;
    await page(`<div style="margin:40px">${ANT("box")}</div>`);
    expect((await out({ selector: "#box" })).suggest?.[0]).toMatch(/^A choice widget/);
    await page(`<div id="two" style="margin:40px">${ANT("a")}${ANT("b")}</div>`);
    expect((await out({ selector: "#two" })).suggest?.[0]).toMatch(/^The match takes no text/);
    await page(`<div id="mix" style="margin:40px">${ANT("a")}<input id="nm2"></div>`);
    expect((await out({ selector: "#mix" })).suggest?.[0]).toMatch(/^The match takes no text/);
    // Read-only only to assistive technology (aria-readonly): the same.
    await page(`<label for="ro">Fruit</label><input id="ro" role="combobox" aria-readonly="true" value="Apple" style="margin:40px">`);
    expect((await out({ selector: "#ro" })).code).toBe("BrowserNoActionableTarget");
    expect((await out({ by: "ariaLabel", pattern: "Fruit" })).code).toBe("BrowserNoActionableTarget");
    expect(await val()).toBe("Apple");
    // A page that makes it read-only when it takes focus is caught after focus, before the write, on both roads; the
    // answer says it took focus.
    for (const a of [{ selector: "#ro" }, { by: "ariaLabel", pattern: "Fruit" }]) {
      await page(`<label for="ro">Fruit</label><input id="ro" role="combobox" value="Apple" style="margin:40px">`);
      await evaluateInTab(`(function(){var i=document.getElementById('ro');i.focus=function(){HTMLElement.prototype.focus.call(this);this.readOnly=true;};return true})()`, null, PORT);
      const r = await out(a) as { code?: string; error?: string };
      expect(r.code).toBe("BrowserNoActionableTarget");
      expect(r.error).toMatch(/read-only input of a choice widget.*took focus/);
      expect(await val()).toBe("Apple");
    }
    // role:'textbox' does not count it as a text field (the tree calls it a combobox): the one name field is filled.
    await page(`<label for="nm">Name</label><input id="nm" style="margin:40px"><label for="ro">Fruit</label><input id="ro" role="combobox" readonly value="Apple" style="margin:40px">`);
    expect((await out({ by: "role", pattern: "textbox" })).ok).toBe(true);
    expect(await evaluateInTab("document.getElementById('nm').value", null, PORT)).toBe("Banana");
    // The selector road no longer reports a value set on an element that holds none (a div widget's box): refused with
    // the widget's steps. A contenteditable takes its text, as on the by-axis road; a custom element with a value
    // property still takes the value (controls).
    await page(`<div id="aw" role="combobox" aria-haspopup="listbox" tabindex="0" style="margin:40px">Apple</div>`);
    const aw = await out({ selector: "#aw" });
    expect(aw.code).toBe("BrowserNoActionableTarget");
    expect(aw.suggest?.[0]).toMatch(/^A choice widget/);
    expect(await evaluateInTab("'value' in document.getElementById('aw')", null, PORT)).toBe(false);
    await page(`<div id="ce" contenteditable="true" style="margin:40px">old</div>`);
    expect((await out({ selector: "#ce" })).ok).toBe(true);
    expect(await evaluateInTab("document.getElementById('ce').textContent", null, PORT)).toBe("Banana");
    // It takes focus, as Shoelace's and Material Web's do: browser_fill types only into what holds focus (internal #420).
    await page(`<x-field id="xf" tabindex="0" style="display:block;margin:40px"></x-field>`);
    await evaluateInTab(`(function(){customElements.define('x-field', class extends HTMLElement { get value(){return this._v||''} set value(v){this._v=String(v)} });return true})()`, null, PORT);
    expect((await out({ selector: "#xf" })).ok).toBe(true);
    expect(await evaluateInTab("document.getElementById('xf').value", null, PORT)).toBe("Banana");
    // Controls, unchanged: a combobox a person types into (an autocomplete) is filled on both roads, and a read-only
    // input that opens no list is written as before on a page without focus (headless), which says pageFocused:false
    // (internal #420: its focus handler, which may lift readonly, has not run).
    for (const a of [{ selector: "#ro" }, { by: "ariaLabel", pattern: "Fruit" }]) {
      await page(`<label for="ro">Fruit</label><input id="ro" role="combobox" aria-autocomplete="list" value="" style="margin:40px">`);
      expect((await out(a)).ok).toBe(true);
      expect(await val()).toBe("Banana");
    }
    await page(`<label for="ro">Fruit</label><input id="ro" readonly value="Apple" style="margin:40px">`);
    const roOut = await out({ selector: "#ro" }) as { ok?: boolean; pageFocused?: boolean };
    expect(roOut.ok).toBe(true);
    expect(roOut.pageFocused).toBe(false);
    expect(await marks()).toBe(0);
  });

  it("sets a native select as a person picks an option, and leaves it alone otherwise (internal #420, /code-review on #1024)", async () => {
    // A value no option has used to clear the choice (selectedIndex -1) and fire change (measured on #1023).
    await page(`<input id="em" aria-label="Email" style="margin:40px"><select id="sz" onchange="window.ch=(window.ch||0)+1" style="margin:40px"><option value="s">Small</option><option value="m" selected>Medium</option><option value="l" label="Large">L size</option><option value="d1">Same</option><option value="d2">Same</option><option value="x" disabled>Sold out</option><option value="2">1</option><option value="1">One</option></select>
      <select id="mu" multiple style="margin:40px"><option value="a" selected>A</option><option value="b" selected>B</option></select>
      <select id="hid" style="position:absolute;opacity:0"><option value="v">Vanilla</option></select>`);
    const set = async (sel: string, value: string) => JSON.parse(((await browserFillInputHandler({ selector: sel, value, port: PORT, includeContext: false } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { ok?: boolean; code?: string; chose?: string; actual?: string };
    const state = async () => evaluateInTab("JSON.stringify([document.getElementById('sz').value, window.ch||0, document.activeElement && document.activeElement.id])", null, PORT);
    expect((await set("#sz", "s")).ok).toBe(true);
    expect(await state()).toBe(JSON.stringify(["s", 1, "sz"]));
    // By shown text, the label attribute when there is one; actual is the option's value, said as chose.
    expect(await set("#sz", "Large")).toMatchObject({ ok: true, actual: "l", chose: "l" });
    expect(await set("#sz", "Medium")).toMatchObject({ ok: true, chose: "m" });
    expect(await state()).toBe(JSON.stringify(["m", 3, "sz"]));
    // A re-pick of the chosen option fires nothing.
    expect((await set("#sz", "m")).ok).toBe(true);
    expect(await state()).toBe(JSON.stringify(["m", 3, "sz"]));
    // Refused, untouched, and focus left where it was: no option, repeated text, disabled, value one and text another.
    await evaluateInTab("document.getElementById('em').focus();true", null, PORT);
    for (const [v, code] of [["Huge", "InvalidArgs"], ["Same", "InvalidArgs"], ["Sold out", "BrowserNoActionableTarget"], ["1", "InvalidArgs"]] as const) {
      expect((await set("#sz", v)).code).toBe(code);
    }
    expect(await state()).toBe(JSON.stringify(["m", 3, "em"]));
    // A multiple-choice select keeps its choices.
    expect((await set("#mu", "a")).code).toBe("BrowserNoActionableTarget");
    expect(await evaluateInTab("Array.from(document.getElementById('mu').selectedOptions).map(function(o){return o.value}).join()", null, PORT)).toBe("a,b");
    // An opacity:0 select with no widget in its place (over a styled label) is set as it is (/code-review on #1024).
    expect((await set("#hid", "v")).ok).toBe(true);
    // Refused untouched: a select a widget stands in for (Choices holds it), one in a disabled fieldset, a hidden option.
    await page(`<div role="combobox" tabindex="0" style="margin:40px"><select id="inw" style="opacity:0"><option value="a">A</option><option value="b">B</option></select><span>A</span></div>
      <fieldset disabled><select id="fs"><option value="a">A</option><option value="b">B</option></select></fieldset>
      <select id="ho"><option value="" hidden>Choose…</option><option value="a">A</option></select>`);
    expect((await set("#inw", "b")).code).toBe("BrowserNoActionableTarget");
    expect((await set("#fs", "b")).code).toBe("BrowserNoActionableTarget");
    expect((await set("#ho", "Choose…")).code).toBe("InvalidArgs");
    // A value whose own option shows it, beside another option showing it: ambiguous (codex on #1024).
    await evaluateInTab(`document.body.insertAdjacentHTML('beforeend', '<select id="vs" style="margin:40px"><option value="x">X</option><option value="Same">Same</option><option value="other">Same</option></select>');true`, null, PORT);
    expect((await set("#vs", "Same")).code).toBe("InvalidArgs");
    expect(await evaluateInTab("document.getElementById('vs').value", null, PORT)).toBe("x");
    // A shown select followed by an unrelated widget is its own control (codex on #1024).
    await evaluateInTab(`document.body.insertAdjacentHTML('beforeend', '<div><select id="cty" style="margin:40px"><option value="jp">Japan</option><option value="fr">France</option></select><span role="combobox" tabindex="0">State</span></div>');true`, null, PORT);
    expect((await set("#cty", "fr")).ok).toBe(true);
    expect(await evaluateInTab("[document.getElementById('inw').value, document.getElementById('fs').value].join()", null, PORT)).toBe("a,a");
    // A change handler that drops the placeholder: the kept option, not an index read after it, decides delivery.
    await page(`<select id="ph" style="margin:40px"><option value="">Choose…</option><option value="s">Small</option><option value="m">Medium</option></select>`);
    await evaluateInTab(`document.getElementById('ph').addEventListener('change', function(e){ var o=e.target.querySelector('option[value=""]'); if (o) o.remove(); });true`, null, PORT);
    expect(await set("#ph", "s")).toMatchObject({ ok: true, actual: "s" });
    // A page that sets the choice back: not kept, said so, not called a controlled-input transform.
    await page(`<select id="rv" style="margin:40px"><option value="m">Medium</option><option value="l">Large</option></select>`);
    await evaluateInTab(`document.getElementById('rv').addEventListener('change', function(e){ e.target.value='m'; });true`, null, PORT);
    const rv = JSON.parse(((await browserFillInputHandler({ selector: "#rv", value: "Large", port: PORT, includeContext: false } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as Record<string, unknown>;
    expect(JSON.stringify(rv)).toContain("value_not_retained");
    expect(JSON.stringify(rv)).toContain('"chose":"l"');
    // A select the page masks: chosen, and its value not echoed.
    await page(`<select id="pin" style="-webkit-text-security:disc;margin:40px"><option value="k1">Key one</option><option value="k2">Key two</option></select>`);
    const m = await set("#pin", "Key two");
    expect(m.ok).toBe(true);
    expect(JSON.stringify(m)).not.toContain("k2");
    expect(await evaluateInTab("document.getElementById('pin').value", null, PORT)).toBe("k2");
  });

  it("presses Choices' select as it is: a listbox that opens a popup is a control (win2 on #1008, W6)", async () => {
    await page(`<div class="choices" id="chl" role="listbox" tabindex="0" aria-haspopup="true" aria-expanded="false" style="position:absolute;left:100px;top:100px;width:260px;height:40px;border:1px solid"><div class="choices__inner"><select id="fr" hidden><option>Apple</option></select><div class="choices__item">Apple</div></div><div class="choices__list--dropdown" style="visibility:hidden"><div role="listbox"><div role="option">Apple</div><div role="option">Banana</div></div></div></div>`);
    expect(what(await resolve({ by: "role", pattern: "listbox" }))).toBe("div#chl");
  });

  it("still leaves a list of options (a listbox with no popup) for a press on an option (control)", async () => {
    await page(`<div role="listbox" id="lb" tabindex="0" aria-label="Fruits" style="position:absolute;left:100px;top:100px;width:200px"><div role="option">Apple</div><div role="option">Banana</div></div>`);
    expect((await resolve({ by: "role", pattern: "listbox" })).kind).not.toBe("resolved");
  });

  // ── /code-review high on #1008 (47116a56) ───────────────────────────────────────────────────────────────────────
  it("keeps a button whose name contains the pattern when the equal name is a heading the role filter drops", async () => {
    await page(`<h2 style="position:absolute;left:100px;top:40px">Settings</h2><button id="os" aria-label="Open settings" style="position:absolute;left:100px;top:120px">⚙</button>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Settings", role: "button" }))).toBe("button#os");
    expect(await marks()).toBeGreaterThan(0); // resolved: the caller clears
  });

  it("finds the field whose name contains the pattern beside a heading named exactly so, with no role given", async () => {
    await page(`<h2 style="position:absolute;left:100px;top:40px">Email</h2><input id="ea" aria-label="Email address" style="position:absolute;left:100px;top:120px">`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Email" }))).toBe("input#ea");
  });

  it("keeps a containing name when the equal name is hidden (a collapsed copy)", async () => {
    await page(`<button aria-label="Menu" style="position:absolute;left:100px;top:40px;opacity:0">≡</button><button id="om" aria-label="Open menu" style="position:absolute;left:100px;top:120px">≡</button>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Menu" }))).toBe("button#om");
  });

  it("fills a search field by its name with role textbox, as before (its attribute reading still counts)", async () => {
    await page(`<input type="search" id="sf" aria-label="Search" style="position:absolute;left:100px;top:100px"><input type="text" id="sh" aria-label="Search history" style="position:absolute;left:100px;top:160px">`);
    const { browserFillInputHandler } = await import("../../src/tools/browser.js");
    const r = await browserFillInputHandler({ by: "ariaLabel", pattern: "Search", role: "textbox", value: "cats", port: PORT } as never);
    expect((r.content[0] as { text: string }).text).toContain('"ok":true');
    expect(await evaluateInTab("document.getElementById('sf').value", null, PORT)).toBe("cats");
    expect(await marks()).toBe(0);
  });

  it("takes the tree's answer alone when it has one: a copy under aria-hidden does not make the click ambiguous (browser_search merges; a click does not)", async () => {
    await page(`<div aria-hidden="true"><button id="c" aria-label="Close" style="position:absolute;left:10px;top:10px">×</button></div><button id="d" style="position:absolute;left:100px;top:100px">Close</button>`);
    expect(what(await resolve({ by: "role", pattern: "button" }))).toBe("button#d");
  });

  it("keeps the DOM reading when every mark is filtered out (a hidden element the tree names, a button under aria-hidden)", async () => {
    await page(`<button aria-label="Close" style="position:absolute;left:100px;top:40px;opacity:0">x</button><div aria-hidden="true"><button id="cl" aria-label="Close" style="position:absolute;left:100px;top:120px">x</button></div>`);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Close" }))).toBe("button#cl");
  });

  it("marks nothing inside a same-origin frame (the gather reads the top document; nothing would clear it) — the tree does not reach it today", async () => {
    await page(`<iframe id="fr" srcdoc="<button>Accept</button>" style="position:absolute;left:100px;top:100px;width:300px;height:100px"></iframe>`);
    await sleep(300);
    expect((await resolve({ by: "ariaLabel", pattern: "Accept" })).kind).not.toBe("resolved");
    expect(await evaluateInTab("document.getElementById('fr').contentDocument.querySelectorAll('[data-dtm-ax]').length", null, PORT)).toBe(0);
  });

  it("says a match is outside the viewport where an inner scroller would show it, not inside a fixed panel in a shadow root (/code-review on the #441 fix)", async () => {
    const code = async (pattern: string) => (JSON.parse(((await browserClickElementHandler({ by: "text", pattern, port: PORT } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string }).code;
    // An app shell: the page does not scroll, main does.
    await page(`<style>html,body{height:100%;overflow:hidden}</style><main style="overflow:auto;height:100%"><div style="height:3000px;position:relative"><button style="position:absolute;top:2000px">Save draft</button></div></main>`);
    expect(await code("Save draft")).toBe("ElementNotInViewport");
    // A web component's fixed sheet, its link slotted from the light DOM, on a page taller than the viewport.
    await page(`<div style="height:4000px"></div><x-sheet><a href="#n">Sheet link</a></x-sheet>`);
    await evaluateInTab(`(function(){customElements.define('x-sheet', class extends HTMLElement { constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<div style="position:fixed;left:0;top:100%;width:300px"><slot></slot></div>';} });return true})()`, null, PORT);
    await sleep(50);
    expect(await code("Sheet link")).toBe("BrowserNoActionableTarget");
  });

  it("puts a dialog over the page first, and does not offer a scroll that was already tried (/code-review on the #441 fix)", async () => {
    const body = async (a: Record<string, unknown>) => JSON.parse(((await browserClickElementHandler({ ...a, port: PORT } as never)).content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; suggest?: string[] };
    // Scrolled past the button, with a modal dialog open: the dialog is the thing to deal with.
    await page(`<button style="margin:40px">Top action</button><div style="height:4000px"></div><div role="dialog" aria-modal="true" aria-label="Terms" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><button>Accept</button></div>`);
    await evaluateInTab("scrollTo(0, 2000); true", null, PORT);
    expect((await body({ by: "text", pattern: "Top action" })).code).toBe("BrowserModalBlocking");
    // The dialog's own button, below the fold inside a tall scrolling dialog: scroll within it, not dismiss it (codex on
    // #1028).
    await page(`<div role="dialog" aria-modal="true" aria-label="Terms" style="position:fixed;inset:0;overflow:auto;background:#fff"><div style="height:3000px;position:relative"><button style="position:absolute;top:2500px">I agree</button></div></div>`);
    expect((await body({ by: "text", pattern: "I agree" })).code).toBe("ElementNotInViewport");
    // A page that jumps back to the top whenever it is scrolled: scrollIntoView:true was tried, so it is not offered.
    await page(`<div data-go="1" style="display:none">Go</div><div style="height:4000px"></div><button data-go="1">Go</button>`);
    await evaluateInTab("addEventListener('scroll', function(){ if (scrollY) scrollTo(0, 0); }); true", null, PORT);
    const r = await body({ selector: '[data-go="1"]', scrollIntoView: true });
    expect(r.code).toBe("ElementNotInViewport");
    expect(r.suggest?.[0]).toMatch(/^Scrolling it into view was tried/);
  });

  it("still answers two matches below the fold as not pressable here, not ambiguous (control for W11a)", async () => {
    await page(`<div style="height:3000px"><button style="position:absolute;left:100px;top:2400px">Delete</button><button style="position:absolute;left:300px;top:2600px">Delete</button></div>`);
    const r = await browserClickElementHandler({ by: "text", pattern: "Delete", port: PORT } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string };
    // Outside the viewport, said so since issue #441's e2e fix (was BrowserNoActionableTarget).
    expect(body.code).toBe("ElementNotInViewport");
  });

  it("says a 0x0 checkbox whose label is display: none is not rendered (a label with no box is not a way in)", async () => {
    await page(`<input type="checkbox" id="zc" data-t="1" style="position:absolute;width:0;height:0;margin:0;opacity:0"><label for="zc" style="display:none">Hidden</label>`);
    expect(await readPressLanding("[data-t]", null, PORT)).toMatchObject({ error: expect.stringContaining("zero size") });
  });

  it("still says a 0x0 element with no label is not rendered (control)", async () => {
    await page(`<button id="nb" data-t="1" style="position:absolute;width:0;height:0;padding:0;border:0"></button>`);
    expect(await readPressLanding("[data-t]", null, PORT)).toMatchObject({ error: expect.stringContaining("zero size") });
  });
});
