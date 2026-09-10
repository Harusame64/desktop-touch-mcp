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
import type { NativeWindowAtPoint } from "../../src/engine/native-types.js";
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

const AIM_THREAD = 12016;

/** The OS hit test, as the deps see it. Defaults describe a foreign, captioned window. */
function at(over: Partial<NativeWindowAtPoint> & { root: bigint }): NativeWindowAtPoint {
  return {
    child: over.root,
    ownerChain: [],
    rootThreadId: 999,
    rootProcessId: 999,
    rootHasCaption: true,
    ...over,
  };
}

function hitting(hit: NativeWindowAtPoint | null | undefined, ...windows: WindowZInfo[]) {
  return {
    enumerate: () => windows,
    fromPoint: () => hit,
    titleOf: (h: bigint) => `w${h}`,
    threadOf: () => AIM_THREAD,
  };
}

describe("Windows answers, and the enumeration is what is left when it cannot", () => {
  it("believes the hit test over an enumeration that says the aim is covered", () => {
    // The defect this road exists to close, as a cell. A full-screen `UpdateLayeredWindow` overlay
    // — one ships with a common monitor utility — is `WS_EX_LAYERED` without `WS_EX_TRANSPARENT`,
    // so the mask cannot pass it and the enumeration answers `other` at EVERY point on the screen,
    // while presses go straight through it into the window below (measured 2026-09-10, win2: the
    // shipped function said `other`, `WindowFromPoint` said the fixture's own button, and the
    // fixture's log recorded the press). Refusing every coordinate press on such a desktop is the
    // outcome; asking the OS is the fix.
    const overlay = win({ hwnd: OTHER, zOrder: 0, exStyle: 0x00080088 });   // LAYERED|TOOLWINDOW|TOPMOST
    const aimed = win({ hwnd: AIM, zOrder: 1 });
    expect(whoIsUnderPoint(AIM, 500, 500, enumerating(overlay, aimed)))
      .toEqual({ kind: "other", hwnd: OTHER, title: `w${OTHER}` });
    expect(whoIsUnderPoint(AIM, 500, 500, hitting(at({ root: AIM }), overlay, aimed)))
      .toEqual({ kind: "aim" });
  });

  it("walks the child up to its root, so the aim's own button is not another window", () => {
    // `WindowFromPoint` returns the CHILD under the point — a button, not its frame (win2,
    // 2026-09-10). Compared with a top-level handle as-is, every press on the aim's own control
    // would read as an occlusion.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ child: 12345n, root: AIM }))))
      .toEqual({ kind: "aim" });
  });

  it("calls a dialog owned when the GW_OWNER chain reaches the aim", () => {
    // `GW_OWNER`, and every hop of it — not `GA_ROOTOWNER`, which was measured and is strictly
    // worse: for a WinForms owned dialog (overlapped rather than WS_POPUP) it answers *itself*,
    // losing the ownership, and for a dropdown it answers the desktop window (win2, 2026-09-10).
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, ownerChain: [AIM] }))))
      .toEqual({ kind: "owned", hwnd: POPUP, title: `w${POPUP}` });
    // Through a chain, because the aim can itself be an owned window: a walk that passes THROUGH
    // it and continues would read as unrelated if only the last hop were compared.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, ownerChain: [1n, AIM, 2n] }))))
      .toEqual({ kind: "owned", hwnd: POPUP, title: `w${POPUP}` });
  });

  it("cannot attribute a captionless window on the aim's own thread, and says so", () => {
    // A `ComboLBox` dropdown has NO owner at all, so no ownership rule reaches it — and until this
    // road existed it was invisible to us (untitled, dropped by the enumeration), the answer came
    // back `aim`, and the press went through correctly. Asking Windows makes it visible for the
    // first time, so calling it `other` would turn every combo-box press into a refusal: a rung
    // breaking what worked. `unknown` keeps the caller's behaviour and claims nothing.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, rootHasCaption: false, rootThreadId: AIM_THREAD }))))
      .toEqual({ kind: "unknown", why: "unattributable_window" });
  });

  it("does not extend that to the app's other windows, which carry captions", () => {
    // The decisive row of the measurement: a modal dialog and an ordinary sibling window of the
    // same application are identical in thread, in process, in `GA_ROOTOWNER` and in their whole
    // window style. Only `GW_OWNER` separates them — so "on the aim's thread" alone would sweep in
    // every other window the app has open, and a press landing there would be reported as landing
    // on the aim. The caption is what excludes it, on this evidence.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: OTHER, rootHasCaption: true, rootThreadId: AIM_THREAD }))))
      .toEqual({ kind: "other", hwnd: OTHER, title: `w${OTHER}` });
  });

  it("puts the two context menus on opposite sides of the line, which is the gap", () => {
    // The same right-click on the same control raises either implementation, and both were seen on
    // one machine (win2, 2026-09-10). This cell holds the ASYMMETRY rather than a verdict about
    // "context menus", because the previous version of it asserted a property of the menu when it
    // is a property of which one Windows happened to produce.
    //
    // Classic `#32768`: the application's own thread, no caption — reaches the rung above and the
    // press goes through. Measured on a real desktop.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, rootHasCaption: false, rootThreadId: AIM_THREAD }))))
      .toEqual({ kind: "unknown", why: "unattributable_window" });
    // WinUI `PopupWindowSiteBridge`: a different thread and process, owned by the shell's XAML
    // island — nothing here can attribute it, and the press is refused. Its thread and process were
    // measured in the Q4 round; that it lands here is derived from them, not observed in the same
    // round as the line above.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, rootHasCaption: true, rootThreadId: 4242, rootProcessId: 4242 }))))
      .toEqual({ kind: "other", hwnd: POPUP, title: `w${POPUP}` });
  });

  it("keeps `nothing is there` apart from `could not ask`", () => {
    // `null` is Windows having looked; `undefined` is an addon built before this function. One is
    // an answer and one is a missing instrument, and collapsing them is the mistake this ADR keeps
    // finding elsewhere — so the second falls back to the enumeration rather than answering.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(null, win({ hwnd: AIM, zOrder: 0 }))))
      .toEqual({ kind: "unknown", why: "no_window_at_point" });
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(undefined, win({ hwnd: AIM, zOrder: 0 }))))
      .toEqual({ kind: "aim" });
  });
});

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
    // Measured on Windows 2026-09-10 (win2, ADR-036 item 11), after two reviews said opposite
    // things about it and neither had measured: a titled, visible overlay carrying
    // `WS_EX_TRANSPARENT` and NOT `WS_EX_LAYERED` (exStyle read back as `0x00050128`) BLOCKED the
    // press to the fixture below, behaving exactly like a plain opaque window. Both bits together
    // (`0x000D0128`) let it through. So this is not the cautious reading — it is the right one, and
    // skipping such a window would report the aim as clear and let the click land on the overlay.
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
