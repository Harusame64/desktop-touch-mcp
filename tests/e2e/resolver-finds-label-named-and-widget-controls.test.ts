/**
 * internal #420 (PR-C2a) — browser_click's by-axis resolver finds what a person sees and names:
 * - a checkbox named by its <label> (by:'ariaLabel' reads the accessible name);
 * - a checkbox by role (implicit roles of form controls);
 * - the label itself by text (a <label> of a control is pressable);
 * - a checkbox the page hides and draws itself (iCheck's opacity: 0 input, an sr-only one), seen through its label;
 * - Select2's combobox and Choices' listbox (widget roles count as pressable), not the native select they hide.
 * Before, win2 measured 0 matches or BrowserNoActionableTarget for each (#1006, X2/X3).
 *
 * Hand-built copies of the libraries' DOM (no CDN). The presses are measured on Windows (win2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { resolveBrowserActionTarget, type ResolveActionOutcome } from "../../src/tools/browser-resolver.js";
import { browserClickElementHandler } from "../../src/tools/browser.js";

const PORT = 9237;
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
const resolve = (a: A, gate = true): Promise<ResolveActionOutcome> =>
  resolveBrowserActionTarget({ ...a, action: "click", requireReceivesEvents: gate, port: PORT, tabId: null });
const tagOf = async (o: ResolveActionOutcome): Promise<string> => (o.kind === "resolved" ? `${o.matched.tag}#${o.matched.id ?? ""}` : o.kind);

const SR = `<input type="checkbox" id="terms" class="sr"><label for="terms" style="position:absolute;left:100px;top:100px">Accept terms</label>`;
const ICHECK = `<div style="position:absolute;left:100px;top:200px;width:22px;height:22px"><input type="checkbox" id="ic" style="position:absolute;opacity:0;margin:0"><ins style="position:absolute;inset:0;border:2px solid #333"></ins></div><label for="ic" style="position:absolute;left:130px;top:200px">Subscribe</label>`;
const SELECT2 = `<select id="fruit" class="sr" tabindex="-1" aria-hidden="true"><option>Apple</option><option>Banana</option></select>
  <span class="select2" style="position:absolute;left:100px;top:300px;width:240px"><span class="select2-selection" role="combobox" tabindex="0" aria-haspopup="true" style="display:block;height:28px;border:1px solid #aaa"><span id="select2-fruit-container" role="textbox" aria-readonly="true">Apple</span></span></span>`;
const CHOICES = `<div class="choices" role="listbox" tabindex="0" aria-haspopup="true" style="position:absolute;left:100px;top:400px;width:240px;height:30px;border:1px solid #aaa"><select id="flavour" hidden><option>Vanilla</option></select><div class="choices__item">Vanilla</div></div>`;

describe.skipIf(!CHROME)("the by-axis resolver finds what a person sees and names (internal #420)", () => {
  it("finds an sr-only checkbox by the name its <label> gives it (by:'ariaLabel')", async () => {
    await page(SR);
    expect(await tagOf(await resolve({ by: "ariaLabel", pattern: "Accept terms" }, false))).toBe("input#terms");
  });

  it("finds it by role (an input's implicit role)", async () => {
    await page(SR);
    expect(await tagOf(await resolve({ by: "role", pattern: "checkbox" }, false))).toBe("input#terms");
  });

  it("resolves its label by text: a <label> of a control is pressable", async () => {
    await page(SR);
    expect(await tagOf(await resolve({ by: "text", pattern: "Accept terms" }))).toBe("label#");
  });

  it("does not take a plain text label without a control for pressable (control)", async () => {
    await page(`<label style="position:absolute;left:100px;top:100px">Just words</label>`);
    expect((await resolve({ by: "text", pattern: "Just words" })).kind).toBe("noActionable");
  });

  it("finds iCheck's opacity: 0 checkbox through its shown label", async () => {
    await page(ICHECK);
    expect(await tagOf(await resolve({ by: "role", pattern: "checkbox" }, false))).toBe("input#ic");
    expect(await tagOf(await resolve({ by: "ariaLabel", pattern: "Subscribe" }, false))).toBe("input#ic");
  });

  it("does not see an opacity: 0 checkbox with no label (control)", async () => {
    await page(`<input type="checkbox" id="lone" style="position:absolute;left:100px;top:100px;opacity:0">`);
    expect((await resolve({ by: "role", pattern: "checkbox" }, false)).kind).toBe("noActionable");
  });

  it("resolves Select2's combobox by role, not the aria-hidden native select it stands for", async () => {
    await page(SELECT2);
    const o = await resolve({ by: "role", pattern: "combobox" });
    expect(o.kind).toBe("resolved");
    if (o.kind === "resolved") expect(o.matched.role).toBe("combobox");
  });

  it("resolves Select2's shown value by text through its combobox", async () => {
    await page(SELECT2);
    const o = await resolve({ by: "text", pattern: "Apple" });
    expect(o.kind).toBe("resolved");
    if (o.kind === "resolved") expect(o.climbDepth).toBe(1);
  });

  it("resolves Choices' listbox by role, and its shown value by text", async () => {
    await page(CHOICES);
    expect((await resolve({ by: "role", pattern: "listbox" })).kind).toBe("resolved");
    expect((await resolve({ by: "text", pattern: "Vanilla" })).kind).toBe("resolved");
  });

  it("still finds a plain select by role combobox (control)", async () => {
    await page(`<select id="plain" style="position:absolute;left:100px;top:100px"><option>One</option></select>`);
    expect(await tagOf(await resolve({ by: "role", pattern: "combobox" }))).toBe("select#plain");
  });

  it("takes browser_click by:'ariaLabel' on the sr-only checkbox to a press (its label), not a stop (#1006 X2a)", async () => {
    await page(SR);
    const r = await browserClickElementHandler({ by: "ariaLabel", pattern: "Accept terms", port: PORT } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text.replace(/^[^{]*/, "")) as { code?: string; ok?: boolean };
    if (body.ok === true) return; // a machine that can press
    // On mac the OS press itself cannot be sent; what matters is that the call got past resolution and landing.
    expect(body.code).not.toBe("BrowserNoActionableTarget");
    expect(body.code).not.toBe("BrowserPointCovered");
    expect(body.code).not.toBe("BrowserAmbiguousTarget");
  });
});
