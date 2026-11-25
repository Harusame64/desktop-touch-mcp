/**
 * scroll(action:'smart', expandHidden:true) scrolls a target into view inside an overflow:hidden ancestor and
 * leaves the page's CSS as it was. Without it, such a target is refused (OverflowHiddenAncestor).
 *
 * MEASURED on main (mac, headless Chrome): the container was unlocked to overflow:auto and put back in the same
 * call before any scroll, while the answer said "overflow:hidden unlocked — call smart_scroll again to restore".
 * The target was reached all the same (scrollTop 1720, in-view): scrollIntoView scrolls an overflow:hidden box.
 * The put-back wrote overflow:hidden inline whatever the element had, so a stylesheet's hidden became an
 * inline style.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { launchChrome, tryFindChrome, type ChromeInstance } from "./helpers/chrome-launcher.js";
import { evaluateInTab, disconnectAll } from "../../src/engine/cdp-bridge.js";
import { smartScrollHandler } from "../../src/tools/smart-scroll.js";
import { parsePayload } from "./helpers/wait.js";

const PORT = 9251;
const CHROME_AVAILABLE = tryFindChrome() !== null;
let chrome: ChromeInstance;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const rows = Array.from({ length: 60 }, (_, i) => `<div id="row-${i}" style="height:40px">row ${i}</div>`).join("");
// #locked clips its rows with overflow:hidden; #free is an ordinary scroller.
const HTML = `<title>t</title>
<div id="locked" style="height:200px;overflow:hidden">${rows.replace(/row-/g, "lrow-")}</div>
<div id="free" style="height:200px;overflow:auto">${rows.replace(/row-/g, "frow-")}</div>`;

async function scroll(target: string, expandHidden: boolean) {
  return parsePayload(await smartScrollHandler({
    target, port: PORT, strategy: "cdp", direction: "into-view", inline: "center",
    maxDepth: 10, retryCount: 1, verifyWithHash: false, expandHidden,
  } as never));
}

const scrollTopOf = (id: string) => evaluateInTab(`document.getElementById(${JSON.stringify(id)}).scrollTop`, null, PORT);

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
  await evaluateInTab(`location.reload()`, null, PORT).catch(() => undefined);
  await sleep(500);
});

afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

describe.skipIf(!CHROME_AVAILABLE)("expandHidden scrolls inside an overflow:hidden ancestor without changing CSS", () => {
  it("reaches the target, leaves the inline style as it was, and says the CSS was not changed", async () => {
    const before = await evaluateInTab(`document.getElementById('locked').style.cssText`, null, PORT);
    const r = await scroll("#lrow-45", true);
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(await scrollTopOf("locked")).toBeGreaterThan(0);
    expect(await evaluateInTab(`document.getElementById('locked').style.cssText`, null, PORT)).toBe(before);
    expect(await evaluateInTab(`document.querySelectorAll('[data-dt-prev-overflow],[data-dt-hidden-ancestor]').length`, null, PORT)).toBe(0);
    expect(r.warnings.join("\n")).toMatch(/scrolled inside overflow:hidden 'div#locked'; the page's CSS is not changed/);
    expect(r.warnings.join("\n")).not.toMatch(/call smart_scroll again to restore/);
  });

  it("a container clipped by a stylesheet gets no inline style", async () => {
    await evaluateInTab(`(() => { const s = document.createElement('style'); s.textContent = '#locked2 { overflow: hidden; height: 200px }'; document.head.append(s);
      const d = document.createElement('div'); d.id = 'locked2'; d.innerHTML = Array.from({ length: 60 }, (_, i) => '<div id="xrow-' + i + '" style="height:40px">x' + i + '</div>').join(''); document.body.append(d); })()`, null, PORT);
    const r = await scroll("#xrow-50", true);
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(await evaluateInTab(`document.getElementById('locked2').getAttribute('style')`, null, PORT)).toBe(null);
  });

  it("the CSS is not changed at any point during the call", async () => {
    // Record every overflow the container takes while the call runs.
    await evaluateInTab(`(() => { const el = document.getElementById('locked'); window.__seen = [];
      new MutationObserver(() => window.__seen.push(el.style.overflow)).observe(el, { attributes: true, attributeFilter: ['style'] }); })()`, null, PORT);
    const r = await scroll("#lrow-45", true);
    expect(r.ok).toBe(true);
    await sleep(50);
    expect(await evaluateInTab(`window.__seen`, null, PORT)).toEqual([]);
  });

  it("without expandHidden a clipped target is refused, and nothing is changed", async () => {
    const before = await evaluateInTab(`document.getElementById('locked').style.cssText`, null, PORT);
    // A reload keeps the scroll position, so compare with what it is now.
    const topBefore = await scrollTopOf("locked");
    const r = await scroll("#lrow-45", false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OverflowHiddenAncestor/);
    expect(await scrollTopOf("locked")).toBe(topBefore);
    expect(await evaluateInTab(`document.getElementById('locked').style.cssText`, null, PORT)).toBe(before);
  });

  it("an ordinary scroller is scrolled as before, with no expandHidden note", async () => {
    const r = await scroll("#frow-30", false);
    expect(r.ok).toBe(true);
    expect(await scrollTopOf("free")).toBeGreaterThan(0);
    expect((r.warnings ?? []).join("\n")).not.toMatch(/expandHidden/);
  });
});
