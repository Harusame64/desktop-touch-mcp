/**
 * scroll(action:'smart') answers TargetClipped, not in-view, when the target ends up inside the window but an
 * ancestor cuts it off, so nothing of it is on screen.
 *
 * MEASURED on main (mac, headless Chrome): a row 1800px down an overflow:clip box, and one under a clip-path box,
 * both answered ok:true, viewportPosition:'in-view'. Nothing at the row's centre was the row. in-view looked only
 * at the window, and the ancestor walk counts overflow:hidden/auto/scroll, not clip, clip-path or contain.
 *
 * The browser's IntersectionObserver decides. Two rounds of a hand walk over the ancestors kept missing CSS:
 * containing blocks, display:contents, the top layer, overflow-clip-margin, will-change, slots. A spike of those
 * 13 shapes gave the observer's answer as the page's in every one. The in-view cells here are the shapes a hand
 * walk got wrong: missing at its centre (pointer-events:none), escaping the box (position:fixed/absolute),
 * partly shown, painted past the box. Each asserts the observer answered (no "viewportPosition says only" warning),
 * so a road that skips it cannot pass them. A row touching the box's edge is clipped: the observer calls that
 * intersecting with ratio 0 (measured), so the ratio decides.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { smartScrollHandler } from "../../src/tools/smart-scroll.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9252;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const rows = (p: string) => Array.from({ length: 60 }, (_, i) => `<div id="${p}-${i}" style="height:40px">${p} ${i}</div>`).join("");
const HTML = `<title>t</title><style>body{margin:0}</style>
<div style="height:200px;overflow:clip">${rows("c")}<a id="c-anchor"></a></div>
<div style="height:200px;clip-path:inset(0)"><div>${rows("p")}</div></div>
<div style="height:200px;contain:paint"><div>${rows("k")}</div></div>
<div style="height:100px;overflow:clip"><div style="will-change:transform"><div id="wc" style="position:fixed;top:200px;height:20px">wc</div></div></div>
<x-host><div id="slotted" style="height:20px">slotted</div></x-host>
<div style="height:200px;overflow:auto"><div style="pointer-events:none">${rows("e")}</div></div>
<div style="height:200px;overflow:clip"><div id="fixed" style="position:fixed;top:300px;left:0;height:40px;pointer-events:none">fixed</div>${rows("x")}</div>
<div style="height:100px;overflow:auto"><div style="height:300px"></div><div id="tall" style="height:500px">tall</div><div style="height:300px"></div></div>
<div style="position:relative"><div style="overflow:auto;height:100px"><div id="abs" style="position:absolute;top:300px;pointer-events:none">abs</div></div></div>
<div style="height:200px;clip-path:inset(0 0 -3000px 0)"><div>${rows("w")}</div></div>
<div style="display:contents;overflow:clip"><div id="dc" style="pointer-events:none;height:40px">dc</div></div>
<div style="contain:paint;height:40px"><div popover id="pop"><span id="popt" style="pointer-events:none">Item</span></div></div>
<div style="height:200px;overflow:clip;overflow-clip-margin:100px"><div style="height:250px"></div><div id="ocm" style="height:20px;pointer-events:none">ocm</div></div>
<div id="free" style="height:200px;overflow:auto">${rows("f")}</div>
<div style="height:200px;overflow:auto">${rows("o")}</div>
<div id="jump" style="height:20px">jump</div>
<div id="gone" style="height:20px">gone</div>
<a id="anchor"></a><div style="height:20px">after the anchor</div>
<div id="hidden" style="display:none">hidden</div>
<div style="height:1500px"></div>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>
<script>
customElements.define('x-host', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<div style="height:100px;overflow:clip"><div style="height:200px"></div><slot></slot></div>'; } });
document.getElementById('pop').showPopover();
window.__IO = IntersectionObserver;
// The traps go off when the tool's observer starts looking, after its synchronous read: the page changes in the
// frame the observer answers for, so its own entry is what has to tell.
const __observe = IntersectionObserver.prototype.observe;
IntersectionObserver.prototype.observe = function (t) {
  if (window.__armJump) { window.__armJump = false; document.getElementById('jump').style.marginTop = '5000px'; }
  if (window.__armGone) { window.__armGone = false; document.getElementById('gone').style.display = 'none'; }
  return __observe.call(this, t);
};
</script>`;

async function scroll(target: string, inline = "center") {
  return parsePayload(await smartScrollHandler({
    target, port: PORT, strategy: "cdp", direction: "into-view", inline,
    maxDepth: 10, retryCount: 1, verifyWithHash: false, expandHidden: false,
  } as never));
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(PORT, true, `data:text/html,${encodeURIComponent(HTML)}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* not ready */ }
    await sleep(300);
  }
}, 20_000);

beforeEach(async () => {
  if (!CHROME_AVAILABLE) return;
  // No reload: a data: page does not reload itself (location.reload() left window state in place, measured). Every
  // cell only scrolls, so putting each box and the window back at the start is enough.
  await evaluateInTab(`window.__armJump = false; window.__armGone = false;
    document.getElementById('jump').style.marginTop = ''; document.getElementById('gone').style.display = '';
    window.IntersectionObserver = window.__IO; delete document.visibilityState;
    scrollTo(0, 0); document.querySelectorAll('div').forEach((b) => { b.scrollTop = 0; b.scrollLeft = 0; }); 1`, null, PORT);
  // Let the reset's own scroll event fire before a cell arms a trap on the next one (/code-review).
  await evaluateInTab(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`, null, PORT);
});

afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

describe.skipIf(!CHROME_AVAILABLE)("smart scroll says when an ancestor clips the target off", () => {
  for (const [name, target] of [
    ["overflow:clip", "#c-45"],
    ["overflow:clip, touching the box's bottom edge with no area inside", "#c-5"],
    ["clip-path, touching the box's bottom edge with no area inside", "#p-5"],
    ["clip-path", "#p-45"],
    ["contain:paint", "#k-45"],
    ["an overflow:clip box that a will-change containing block puts a fixed child under", "#wc"],
    ["an overflow:clip box inside the host's shadow root, for a slotted row", "#slotted"],
  ] as const) {
    it(`a target cut off by ${name} answers TargetClipped`, async () => {
      const r = await scroll(target);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("TargetClipped");
      expect(r.error).toContain("an ancestor cuts it off, so nothing of it is on screen");
      // The scroll already ran: the answer still says what it did.
      expect(r.context).toMatchObject({ path: "cdp", scrolled: true, viewportPosition: "in-view" });
      expect(Array.isArray(r.context.ancestors)).toBe(true);
      expect(typeof r.context.pageRatio).toBe("number");
      // The truth the answer is about: the target's centre is inside the window, and nothing there is the target.
      expect(await evaluateInTab(`(() => { const t = document.querySelector(${JSON.stringify(target)}); const b = t.getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        return cy >= 0 && cy <= innerHeight && !document.elementsFromPoint(cx, cy).includes(t); })()`, null, PORT)).toBe(true);
    });
  }

  for (const [name, target, inline] of [
    ["a pointer-events:none row in a scroller (missing at its centre)", "#e-45", "center"],
    ["a pointer-events:none position:fixed child of an overflow:clip box (escapes it)", "#fixed", "center"],
    ["a pointer-events:none position:absolute target that escapes an overflow box", "#abs", "center"],
    ["a tall target scrolled to the start of a short scroller (partly shown)", "#tall", "start"],
    ["a row a clip-path reaching past its box still paints", "#w-45", "center"],
    ["a pointer-events:none child of an overflow:clip display:contents wrapper (no box to clip)", "#dc", "center"],
    ["a pointer-events:none item of a popover declared inside a contain:paint box (top layer)", "#popt", "center"],
    ["a pointer-events:none row inside an overflow-clip-margin", "#ocm", "center"],
    ["a row under a full-window overlay (covered, not clipped)", "#o-45", "center"],
  ] as const) {
    it(`${name} is in view`, async () => {
      const r = await scroll(target, inline);
      expect(r.ok).toBe(true);
      expect(r.viewportPosition).toBe("in-view");
      // The browser was asked and answered: in-view here is not the window's answer alone.
      expect(r.warnings ?? []).not.toContainEqual(expect.stringMatching(/viewportPosition says only/));
    });
  }

  it("a target the page moves out of the window as the observer starts answers where it went, not clipped", async () => {
    // The observer answers a frame later, after the page may have moved the target: the position is read again from it.
    await evaluateInTab(`window.__armJump = true; 1`, null, PORT);
    const r = await scroll("#jump");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("below");
    expect(await evaluateInTab(`document.getElementById('jump').getBoundingClientRect().top > innerHeight`, null, PORT)).toBe(true);
  });

  for (const [name, setup, said] of [
    ["the page is not visible", `Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); 1`, /the page is not visible/],
    ["the browser does not answer", `window.IntersectionObserver = function () { return { observe() {}, disconnect() {} }; }; 1`, /did not answer within 500 ms/],
    ["the page hides the target as the observer starts", `window.__armGone = true; 1`, /the target has no box on the page/],
  ] as const) {
    it(`when ${name}, the answer warns that it was not checked`, async () => {
      await evaluateInTab(setup, null, PORT);
      const r = await scroll(name.includes("hides") ? "#gone" : "#c-45");
      expect(r.ok).toBe(true);
      // A hidden target has no position; the others are inside the window, unchecked.
      expect(r.viewportPosition).toBe(name.includes("hides") ? null : "in-view");
      expect(r.warnings).toContainEqual(expect.stringMatching(said));
    });
  }

  it("a final read that fails answers ok with a warning, without falling through to the other roads", async () => {
    await evaluateInTab(`window.IntersectionObserver = function () { throw new Error('observer broke'); }; 1`, null, PORT);
    const r = await scroll("#c-45");
    expect(r.ok).toBe(true);
    expect(r.path).toBe("cdp");
    expect(r.viewportPosition).toBeNull();
    expect(r.warnings).toContainEqual(expect.stringMatching(/The position after the scroll was not read: .*observer broke/));
  });

  it("a display:none target answers no position, with a warning, before any observer", async () => {
    const r = await scroll("#hidden");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBeNull();
    expect(r.warnings).toContainEqual(expect.stringMatching(/the target has no box on the page/));
  });

  it("an empty anchor (a box of no area) scrolled into view is in view, checked", async () => {
    const r = await scroll("#anchor");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(r.warnings ?? []).toEqual([]);
  });

  it("an empty anchor cut off by an overflow:clip box answers TargetClipped", async () => {
    const r = await scroll("#c-anchor");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("TargetClipped");
  });

  it("a row in an ordinary scroller is in view", async () => {
    const r = await scroll("#f-45");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(await evaluateInTab(`document.getElementById('free').scrollTop`, null, PORT)).toBeGreaterThan(0);
  });
});
