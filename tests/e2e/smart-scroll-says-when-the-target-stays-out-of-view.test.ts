/**
 * internal #433 — scroll(action:'smart') answers TargetOutOfView, not ok:true scrolled:true, when the scroll leaves the
 * target outside the window; and `scrolled` says whether anything on the page moved.
 *
 * MEASURED on main 38d940c8 (win2, internal dev/w433-measure): a row in an overflow:clip box on a page too short to
 * scroll, a position:fixed target at top:-500px and one moved out by translateX(-3000px) all answered ok:true
 * scrolled:true with 'below' / 'above' / 'left'. Nothing moved and none of them was on screen. A hidden tab answered
 * the same, with no warning.
 *
 * In view is decided by overlap, not by the centre. win2 measured a 2000px target scrolled to its start filling the
 * screen with its centre below it, so a centre rule would refuse it. The overlap cells assert the screen truth beside
 * the answer.
 *
 * Each cell writes its own page: the clip row is out of reach only on a page that cannot scroll, which the tall
 * target's page can.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { smartScrollHandler } from "../../src/tools/smart-scroll.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9253;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const rows = Array.from({ length: 60 }, (_, i) => `<div id="r${i}" style="height:30px">row ${i}</div>`).join("");
/** Nothing on this page can scroll: the clip box's rows add no scrollable overflow, nor does what sits above or left. */
const SHORT = `<!doctype html><title>short</title><style>html,body{margin:0}</style>
<div id="clip" style="height:150px;overflow:clip">${rows}</div>
<div id="fixed" style="position:fixed;top:-500px;left:0;height:40px">fixed</div>
<div id="moved" style="height:40px;transform:translateX(-3000px)">moved</div>
<div id="near" style="height:40px">near</div>
<div id="edge" style="position:fixed;left:0;top:calc(100vh - 1px);height:200px;width:100px">edge</div>
<div id="most" style="position:fixed;left:200px;top:calc(100vh - 150px);height:200px;width:100px">most</div>
<form id="f"><input name="parentNode"><input name="assignedSlot"><input name="scrollTop"><div id="inform" style="height:20px">in a form</div></form>`;
const TALL = `<!doctype html><title>tall</title><style>html,body{margin:0}</style>
<div id="top-shown" style="height:2000px;margin-top:300px;background:#ddd">top shown</div>
<div style="height:1500px"></div>
<div id="tall" style="height:2000px;background:#eee">tall</div>
<div style="height:1500px"></div>`;

async function load(html: string) {
  await evaluateInTab(`document.open(); document.write(${JSON.stringify(html)}); document.close(); delete document.visibilityState; scrollTo(0, 0); 1`, null, PORT);
  await evaluateInTab(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`, null, PORT);
}

async function scroll(target: string, inline = "center") {
  return parsePayload(await smartScrollHandler({
    target, port: PORT, strategy: "cdp", direction: "into-view", inline,
    maxDepth: 10, retryCount: 1, verifyWithHash: false, expandHidden: false,
  } as never));
}

/** The screen truth: how much of the target's box overlaps the window, in px of height and width. */
async function overlap(target: string): Promise<{ h: number; w: number }> {
  return await evaluateInTab(`(() => { const b = document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();
    return { h: Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0)),
             w: Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) }; })()`, null, PORT) as { h: number; w: number };
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

describe.skipIf(!CHROME_AVAILABLE)("smart scroll says when the target stays out of view", () => {
  for (const [name, target, side] of [
    ["a row in an overflow:clip box on a page that cannot scroll (internal #433)", "#r50", "below"],
    ["a position:fixed target above the window", "#fixed", "above"],
    ["a target a transform moves left of the window", "#moved", "left"],
  ] as const) {
    it(`${name} answers TargetOutOfView, nothing scrolled`, async () => {
      await load(SHORT);
      const r = await scroll(target);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("TargetOutOfView");
      expect(r.error).toContain("nothing on the page scrolled");
      expect(r.context).toMatchObject({ path: "cdp", scrolled: false, viewportPosition: side });
      expect(Array.isArray(r.context.ancestors)).toBe(true);
      // The truth the answer is about: none of the target overlaps the window.
      const o = await overlap(target);
      expect(o.h === 0 || o.w === 0).toBe(true);
    });
  }

  it("a hidden page answers the same, from the target's position", async () => {
    await load(SHORT);
    await evaluateInTab(`Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); 1`, null, PORT);
    const r = await scroll("#r50");
    expect(r.code).toBe("TargetOutOfView");
    expect(r.context).toMatchObject({ scrolled: false, viewportPosition: "below" });
  });

  it("a target already in view answers ok, scrolled:false", async () => {
    await load(SHORT);
    const r = await scroll("#near", "nearest");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(r.scrolled).toBe(false);
  });

  it("a target taller than the window scrolled to its start is in view, though its centre is below", async () => {
    await load(TALL);
    const r = await scroll("#tall", "start");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(r.scrolled).toBe(true);
    // The truth: it fills the window, with its centre below it.
    expect((await overlap("#tall")).h).toBe(await evaluateInTab("innerHeight", null, PORT));
    expect(await evaluateInTab(`(() => { const b = document.getElementById('tall').getBoundingClientRect();
      return b.top + b.height / 2 > innerHeight; })()`, null, PORT)).toBe(true);
    // The browser was asked whether an ancestor clips it: in-view is not the window's answer alone.
    expect(r.warnings ?? []).not.toContainEqual(expect.stringMatching(/viewportPosition says only/));
  });

  it("a tall target whose top is shown, scrolled with nearest, is in view", async () => {
    await load(TALL);
    const r = await scroll("#top-shown", "nearest");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    // nearest aligns a box larger than the window to its start, so the window moves (/code-review).
    expect(r.scrolled).toBe(true);
    expect((await overlap("#top-shown")).h).toBe(await evaluateInTab("innerHeight", null, PORT));
  });

  it("a box smaller than the window with 1px on screen is not in view: a click at its centre would miss", async () => {
    await load(SHORT);
    const r = await scroll("#edge");
    expect(r.code).toBe("TargetOutOfView");
    expect(r.context.viewportPosition).toBe("below");
    expect((await overlap("#edge")).h).toBe(1);
  });

  it("a box with most of it on screen is in view", async () => {
    await load(SHORT);
    const r = await scroll("#most");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
  });

  it("a form whose controls are named parentNode, assignedSlot and scrollTop does not stop the offsets read", async () => {
    await load(SHORT);
    const r = await scroll("#inform", "nearest");
    expect(r.ok).toBe(true);
    expect(r.scrolled).toBe(false);
    expect(r.warnings ?? []).not.toContainEqual(expect.stringMatching(/Whether anything scrolled was not read/));
  });

  it("target 'body' on a page scrolled past one screen is ok: the root is in view by definition", async () => {
    await load(TALL);
    await evaluateInTab("scrollTo(0, 3000); 1", null, PORT);
    const r = await scroll("body");
    expect(r.ok).toBe(true);
    expect(await evaluateInTab("scrollY", null, PORT)).toBe(3000);
  });

  it("a target down a long page answers ok, scrolled:true", async () => {
    await load(TALL);
    const r = await scroll("#tall", "center");
    expect(r.ok).toBe(true);
    expect(r.scrolled).toBe(true);
    expect(await evaluateInTab("scrollY", null, PORT)).toBeGreaterThan(0);
  });
});
