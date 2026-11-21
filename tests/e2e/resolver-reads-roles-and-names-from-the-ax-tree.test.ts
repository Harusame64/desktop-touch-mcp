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
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { resolveBrowserActionTarget, type ResolveActionOutcome } from "../../src/tools/browser-resolver.js";
import { browserClickElementHandler } from "../../src/tools/browser.js";

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
});
