/**
 * internal #421 — desktop_act's CDP click presses the way a person would: through a decoration on the element (its
 * own label, a visible part of it, a skin of its widget that the browser confirms), around a sticky header, after a
 * short loading overlay; and it refuses only what a person would have to deal with first, naming it and what it
 * offers. A press that mislands is stopped in the page.
 *
 * The shapes are hand-built copies of what the spikes measured on real libraries (mac, headless Chrome 157):
 * iCheck's `ins.iCheck-helper`, Bootstrap's btn-check group and modal, SweetAlert2's container, a flatpickr-like
 * calendar, a sticky header, a cookie banner, a nested confirm. No CDN: the page is written into the tab.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { sleep } from "./helpers/wait.js";
import { evaluateInTab, disconnectAll, dispatchMouseMoveInTab } from "../../src/engine/cdp-bridge.js";
import { cdpDispatchClickAndVerify } from "../../src/tools/browser.js";
import { buildPressGuardJs } from "../../src/tools/press-landing.js";

const PORT = 9231;
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;height:2000px;font:16px sans-serif}</style></head><body>${body}<script>window.__n={};document.addEventListener('click',function(e){var t=e.target.closest('[data-n]');if(t){window.__n[t.dataset.n]=(window.__n[t.dataset.n]||0)+1;}},true);</script></body></html>`;
  // The pointer leaves the page area first: where the last cell pressed, a new page would get its hover at once.
  await dispatchMouseMoveInTab(1, 1, null, PORT);
  await evaluateInTab(`document.open();document.write(${JSON.stringify(html)});document.close();scrollTo(0,0);true`, null, PORT);
  await sleep(150);
}
const counts = async (): Promise<Record<string, number>> => (await evaluateInTab("window.__n", null, PORT)) as Record<string, number>;
const read = async (expr: string): Promise<unknown> => evaluateInTab(expr, null, PORT);
async function press(sel: string): Promise<{ ok: true; r: Awaited<ReturnType<typeof cdpDispatchClickAndVerify>> } | { ok: false; name: string; detail: string }> {
  try {
    return { ok: true, r: await cdpDispatchClickAndVerify(sel, null, PORT) };
  } catch (e) {
    const err = e as Error & { callerDetail?: string };
    return { ok: false, name: err.name, detail: err.callerDetail ?? err.message };
  }
}

const BEHIND = '<button id="behind" data-n="behind" style="position:absolute;left:300px;top:300px">Behind</button>';

describe.skipIf(!CHROME)("desktop_act's CDP click presses the way a person would (internal #421)", () => {
  // ── decorations the click goes through ──────────────────────────────────────────────────────────────────────
  it("presses an iCheck-style skin, which the browser confirms (unnamed, with a click listener)", async () => {
    await page(`<div id="w" style="position:relative;width:22px;height:22px;margin:80px"><input type="checkbox" id="ic" style="position:absolute;top:20%;left:20%;margin:0;opacity:0"><ins id="skin" style="position:absolute;inset:0;border:2px solid #333"></ins></div>
      <script>document.getElementById('skin').addEventListener('click',function(){var i=document.getElementById('ic');i.checked=!i.checked;});</script>`);
    const out = await press("#ic");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.r.pressedAt).toBe("skin");
    expect(await read("document.getElementById('ic').checked")).toBe(true);
  });

  it("presses an unnamed layer with no handler, and says it could not confirm the press (control: no harm, no claim)", async () => {
    await page(`<div style="position:relative;width:22px;height:22px;margin:80px"><input type="checkbox" id="ic" style="position:absolute;top:20%;left:20%;margin:0"><ins style="position:absolute;inset:0;background:#fff"></ins></div>`);
    const out = await press("#ic");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.r.pressedAt).toBe("skin");
      expect(out.r.status).toBe("unverifiable");
    }
    expect(await read("document.getElementById('ic').checked")).toBe(false);
  });

  it("does not take a NAMED layer over the control for a skin: it is refused by name", async () => {
    await page(`<div style="position:relative;width:22px;height:22px;margin:80px"><input type="checkbox" id="ic" style="position:absolute;top:20%;left:20%;margin:0"><ins aria-label="Locked" style="position:absolute;inset:0;background:#fff"></ins></div>`);
    const out = await press("#ic");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain('"Locked"');
    expect(await read("document.getElementById('ic').checked")).toBe(false);
  });

  it("presses a skin whose handler is delegated to the document (jQuery .on / React root)", async () => {
    await page(`<div class="w" style="position:relative;width:22px;height:22px;margin:80px"><input type="checkbox" id="ic" style="position:absolute;top:20%;left:20%;margin:0;opacity:0"><ins class="skin" style="position:absolute;inset:0;border:2px solid #333"></ins></div>
      <script>document.addEventListener('click',function(e){if(e.target.classList.contains('skin')){var i=e.target.parentElement.querySelector('input');i.checked=!i.checked;}});</script>`);
    const out = await press("#ic");
    expect(out.ok).toBe(true);
    expect(await read("document.getElementById('ic').checked")).toBe(true);
  });

  it("presses a skin found only after scrolling, at the scroll it was measured at", async () => {
    await page(`<div style="position:absolute;top:1500px;left:80px;width:22px;height:22px"><input type="checkbox" id="ic" style="position:absolute;top:20%;left:20%;margin:0;opacity:0"><ins id="skin" style="position:absolute;inset:0;border:2px solid #333"></ins></div>
      <button data-n="other" style="position:absolute;top:1120px;left:60px;width:200px;height:60px">Other</button>
      <script>document.getElementById('skin').addEventListener('click',function(){var i=document.getElementById('ic');i.checked=!i.checked;});</script>`);
    const out = await press("#ic");
    expect(out.ok).toBe(true);
    expect(await read("document.getElementById('ic').checked")).toBe(true);
    expect(await counts()).toEqual({});
  });

  it("presses an sr-only checkbox through its own label", async () => {
    await page(`<label style="display:inline-flex;gap:8px;margin:80px"><input type="checkbox" id="tw" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"><span style="display:inline-block;width:44px;height:24px;background:#ccc"></span> Toggle</label>`);
    const out = await press("#tw");
    expect(out.ok).toBe(true);
    // Chrome hit-tests the clipped 1px box as the input itself, so the press may land there or on the label:
    // either reaches it.
    if (out.ok) expect(["element", "label"]).toContain(out.r.pressedAt);
    expect(await read("document.getElementById('tw').checked")).toBe(true);
  });

  it("presses the right radio of a btn-check group through its own label, not the other's", async () => {
    await page(`<div style="margin:80px;position:relative;display:inline-flex">
      <input type="radio" name="g" id="g1" style="position:absolute;clip:rect(0,0,0,0);pointer-events:none;left:0;top:0"><label for="g1" style="padding:8px 16px;border:1px solid">Left</label>
      <input type="radio" name="g" id="g2" style="position:absolute;clip:rect(0,0,0,0);pointer-events:none;left:0;top:0"><label for="g2" style="padding:8px 16px;border:1px solid">Right</label></div>`);
    const out = await press("#g2");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.r.pressedAt).toBe("label");
    expect(await read("[document.getElementById('g1').checked, document.getElementById('g2').checked]")).toEqual([false, true]);
  });

  it("presses a visible part of a button whose centre a badge covers", async () => {
    await page(`<button id="b" data-n="b" style="position:absolute;left:100px;top:100px;width:160px;height:40px">Save</button>
      <span style="position:absolute;left:170px;top:110px;width:20px;height:20px;background:red;border-radius:10px" aria-label="3 new"></span>`);
    const out = await press("#b");
    expect(out.ok).toBe(true);
    expect((await counts()).b).toBe(1);
  });

  it("scrolls a link out from under a sticky header", async () => {
    await page(`<header data-n="header" style="position:fixed;top:0;left:0;right:0;height:80px;background:#ccc;z-index:5">Header</header>
      <a id="l" data-n="l" href="#x" style="position:absolute;left:600px;top:1000px">Link</a>`);
    // Scrolled so the link sits under the header, as after reading further down a page.
    await read("scrollTo(0, 970); true");
    const out = await press("#l");
    expect(out.ok).toBe(true);
    expect(await counts()).toEqual({ l: 1 });
  });

  it("waits out a loading overlay that goes away", async () => {
    await page(`${BEHIND}<div id="scrim" style="position:fixed;inset:0;background:rgba(255,255,255,.6);z-index:2000"></div>
      <script>setTimeout(function(){document.getElementById('scrim').remove();},700);</script>`);
    const out = await press("#behind");
    expect(out.ok).toBe(true);
    expect((await counts()).behind).toBe(1);
  });

  it("waits out a loading overlay while a hidden modal sits in the page (a hidden dialog is not what is in front)", async () => {
    await page(`${BEHIND}<div class="modal" role="dialog" aria-label="Hidden settings" style="display:none"></div><dialog aria-label="Closed"></dialog>
      <div id="scrim" style="position:fixed;inset:0;background:rgba(255,255,255,.6);z-index:2000"></div>
      <script>setTimeout(function(){document.getElementById('scrim').remove();},700);</script>`);
    const out = await press("#behind");
    expect(out.ok).toBe(true);
    expect((await counts()).behind).toBe(1);
  });

  it("lets a whole press through when it started on the element, though its mousedown opens a menu over it", async () => {
    await page(`<button id="t" data-n="t" style="position:absolute;left:100px;top:100px;width:160px;height:40px">Menu</button>
      <script>document.getElementById('t').addEventListener('mousedown',function(){var m=document.createElement('div');m.id='menu';m.setAttribute('role','menu');m.setAttribute('aria-label','Menu');m.style.cssText='position:absolute;left:90px;top:90px;width:200px;height:100px;background:#eef;z-index:9';document.body.appendChild(m);});</script>`);
    const out = await press("#t");
    expect(out.ok).toBe(true);
    expect(await read("!!document.getElementById('menu')")).toBe(true);
  });

  it("removes the press guard from the page by itself when it is never read", async () => {
    await page(`<button id="b">B</button>`);
    await read(buildPressGuardJs("#b"));
    expect(await read("!!window.__dtmPressGuard")).toBe(true);
    await sleep(5300);
    expect(await read("!!window.__dtmPressGuard")).toBe(false);
  }, 10_000);

  // ── what a person has to deal with first ───────────────────────────────────────────────────────────────────
  it("refuses the page behind a modal as modal_blocking, names it and its buttons, and the modal stays open", async () => {
    await page(`${BEHIND}<div id="m" role="dialog" aria-modal="true" aria-label="Settings" data-n="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1050">
      <div style="background:#fff;width:400px;margin:100px auto;padding:20px"><button data-n="ok">OK</button> <button>Cancel</button></div></div>
      <script>document.getElementById('m').addEventListener('mousedown',function(e){if(e.target===this)this.remove();});</script>`);
    const out = await press("#behind");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("ModalBlockingError");
      expect(out.detail).toContain('"Settings"');
      expect(out.detail).toContain('"OK", "Cancel"');
      expect(out.detail).toContain("nothing was clicked");
    }
    expect(await counts()).toEqual({});
    expect(await read("!!document.getElementById('m')")).toBe(true);
  });

  it("does not take an app root's modal backdrop for a skin (win2 on #1004, R1: #root holds the target and the backdrop)", async () => {
    await page(`<div id="root"><button id="t" data-n="t" style="position:absolute;left:300px;top:300px">Target</button>
      <div id="bd" data-n="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1040"></div>
      <div id="dlg" role="dialog" aria-modal="true" aria-label="Consent dialog" style="position:fixed;left:400px;top:100px;width:300px;height:150px;background:#fff;z-index:1050"><button>Inside</button></div></div>
      <script>document.getElementById('bd').addEventListener('click',function(){document.getElementById('dlg').remove();this.remove();});</script>`);
    const out = await press("#t");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("ModalBlockingError");
      expect(out.detail).toContain('"Consent dialog"');
    }
    expect(await counts()).toEqual({});
    expect(await read("!!document.getElementById('dlg')")).toBe(true);
  });

  it("does not take it for a skin in an in-flow app root either (R1v: #app is about the viewport's size)", async () => {
    await page(`<div id="app" style="height:900px;position:relative"><div class="page"><button id="t" data-n="t" style="margin:300px">Target</button></div>
      <div id="bd" data-n="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1040"></div>
      <div id="dlg" role="dialog" aria-modal="true" aria-label="Consent dialog" style="position:fixed;left:400px;top:100px;width:300px;height:150px;background:#fff;z-index:1050"><button>Inside</button></div></div>
      <script>document.getElementById('bd').addEventListener('click',function(){document.getElementById('dlg').remove();this.remove();});</script>`);
    const out = await press("#t");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.name).toBe("ModalBlockingError");
    expect(await counts()).toEqual({});
  });

  it("presses a button inside the modal (control)", async () => {
    await page(`${BEHIND}<div role="dialog" aria-modal="true" aria-label="Settings" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1050">
      <div style="background:#fff;width:400px;margin:100px auto;padding:20px"><button id="ok" data-n="ok">OK</button></div></div>`);
    const out = await press("#ok");
    expect(out.ok).toBe(true);
    expect(await counts()).toEqual({ ok: 1 });
  });

  it("names the dialog a SweetAlert-style container holds", async () => {
    await page(`${BEHIND}<div class="swal2-container" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1060;display:flex">
      <div role="dialog" aria-modal="true" aria-labelledby="t" style="margin:auto;background:#fff;padding:30px"><h2 id="t">Confirm</h2><button>Yes</button></div></div>`);
    const out = await press("#behind");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("ModalBlockingError");
      expect(out.detail).toContain('"Confirm"');
    }
    expect(await counts()).toEqual({});
  });

  it("refuses a confirm nested in a modal over the modal's own button", async () => {
    await page(`<div role="dialog" aria-modal="true" aria-label="Consent" style="position:fixed;left:100px;top:100px;width:700px;height:500px;background:#fff;z-index:1000">
      <button id="inA" data-n="inA" style="position:absolute;left:300px;top:250px">In A</button>
      <div role="dialog" aria-modal="true" aria-label="Confirm" style="position:absolute;left:200px;top:180px;width:300px;height:200px;background:#ffd;z-index:2000"><button data-n="yes">Yes</button></div></div>`);
    const out = await press("#inA");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("ModalBlockingError");
      expect(out.detail).toContain('"Confirm"');
      expect(out.detail).toContain('"Yes"');
    }
    expect(await counts()).toEqual({});
  });

  it("does not press the strip of a button left uncovered beside a modal confirm with no backdrop (R4)", async () => {
    await page(`<div role="dialog" aria-modal="true" aria-label="Consent" style="position:fixed;left:0;top:100px;width:700px;height:500px;background:#fff;z-index:1000">
      <button id="inA" data-n="inA" style="position:absolute;left:20px;top:250px;width:300px">In A</button>
      <div role="dialog" aria-modal="true" aria-label="Confirm" style="position:absolute;left:130px;top:180px;width:300px;height:200px;background:#ffd;z-index:2000"><button data-n="yes">Yes</button></div></div>`);
    const out = await press("#inA");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("ModalBlockingError");
      expect(out.detail).toContain('"Confirm"');
    }
    expect(await counts()).toEqual({});
  });

  it("names a non-modal drawer as a cover, not as modal_blocking (R7)", async () => {
    await page(`${BEHIND}<div role="dialog" aria-label="Side drawer" style="position:fixed;left:0;top:0;width:420px;height:100%;background:#eef;z-index:50"><button>Drawer button</button></div>`);
    const out = await press("#behind");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("AimedRouteFailedError");
      expect(out.detail).toContain("Side drawer");
      expect(out.detail).toContain('"Drawer button"');
    }
    expect(await counts()).toEqual({});
  });

  it("refuses an input under an open calendar without picking a date, and names the calendar's days", async () => {
    await page(`<input id="below" style="position:absolute;left:100px;top:200px">
      <div id="cal" style="position:absolute;left:90px;top:150px;width:300px;height:120px;background:#fff;border:1px solid;z-index:10">
        <span class="day" data-n="day" aria-label="November 6, 2026" style="display:inline-block;width:280px;height:100px">6</span></div>`);
    const out = await press("#below");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("AimedRouteFailedError");
      expect(out.detail).toContain("November 6, 2026");
    }
    expect(await counts()).toEqual({});
  });

  it("refuses a button under a cookie banner and names what the banner offers", async () => {
    await page(`<button id="low" data-n="low" style="position:fixed;left:300px;bottom:40px">Low</button>
      <div role="region" aria-label="Cookies" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee;z-index:50"><button data-n="accept">Accept all</button></div>`);
    const out = await press("#low");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain('"Accept all"');
    expect(await counts()).toEqual({});
  });

  it("stops a press that mislands because the page moved between the read and the press", async () => {
    // A hover card that appears over the button when the pointer arrives: the point was right when read.
    await page(`<button id="b" data-n="b" style="position:absolute;left:100px;top:100px;width:160px;height:40px">Save</button>
      <script>document.getElementById('b').addEventListener('mouseover',function(){if(document.getElementById('card'))return;var c=document.createElement('div');c.id='card';c.dataset.n='card';c.setAttribute('aria-label','Hover card');c.style.cssText='position:absolute;left:90px;top:90px;width:200px;height:60px;background:#ffe;z-index:9';document.body.appendChild(c);});</script>`);
    const out = await press("#b");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.name).toBe("AimedRouteFailedError");
      expect(out.detail).toContain("stopped in the page");
      expect(out.detail).toContain("Hover card");
    }
    expect(await counts()).toEqual({});
  });

  it("refuses under an overlay that does not go away, after waiting", async () => {
    await page(`${BEHIND}<div style="position:fixed;inset:0;background:rgba(255,255,255,.6);z-index:2000"></div>`);
    const t0 = Date.now();
    const out = await press("#behind");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain("empty overlay");
    expect(Date.now() - t0).toBeGreaterThan(1500);
    expect(await counts()).toEqual({});
  });
});
