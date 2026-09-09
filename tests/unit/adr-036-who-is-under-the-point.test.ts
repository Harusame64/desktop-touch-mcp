/**
 * A rectangle can contain a point that another window is drawn over.
 *
 * ADR-036 item 6, the middle rung of the specification's ladder for a coordinate press:
 *
 * > `mouse_click(x, y)` → if rect moved, apply homing correction → **if another top-level window
 * > covers point, block or refocus** → if target identity changed, invalidate coordinates
 *
 * The containment check answers a different question, and the difference is measurable: building
 * the cell for the stale-coordinate hole, win2's first run pressed through `設定` / `XBOX` /
 * `EAWorkWindow` windows sitting over the point and read the empty fixture log as "nothing was
 * pressed". Raising the fixture to TOPMOST produced a clean cell for that question and quietly
 * removed the evidence for this one.
 *
 * The other half these tests hold is the false refusal the containment check makes today: a combo
 * dropdown, a context menu and a tooltip are separate top-level windows that sit OUTSIDE their
 * owner's rectangle, and they are what a caller means to press when they discovered one.
 */
import { describe, it, expect, vi } from "vitest";
import { whoIsUnderPoint } from "../../src/engine/point-owner.js";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import { AimOccludedError, type Aim } from "../../src/engine/aim.js";
import type { WindowZInfo } from "../../src/engine/win32.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const AIM = 4919n;
const OTHER = 777n;
const POPUP = 888n;

function win(over: Partial<WindowZInfo> & { hwnd: bigint; zOrder: number }): WindowZInfo {
  return {
    title: `w${over.hwnd}`,
    region: { x: 0, y: 0, width: 1000, height: 1000 },
    isMinimized: false,
    isMaximized: false,
    isActive: false,
    ...over,
  } as WindowZInfo;
}

function enumerating(...windows: WindowZInfo[]) {
  return { enumerate: () => windows };
}

describe("who would take the press", () => {
  it("says the aim when the aim is on top at that point", () => {
    const deps = enumerating(win({ hwnd: AIM, zOrder: 0 }), win({ hwnd: OTHER, zOrder: 1 }));
    expect(whoIsUnderPoint(AIM, 500, 500, deps)).toEqual({ kind: "aim" });
  });

  it("names the stranger that covers it", () => {
    // Z-order 0 is frontmost. The aim's rectangle still contains the point — which is exactly why
    // the containment check waves this through.
    const deps = enumerating(
      win({ hwnd: OTHER, zOrder: 0, title: "設定" }),
      win({ hwnd: AIM, zOrder: 1 }),
    );
    expect(whoIsUnderPoint(AIM, 500, 500, deps)).toEqual({ kind: "other", hwnd: OTHER, title: "設定" });
  });

  it("recognises a popup the aim owns, which is where dropdowns live", () => {
    const deps = enumerating(
      win({ hwnd: POPUP, zOrder: 0, ownerHwnd: AIM, title: "" , region: { x: 400, y: 900, width: 200, height: 300 } }),
      win({ hwnd: AIM, zOrder: 1, region: { x: 0, y: 0, width: 1000, height: 800 } }),
    );
    // The point is BELOW the aim's rectangle — a dropdown hanging off the bottom of its owner.
    expect(whoIsUnderPoint(AIM, 500, 1000, deps)).toEqual({ kind: "owned", hwnd: POPUP, title: "" });
  });

  it("follows the owner chain more than one hop, and does not spin on a loop", () => {
    const mid = 999n;
    const looped = enumerating(
      win({ hwnd: POPUP, zOrder: 0, ownerHwnd: mid }),
      win({ hwnd: mid, zOrder: 1, ownerHwnd: AIM }),
      win({ hwnd: AIM, zOrder: 2 }),
    );
    expect(whoIsUnderPoint(AIM, 500, 500, looped).kind).toBe("owned");

    const a = 1n, b = 2n;
    const cycle = enumerating(
      win({ hwnd: a, zOrder: 0, ownerHwnd: b }),
      win({ hwnd: b, zOrder: 1, ownerHwnd: a }),
    );
    expect(whoIsUnderPoint(AIM, 500, 500, cycle).kind).toBe("other");
  });

  it("ignores windows that cannot take a press", () => {
    // Minimised (parked rect), DWM-cloaked (a virtual desktop's leftovers), and click-through
    // (`WS_EX_TRANSPARENT | WS_EX_LAYERED`) windows are drawn over nothing the user can hit.
    const deps = enumerating(
      win({ hwnd: 11n, zOrder: 0, isMinimized: true }),
      win({ hwnd: 12n, zOrder: 1, isCloaked: true }),
      win({ hwnd: 13n, zOrder: 2, exStyle: 0x00000020 | 0x00080000 }),
      win({ hwnd: AIM, zOrder: 3 }),
    );
    expect(whoIsUnderPoint(AIM, 500, 500, deps)).toEqual({ kind: "aim" });
  });

  it("does not pass over a transparent window that is not layered", () => {
    // `WS_EX_TRANSPARENT` alone governs painting order among siblings; such a window can still take
    // the press (PR 側 codex). Skipping it would report the aim as clear and let the click land on
    // the overlay — so it counts as occluding, and the caller gets a refusal naming it rather than
    // a silent press into something else.
    const deps = enumerating(
      win({ hwnd: OTHER, zOrder: 0, exStyle: 0x00000020, title: "overlay" }),
      win({ hwnd: AIM, zOrder: 1 }),
    );
    expect(whoIsUnderPoint(AIM, 500, 500, deps)).toEqual({ kind: "other", hwnd: OTHER, title: "overlay" });
  });

  it("answers unknown rather than clear when it cannot ask", () => {
    // The dangerous direction is "looks clear when it is not", so an enumeration that fails or
    // returns nothing is not allowed to read as "the aim is on top".
    const threw = { enumerate: () => { throw new Error("enum failed"); } };
    expect(whoIsUnderPoint(AIM, 5, 5, threw)).toEqual({ kind: "unknown", why: "enumeration_failed" });
    expect(whoIsUnderPoint(AIM, 5, 5, enumerating())).toEqual({ kind: "unknown", why: "enumeration_failed" });
    // A point on no window at all: the desktop, or a window the enumeration drops.
    const elsewhere = enumerating(win({ hwnd: AIM, zOrder: 0, region: { x: 0, y: 0, width: 10, height: 10 } }));
    expect(whoIsUnderPoint(AIM, 5000, 5000, elsewhere)).toEqual({ kind: "unknown", why: "no_window_at_point" });
  });
});

describe("the press is blocked, or allowed, by who is under it", () => {
  function entity(): UiEntity {
    return {
      entityId: "e1", role: "button", label: "Save", confidence: 0.9,
      sources: ["visual_gpu"],
      affordances: [{ verb: "click", executors: ["mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
      generation: "gen-1", evidenceDigest: "d", rect: { x: 100, y: 200, width: 80, height: 30 },
    };
  }
  function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
    return {
      uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
      cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
      terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
      mouseClick: vi.fn(async () => {}),
      aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 1000, height: 1000 })),
      ...over,
    };
  }
  const aim: Aim = { kind: "aim", title: "App", hwnd: AIM };

  it("blocks when a stranger is on top, and names it", async () => {
    const d = deps({ pointOwner: () => ({ kind: "other", hwnd: OTHER, title: "設定" }) });
    const exec = createDesktopExecutor(aim, d);
    await expect(exec(entity(), "click")).rejects.toBeInstanceOf(AimOccludedError);
    expect(d.mouseClick).not.toHaveBeenCalled();
    await expect(exec(entity(), "click")).rejects.toThrow(/設定/);
  });

  it("allows a press on a popup the aim owns, even outside the aim's own rectangle", async () => {
    // The false refusal the containment check makes today: this rect is nowhere near the window.
    const d = deps({
      aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 })),
      pointOwner: () => ({ kind: "owned", hwnd: POPUP, title: "" }),
    });
    const exec = createDesktopExecutor(aim, d);
    await exec(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalled();
  });

  it("leaves the containment check in charge when nobody could say", async () => {
    // `unknown` is not a verdict. The behaviour is exactly what it was before this rung existed.
    const d = deps({
      aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 })),
      pointOwner: () => ({ kind: "unknown", why: "enumeration_failed" }),
    });
    const exec = createDesktopExecutor(aim, d);
    await expect(exec(entity(), "click")).rejects.toThrow(/Refusing to click/);
  });

  it("does not ask at all for an unpinned press", async () => {
    // Nothing to be occluded from: a call that named no window never promised which one.
    const pointOwner = vi.fn(() => ({ kind: "other" as const, hwnd: OTHER, title: "設定" }));
    const d = deps({ pointOwner });
    const exec = createDesktopExecutor({ windowTitle: "App" }, d);
    await exec(entity(), "click");
    expect(pointOwner).not.toHaveBeenCalled();
    expect(d.mouseClick).toHaveBeenCalled();
  });
});
