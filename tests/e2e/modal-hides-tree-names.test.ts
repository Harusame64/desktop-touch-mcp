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
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
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
const note = (by: string) =>
  ` A modal dialog is open: while it is, the browser gives no name or role to the page behind it, so by:'${by}' finds no match there.`;
const HINT = "To reach the page behind the dialog: dismiss it (its close button or Escape) and retry, or match by:'text' or a selector, which read the page itself";

describe.skipIf(!CHROME)("a modal dialog hides the page behind it from the tree (internal #420)", () => {
  it("by:'ariaLabel' for a button named by aria-labelledby behind the dialog says the dialog is open", async () => {
    await page(SHOW_MODAL);
    const r = await click({ by: "ariaLabel", pattern: "Settings" });
    expect(r.code, JSON.stringify(r)).toBe("BrowserNoActionableTarget");
    expect(r.error).toBe(`browser_click: nothing matches.${note("ariaLabel")} Nothing was done.`);
    expect((r.suggest as string[])[0]).toBe(HINT);
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

  it("with the dialog closed the same control is found: the note is about the dialog, not the name", async () => {
    await page("");
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

  it("two stacked modal dialogs: a search scoped into the lower one is not said (which one is on top is not read)", async () => {
    await page(
      "document.getElementById('d1').showModal();document.getElementById('d2').showModal();",
      `<dialog id="d1"><button id="b1">One</button></dialog><dialog id="d2"><button id="b2">Two</button></dialog>`,
    );
    const r = await click({ by: "ariaLabel", pattern: "No such name", scope: "#d1" });
    expect(r.error, JSON.stringify(r)).toBe("browser_click: nothing matches. Nothing was done.");
  });
});
