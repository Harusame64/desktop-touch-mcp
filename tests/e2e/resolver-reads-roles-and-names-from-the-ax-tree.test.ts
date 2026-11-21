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
import { evaluateInTab, disconnectAll, markAxMatches, clearAxMarks } from "../../src/engine/cdp-bridge.js";
import { resolveBrowserActionTarget, type ResolveActionOutcome } from "../../src/tools/browser-resolver.js";
import { browserClickElementHandler, readPressLanding } from "../../src/tools/browser.js";

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

  it("does not find the aria-hidden native select by its label's name", async () => {
    await page(SELECT2);
    expect(what(await resolve({ by: "ariaLabel", pattern: "Fruit" }, false))).not.toBe("select#fruit");
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
    expect((r.content[0] as { text: string }).text).toContain("BrowserNoActionableTarget");
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

  it("still answers two matches below the fold as none actionable, not ambiguous (control for W11a)", async () => {
    await page(`<div style="height:3000px"><button style="position:absolute;left:100px;top:2400px">Delete</button><button style="position:absolute;left:300px;top:2600px">Delete</button></div>`);
    const r = await browserClickElementHandler({ by: "text", pattern: "Delete", port: PORT } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string };
    expect(body.code).toBe("BrowserNoActionableTarget");
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
