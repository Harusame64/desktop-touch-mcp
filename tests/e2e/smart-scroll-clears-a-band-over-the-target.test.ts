/**
 * internal #436 — scroll(action:'smart') clears a fixed or sticky band (a site's top bar, a cookie banner) that covers
 * the target's edge after the scroll, by scrolling the box that can move the target, and says what moved.
 *
 * MEASURED on main 2210a6f7 (win2, internal dev/w436-spike): the old check fixed 1 of 13 hidden targets and fired on
 * 6 that were not hidden. It looked only for a sticky/fixed z-index≥1 element at y=4, then shifted the target's parent.
 * With the target inside a plain wrapper nothing moved, yet the answer said "scrolled an extra 68px". It missed
 * z-index:auto bars, bottom bands and bars whose point lands on a child (MDN, GitHub). Centred targets the bar did not
 * cover were shifted anyway.
 *
 * Every cell asserts the screen truth: what elementsFromPoint finds at the target's edge after the call.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { smartScrollHandler } from "../../src/tools/smart-scroll.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9254;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const filler = (h: number) => `<div style="height:${h}px"></div>`;
const head = `<!doctype html><title>t</title><style>html,body{margin:0}</style>`;

/** A sticky top bar on the document; the target sits in a plain wrapper (not a scroller). */
const DOC_BAR = (z: string) => `${head}<header id="bar" style="position:sticky;top:0;height:60px;background:#333;z-index:${z}">bar</header>
${filler(1500)}<div id="wrap"><h2 id="t" style="height:40px;margin:0">target</h2></div>${filler(1500)}`;
/** The bar's own child is what the point lands on (MDN's nav, GitHub's span). */
const CHILD_BAR = `${head}<div id="bar" style="position:sticky;top:0;z-index:5"><nav style="height:60px;background:#333"><span style="display:block;height:60px">menu</span></nav></div>
${filler(1500)}<h2 id="t" style="height:40px;margin:0">target</h2>${filler(1500)}`;
/** A sticky bar inside a scroller. */
const BOX_BAR = `${head}<div id="sc" style="height:400px;overflow:auto"><div id="sbar" style="position:sticky;top:0;height:50px;background:#333;z-index:1">bar</div>
${filler(1200)}<div id="t" style="height:40px">target</div>${filler(1200)}</div>`;
/** A fixed bottom band (a cookie banner), on a page with room below the target and on one with none. */
const BOTTOM = (after: number) => `${head}<div id="ban" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#333">cookies</div>
${filler(1500)}<div id="t" style="height:40px">target</div>${filler(after)}`;
/** A full-window veil: not a band, left alone. */
const VEIL = `${head}<div style="position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>
<header style="position:sticky;top:0;height:60px;z-index:1">bar</header>${filler(1500)}<div id="t" style="height:40px">target</div>${filler(1500)}`;
/** A target taller than the window, centred: its edges are outside the window, so nothing is probed. */
const TALL = `${head}<header style="position:sticky;top:0;height:60px;background:#333;z-index:1">bar</header>
${filler(1500)}<div id="t" style="height:3000px;background:#eee">tall</div>${filler(1500)}`;

/** html{overflow:hidden} body{overflow:auto}: body is the page's scroller. */
const BODY_SCROLLER = `<!doctype html><title>t</title><style>html{overflow:hidden;height:100%}body{margin:0;overflow:auto;height:100%}</style>
<div id="bar" style="position:fixed;top:0;left:0;right:0;height:60px;background:#333">bar</div>${filler(1500)}<div id="t" style="height:40px">target</div>${filler(1500)}`;
/** A site bar over a scroller whose first row is the target: the scroller has no room up, the document has. */
const PANEL = `${head}<div id="bar" style="position:fixed;top:0;left:0;right:0;height:60px;background:#333">bar</div>${filler(1500)}
<div id="panel" style="height:400px;overflow:auto"><div id="t" style="height:40px">target</div>${filler(1200)}</div>${filler(1500)}`;
/** The bar is a fixed <header> inside an open shadow root of a static host. */
const SHADOW_BAR = `${head}<site-header></site-header>${filler(1500)}<div id="t" style="height:40px">target</div>${filler(1500)}
<script>customElements.define('site-header', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<header style="position:fixed;top:0;left:0;right:0;height:60px;background:#333">bar</header>'; } });</script>`;
/** A fixed header holding a sticky row lower down; the target's top is under the row, and the page cannot scroll up. */
const ROW_IN_HEADER = `${head}<header id="hd" style="position:fixed;top:0;left:0;right:0;height:100px;background:#333">
<div style="height:50px"></div><div id="row" style="position:sticky;top:50px;height:50px;background:#555">row</div></header>
<div id="t" style="margin-top:60px;height:40px">target</div>${filler(1500)}`;
/** A target almost the window's height between a top bar and a bottom banner. */
const BOTH = `${head}<div style="position:fixed;top:0;left:0;right:0;height:60px;background:#333">bar</div>
<div id="ban" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#333">cookies</div>
${filler(1500)}<div id="t" style="height:calc(100vh - 100px);background:#eee">target</div>${filler(1500)}`;
/** A sticky bar in a scroller whose only snap point is the target's start: the clearing scroll is put back. */
const SNAP = `${head}<div id="sc" style="height:400px;overflow:auto;scroll-snap-type:y mandatory">
<div style="position:sticky;top:0;height:50px;background:#333;z-index:1">bar</div>
${Array.from({ length: 30 }, (_, i) => `<div ${i === 15 ? 'id="t" style="height:100px;scroll-snap-align:start"' : 'style="height:100px"'}>row ${i}</div>`).join("")}</div>`;

/** GitHub: a 2px opacity:0 fixed loader at the window's top, above the sticky bar. */
const GITHUB_LIKE = `${head}<span style="position:fixed;top:0;left:0;right:0;height:2px;opacity:0;z-index:99;display:block"></span>
<div id="bar" style="position:sticky;top:0;height:48px;background:#333;z-index:1">bar</div>${filler(1500)}<div id="t" style="height:40px">target</div>${filler(1500)}`;
/** A fractional layout above the target: scrollIntoView start leaves its top a fraction off 0 (MDN -0.11, GitHub -0.03). */
const FRACTION = `${head}<div id="bar" style="position:sticky;top:0;height:60px;background:#333;z-index:1">bar</div>
<div style="height:1500.4px"></div><div id="t" style="height:40px">target</div>${filler(1500)}`;

async function load(html: string) {
  await evaluateInTab(`document.open(); document.write(${JSON.stringify(html)}); document.close(); scrollTo(0, 0); 1`, null, PORT);
  await evaluateInTab(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`, null, PORT);
}

async function scroll(target: string, inline: string) {
  return parsePayload(await smartScrollHandler({
    target, port: PORT, strategy: "cdp", direction: "into-view", inline,
    maxDepth: 10, retryCount: 1, verifyWithHash: false, expandHidden: false,
  } as never));
}

/** The screen truth: is the target (or something inside it) on top at its top / bottom edge? */
async function shownAt(edge: "top" | "bottom"): Promise<boolean> {
  return await evaluateInTab(`(() => { const t = document.getElementById('t'); const r = t.getBoundingClientRect();
    const y = ${edge === "top" ? "r.top + 2" : "r.bottom - 2"}; const h = document.elementsFromPoint(r.left + r.width / 2, y)[0];
    return !!h && (h === t || t.contains(h)); })()`, null, PORT) as boolean;
}

beforeAll(async () => {
  if (!CHROME_AVAILABLE) return;
  chrome = await launchChrome(PORT, true, "about:blank");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* not ready */ }
    await sleep(300);
  }
}, 20_000);

afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

describe.skipIf(!CHROME_AVAILABLE)("smart scroll clears a band over the target", () => {
  for (const [name, html, box] of [
    ["a fixed bar on a page whose body is the scroller", BODY_SCROLLER, "body"],
    ["a site bar over a panel that cannot scroll that way, cleared by the document", PANEL, "document"],
    ["a fixed bar rendered inside a web component's shadow root", SHADOW_BAR, "document"],
    ["a sticky document bar over a target in a plain wrapper", DOC_BAR("1"), "document"],
    ["a bar under an invisible 2px fixed loader (GitHub)", GITHUB_LIKE, "document"],
    ["a bar over a target whose top lands a fraction above the window (MDN, GitHub)", FRACTION, "document"],
    ["a z-index:auto sticky bar", DOC_BAR("auto"), "document"],
    ["a sticky bar on a page with scroll-behavior:smooth", DOC_BAR("1").replace("html,body{margin:0}", "html,body{margin:0} html{scroll-behavior:smooth}"), "document"],
    ["a bar whose child is at the point", CHILD_BAR, "document"],
    ["a sticky bar inside a scroller", BOX_BAR, "div#sc"],
  ] as const) {
    it(`${name}, scrolled to start, is cleared by scrolling ${box}`, async () => {
      await load(html);
      const r = await scroll("#t", "start");
      expect(r.ok).toBe(true);
      expect(r.occludedBy).toMatchObject({ header: true, side: "top", box, stillCovered: false });
      expect(r.occludedBy.movedPx).toBeGreaterThan(0);
      expect(r.warnings).toContainEqual(expect.stringMatching(new RegExp(`scrolled '${box}' ${r.occludedBy.movedPx}px to clear it`)));
      expect(await shownAt("top")).toBe(true);
    });
  }

  for (const [name, html] of [
    ["a sticky document bar", DOC_BAR("1")],
    ["a sticky bar inside a scroller", BOX_BAR],
  ] as const) {
    it(`${name} that does not cover a centred target is left alone`, async () => {
      await load(html);
      const r = await scroll("#t", "center");
      expect(r.ok).toBe(true);
      expect(r.occludedBy).toBeUndefined();
      expect(r.warnings ?? []).not.toContainEqual(expect.stringMatching(/band/));
      expect(await shownAt("top")).toBe(true);
      // Where scrollIntoView center alone leaves it: the target's centre at its box's centre (/code-review).
      expect(await evaluateInTab(`(() => { const t = document.getElementById('t').getBoundingClientRect();
        const sc = document.getElementById('sc'); const b = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
        return Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2) < 2; })()`, null, PORT)).toBe(true);
    });
  }

  it("a bottom band over a target scrolled to end is cleared when the page has room below", async () => {
    await load(BOTTOM(1500));
    const r = await scroll("#t", "end");
    expect(r.occludedBy).toMatchObject({ side: "bottom", box: "document", stillCovered: false });
    expect(await shownAt("bottom")).toBe(true);
  });

  it("a bottom band the page cannot scroll past is said to still cover the target", async () => {
    await load(BOTTOM(0));
    const r = await scroll("#t", "end");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toMatchObject({ side: "bottom", stillCovered: true });
    expect(r.warnings).toContainEqual(expect.stringMatching(/no box around it could scroll to clear it/));
    expect(await shownAt("bottom")).toBe(false);
  });

  it("a popover in the middle of the window is not a band", async () => {
    await load(`${head}<div id="pop" popover style="height:40px">pop</div>${filler(1500)}<div id="t" style="height:40px">target</div>${filler(1500)}
      <script>document.getElementById('pop').showPopover();</script>`);
    const r = await scroll("#t", "center");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toBeUndefined();
  });

  it("a bottom band the page can scroll only partly past is said to still cover the target after the scroll", async () => {
    await load(BOTTOM(20));
    const r = await scroll("#t", "end");
    expect(r.occludedBy).toMatchObject({ side: "bottom", box: "document", stillCovered: true });
    expect(r.occludedBy.movedPx).toBeGreaterThan(0);
    expect(r.warnings).toContainEqual(expect.stringMatching(/still under a bottom band 'div#ban' after that scroll/));
    expect(await shownAt("bottom")).toBe(false);
  });

  it("a sticky row inside a fixed header is passed for the header", async () => {
    await load(ROW_IN_HEADER);
    const r = await scroll("#t", "start");
    expect(r.occludedBy).toMatchObject({ side: "top", by: "header#hd", stillCovered: true });
  });

  it("clearing a top bar that puts the bottom edge under a banner says so", async () => {
    await load(BOTH);
    const r = await scroll("#t", "start");
    expect(r.occludedBy).toMatchObject({ side: "top", stillCovered: true, nowCovered: "bottom", nowCoveredBy: "div#ban" });
    expect(r.warnings).toContainEqual(expect.stringMatching(/put the target's bottom edge under a bottom band 'div#ban'/));
    expect(await shownAt("bottom")).toBe(false);
  });

  it("a clearing scroll the page snaps back says the box did not move", async () => {
    await load(SNAP);
    const r = await scroll("#t", "start");
    expect(r.occludedBy).toMatchObject({ side: "top", box: "div#sc", movedPx: 0, stillCovered: true });
    expect(r.warnings).toContainEqual(expect.stringMatching(/was scrolled to clear it, and did not move/));
  });

  it("a full-window veil is not a band", async () => {
    await load(VEIL);
    const r = await scroll("#t", "center");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toBeUndefined();
  });

  it("a centred target taller than the window is not probed at an edge it does not show", async () => {
    await load(TALL);
    const r = await scroll("#t", "center");
    expect(r.ok).toBe(true);
    expect(r.occludedBy).toBeUndefined();
    // Centred: the bar did not move it (the spike's Stack Overflow false positive shifted it 684px).
    expect(await evaluateInTab(`(() => { const r = document.getElementById('t').getBoundingClientRect();
      return Math.abs((r.top + r.bottom) / 2 - innerHeight / 2) < 2; })()`, null, PORT)).toBe(true);
  });
});
