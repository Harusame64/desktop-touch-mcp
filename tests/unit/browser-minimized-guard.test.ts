/**
 * browser-minimized-guard.test.ts — unit boundary tests for the minimized /
 * off-screen-parked window predicate that gates browser_click.
 *
 * A minimized Chrome/Edge window reports window.screenX/screenY === -32000 (the
 * Windows parking marker) while the page layout stays valid, so a viewport→screen
 * conversion yields an off-screen-negative point the OS clamps to (0,0); an OS
 * click there trips the top-left failsafe and kills the server. `isOffscreenMinimized`
 * detects this from the window origin so the click paths can stop with a typed
 * BrowserTargetMinimized failure instead. The threshold is the EXACT parking
 * marker so a legitimately negative-origin secondary monitor is never mis-flagged.
 *
 * @see src/engine/cdp-bridge.ts  isOffscreenMinimized / MINIMIZED_WINDOW_SCREEN_COORD
 */

import { describe, it, expect } from "vitest";
import { isOffscreenMinimized, MINIMIZED_WINDOW_SCREEN_COORD } from "../../src/engine/cdp-bridge.js";

describe("isOffscreenMinimized — minimized-window detection", () => {
  it("the marker constant is the Windows -32000 parking value", () => {
    expect(MINIMIZED_WINDOW_SCREEN_COORD).toBe(-32000);
  });

  it("flags a minimized window (both axes at -32000, the dogfood signal)", () => {
    // Live dogfood: {"screenX":-32000,"screenY":-32000,...} on a minimized GSC tab.
    expect(isOffscreenMinimized(-32000, -32000)).toBe(true);
  });

  it("flags when EITHER axis hits the marker", () => {
    expect(isOffscreenMinimized(-32000, 0)).toBe(true);
    expect(isOffscreenMinimized(100, -32000)).toBe(true);
  });

  it("flags values beyond the marker (defensive ≤, not ===)", () => {
    expect(isOffscreenMinimized(-32001, 0)).toBe(true);
    expect(isOffscreenMinimized(0, -40000)).toBe(true);
  });

  it("does NOT flag a normal on-screen window", () => {
    expect(isOffscreenMinimized(0, 0)).toBe(false);
    expect(isOffscreenMinimized(1920, 0)).toBe(false);
    expect(isOffscreenMinimized(120, 80)).toBe(false);
  });

  it("does NOT flag a legitimate left/top secondary monitor (negative but far above the marker)", () => {
    // A second display positioned to the left/top has a negative origin (e.g.
    // -1920, -1080) that is NOT a minimized window — must stay clickable.
    expect(isOffscreenMinimized(-1920, 0)).toBe(false);
    expect(isOffscreenMinimized(-2560, -1440)).toBe(false);
    expect(isOffscreenMinimized(-31999, -31999)).toBe(false); // just inside the marker
  });
});

describe("the minimized refusal's road (internal #401)", () => {
  it("names focus_window by hwnd and where to read the hwnd, and keeps the browser_fill road", async () => {
    const { browserMinimizedFailure } = await import("../../src/tools/browser.js");
    const j = JSON.parse((browserMinimizedFailure({ selector: "#c" }).content[0] as { text: string }).text) as { code: string; suggest: string[] };
    expect(j.code).toBe("BrowserTargetMinimized");
    expect(j.suggest[0]).toContain("desktop_discover lists windows[]");
    expect(j.suggest[0]).toContain('focus_window({ hwnd: "<its hwnd>" })');
    expect(j.suggest.at(-1)).toMatch(/browser_fill/);
  });
});
