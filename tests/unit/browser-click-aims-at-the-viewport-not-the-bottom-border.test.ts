/**
 * internal #304 — browser_click aimed ~8 px below the element centre on
 * Windows: the viewport-to-screen conversion took outerHeight - innerHeight as
 * the viewport's top inset, which also holds the frame's invisible bottom
 * border. Measured by win2 on PR #834: a `#btn` centred at css 230 was pressed
 * at css 238.
 *
 * The cells run VIEWPORT_ORIGIN_JS against window metrics shaped like the
 * three frames it has to handle, then convert through physicalPoint (the
 * browser_click({by}) path). The last cell keeps both conversions on the one
 * fragment so the selector path cannot drift from the by-axis path again.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { VIEWPORT_ORIGIN_JS } from "../../src/engine/cdp-bridge.js";
import { physicalPoint, type ViewportMetrics } from "../../src/tools/browser-resolver.js";

interface WindowShape {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
}

function metrics(w: WindowShape, dpr = 1): ViewportMetrics {
  const run = new Function("window", `${VIEWPORT_ORIGIN_JS}\nreturn { chromeW: chromeW, chromeH: chromeH };`) as
    (win: WindowShape) => { chromeW: number; chromeH: number };
  const { chromeW, chromeH } = run(w);
  return { screenX: w.screenX, screenY: w.screenY, dpr, chromeW, chromeH, innerWidth: w.innerWidth, innerHeight: w.innerHeight };
}

// A 60x20 button whose centre is at css (330, 230), as in win2's page.
const btn = { x: 300, y: 220, w: 60, h: 20 };
// Tab strip + address bar on Chrome for Windows at 100 %.
const TOOLBAR = 87;
const BORDER = 8;

describe("internal #304: the viewport top inset leaves out the bottom border", () => {
  it("Windows, restored window: 8 px side and bottom borders", () => {
    const vp = metrics({
      screenX: 100, screenY: 50,
      outerWidth: 1200 + 2 * BORDER, outerHeight: TOOLBAR + 800 + BORDER,
      innerWidth: 1200, innerHeight: 800,
    });
    expect(vp.chromeW).toBe(BORDER);
    expect(vp.chromeH).toBe(TOOLBAR);
    // css 230 inside the viewport, not 238
    expect(physicalPoint(btn, vp)).toEqual({ x: 100 + BORDER + 330, y: 50 + TOOLBAR + 230 });
  });

  it("Windows, maximized: the borders hang off screen on every side, the top one too", () => {
    // screenY is -8 and outerHeight holds a top border as well, so the top
    // inset is TOOLBAR + 8 above a screen origin 8 px off the top: still TOOLBAR on screen.
    const vp = metrics({
      screenX: -BORDER, screenY: -BORDER,
      outerWidth: 1920 + 2 * BORDER, outerHeight: BORDER + TOOLBAR + 900 + BORDER,
      innerWidth: 1920, innerHeight: 900,
    });
    expect(physicalPoint(btn, vp)).toEqual({ x: 330, y: TOOLBAR + 230 });
  });

  it("macOS: no side border, so nothing is taken off the top inset", () => {
    const vp = metrics({
      screenX: 0, screenY: 25,
      outerWidth: 1440, outerHeight: 80 + 760,
      innerWidth: 1440, innerHeight: 760,
    }, 2);
    expect(vp.chromeW).toBe(0);
    expect(vp.chromeH).toBe(80);
    expect(physicalPoint(btn, vp)).toEqual({ x: 330 * 2, y: (25 + 80 + 230) * 2 });
  });

  it("a side panel widens the gap: the bottom border is left in rather than aiming into the tab strip", () => {
    // Chrome's side panel (400 css) beside the page: outerWidth - innerWidth is
    // 416, so half of it is not a border. Taking 208 off would put the click
    // ~200 px up, above the viewport.
    const vp = metrics({
      screenX: 100, screenY: 50,
      outerWidth: 1200 + 400 + 2 * BORDER, outerHeight: TOOLBAR + 800 + BORDER,
      innerWidth: 1200, innerHeight: 800,
    });
    expect(vp.chromeH).toBe(TOOLBAR + BORDER);
    expect(physicalPoint(btn, vp).y).toBe(50 + TOOLBAR + BORDER + 230);
  });

  it("both conversions read the window through the one fragment", () => {
    // The selector path (getElementScreenCoords) builds its expression inside
    // the function, so this cell reads the sources: outerHeight appears only
    // in VIEWPORT_ORIGIN_JS, and both expressions interpolate it.
    const bridge = readFileSync(new URL("../../src/engine/cdp-bridge.ts", import.meta.url), "utf8");
    const resolver = readFileSync(new URL("../../src/tools/browser-resolver.ts", import.meta.url), "utf8");
    const code = (src: string) => src.split("\n").filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(code(bridge).match(/window\.outerHeight/g)).toHaveLength(1);
    expect(code(resolver)).not.toMatch(/window\.outerHeight/);
    expect(bridge).toContain("${VIEWPORT_ORIGIN_JS}");
    expect(resolver).toContain("${VIEWPORT_ORIGIN_JS}");
  });
});
