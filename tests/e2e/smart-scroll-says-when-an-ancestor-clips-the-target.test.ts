/**
 * scroll(action:'smart') answers TargetClipped, not in-view, when the target ends up inside the window but an
 * ancestor cuts it off, so it is not on screen.
 *
 * MEASURED on main (mac, headless Chrome): a row 1800px down an overflow:clip box, and one under a clip-path box,
 * both answered ok:true, viewportPosition:'in-view'. Nothing at the row's centre was the row. in-view looked only
 * at the window, and the ancestor walk counts overflow:hidden/auto/scroll, not clip, clip-path or contain.
 *
 * Clipped needs two witnesses:
 * - The target is missing at its own centre. Alone, this would also refuse a pointer-events:none target (that cell
 *   guards the second witness).
 * - Nothing of the target's box is left once the window and each clipping ancestor's box are cut from it. Alone,
 *   this would also refuse a position:fixed child of a clip box, which escapes it (that cell guards the first witness).
 * A tall target partly shown is not clipped. Neither is a position:absolute target that escapes an overflow box,
 * since overflow clips only what has the box on its containing-block chain. A full-window overlay covers the target;
 * it does not clip it.
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
<div id="clip" style="height:200px;overflow:clip">${rows("c")}</div>
<div id="cp" style="height:200px;clip-path:inset(0)"><div>${rows("p")}</div></div>
<div id="paint" style="height:200px;contain:paint"><div>${rows("k")}</div></div>
<div id="pen" style="height:200px;overflow:auto"><div style="pointer-events:none">${rows("e")}</div></div>
<div id="clipfix" style="height:200px;overflow:clip"><div id="fixed" style="position:fixed;top:300px;left:0;height:40px">fixed</div>${rows("x")}</div>
<div id="short" style="height:100px;overflow:auto"><div style="height:300px"></div><div id="tall" style="height:500px">tall</div><div style="height:300px"></div></div>
<div style="position:relative"><div id="ab" style="overflow:auto;height:100px"><div id="abs" style="position:absolute;top:300px;pointer-events:none">abs</div></div></div>
<div id="free" style="height:200px;overflow:auto">${rows("f")}</div>
<div id="ovl" style="height:200px;overflow:auto">${rows("o")}</div>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.1)"></div>`;

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
  await evaluateInTab(`location.reload()`, null, PORT).catch(() => undefined);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(100);
    try { if (await evaluateInTab("document.readyState", null, PORT) === "complete") break; } catch { /* reloading */ }
  }
  await evaluateInTab(`scrollTo(0, 0); document.querySelectorAll('div').forEach((b) => { b.scrollTop = 0; b.scrollLeft = 0; }); 1`, null, PORT);
});

afterAll(() => {
  disconnectAll(PORT);
  chrome?.kill();
});

describe.skipIf(!CHROME_AVAILABLE)("smart scroll says when an ancestor clips the target off", () => {
  for (const [name, target, box] of [
    ["overflow:clip", "#c-45", "div#clip"],
    ["clip-path", "#p-45", "div#cp"],
    ["contain:paint", "#k-45", "div#paint"],
  ] as const) {
    it(`a row cut off by ${name} answers TargetClipped naming the box`, async () => {
      const r = await scroll(target);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("TargetClipped");
      expect(r.context.clippedBy).toBe(box);
      expect(r.error).toContain(`'${box}' cuts it off`);
      // The scroll already ran: the answer still says what it walked.
      expect(Array.isArray(r.context.ancestors)).toBe(true);
      // The truth the answer is about: nothing at the row's centre is the row.
      expect(await evaluateInTab(`(() => { const t = document.querySelector(${JSON.stringify(target)}); const b = t.getBoundingClientRect();
        return document.elementsFromPoint(b.left + b.width / 2, b.top + b.height / 2).includes(t); })()`, null, PORT)).toBe(false);
    });
  }

  it("a pointer-events:none row in a scroller is in view (missing at its centre is not clipped)", async () => {
    const r = await scroll("#e-45");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
  });

  it("a position:fixed child of an overflow:clip box is in view (outside the box is not clipped)", async () => {
    const r = await scroll("#fixed");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
  });

  it("a tall target scrolled to the start of a short scroller is in view (partly shown is not clipped)", async () => {
    const r = await scroll("#tall", "start");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
  });

  it("a position:absolute pointer-events:none target that escapes an overflow box is in view", async () => {
    const r = await scroll("#abs");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
  });

  it("a row under a full-window overlay is in view (covered is not clipped)", async () => {
    const r = await scroll("#o-45");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
  });

  it("a row in an ordinary scroller is in view", async () => {
    const r = await scroll("#f-45");
    expect(r.ok).toBe(true);
    expect(r.viewportPosition).toBe("in-view");
    expect(await evaluateInTab(`document.getElementById('free').scrollTop`, null, PORT)).toBeGreaterThan(0);
  });
});
