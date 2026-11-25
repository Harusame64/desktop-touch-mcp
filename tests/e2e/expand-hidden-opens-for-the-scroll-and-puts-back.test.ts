/**
 * scroll(action:'smart', expandHidden:true): "Temporarily set overflow:hidden ancestors to overflow:auto to
 * unlock scroll." The container is opened for the scroll and put back when it ends.
 *
 * MEASURED on main (mac, headless Chrome): the restore ran right after the unlock, before any scroll, while
 * the answer said "overflow:hidden unlocked — call smart_scroll again to restore". Nothing stayed unlocked
 * and there was nothing to restore. The target was still reached (scrollTop 1720, in-view): scrollIntoView
 * scrolls an overflow:hidden box. And the restore wrote overflow:'hidden' inline, whatever the element had.
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

const overflowOf = (id: string) => evaluateInTab(`document.getElementById(${JSON.stringify(id)}).style.overflow || getComputedStyle(document.getElementById(${JSON.stringify(id)})).overflow`, null, PORT);
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

describe.skipIf(!CHROME_AVAILABLE)("expandHidden opens a clipping container for the scroll and puts it back", () => {
  it("reaches the target and leaves the container as it was, with an answer that says so", async () => {
    const before = await evaluateInTab(`document.getElementById('locked').style.cssText`, null, PORT);
    const r = await scroll("#lrow-45", true);
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(await scrollTopOf("locked")).toBeGreaterThan(0);
    expect(await overflowOf("locked")).toBe("hidden");
    // The element's own inline style is as it was.
    expect(await evaluateInTab(`document.getElementById('locked').style.cssText`, null, PORT)).toBe(before);
    expect(await evaluateInTab(`document.querySelectorAll('[data-dt-prev-overflow],[data-dt-hidden-ancestor]').length`, null, PORT)).toBe(0);
    expect(r.warnings.join("\n")).toMatch(/opened for this scroll and put back when it ended/);
    expect(r.warnings.join("\n")).not.toMatch(/call smart_scroll again to restore/);
  });

  it("a container clipped by a stylesheet gets no inline overflow left behind", async () => {
    await evaluateInTab(`(() => { const s = document.createElement('style'); s.textContent = '#locked2 { overflow: hidden; height: 200px }'; document.head.append(s);
      const d = document.createElement('div'); d.id = 'locked2'; d.innerHTML = Array.from({ length: 60 }, (_, i) => '<div id="xrow-' + i + '" style="height:40px">x' + i + '</div>').join(''); document.body.append(d); })()`, null, PORT);
    const r = await scroll("#xrow-50", true);
    expect(r.ok).toBe(true);
    expect(await evaluateInTab(`document.getElementById('locked2').style.overflow`, null, PORT)).toBe("");
    expect(await overflowOf("locked2")).toBe("hidden");
  });

  it("without expandHidden a clipped target is refused, and the walk's markers are removed", async () => {
    const r = await scroll("#lrow-45", false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OverflowHiddenAncestor/);
    expect(await overflowOf("locked")).toBe("hidden");
    expect(await evaluateInTab(`document.querySelectorAll('[data-dt-hidden-ancestor]').length`, null, PORT)).toBe(0);
  });

  it("what a call that failed part-way left open is put back by the next smart scroll", async () => {
    // As an unlock leaves it: opened, with the previous inline overflow recorded.
    await evaluateInTab(`(() => { const el = document.getElementById('locked'); el.setAttribute('data-dt-prev-overflow', 'hidden'); el.style.overflow = 'auto'; })()`, null, PORT);
    const r = await scroll("#frow-30", false);
    expect(r.ok).toBe(true);
    expect(await overflowOf("locked")).toBe("hidden");
    expect(await evaluateInTab(`document.querySelectorAll('[data-dt-prev-overflow]').length`, null, PORT)).toBe(0);
  });

  it("a container left open by such a call is judged as the page has it: hidden, so refused without expandHidden", async () => {
    await evaluateInTab(`(() => { const el = document.getElementById('locked'); el.setAttribute('data-dt-prev-overflow', 'hidden'); el.style.overflow = 'auto'; })()`, null, PORT);
    const r = await scroll("#lrow-45", false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OverflowHiddenAncestor/);
  });
});
