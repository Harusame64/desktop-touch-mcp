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
import { AimOccludedError, AimBlockedByExcludedWindowError, type Aim } from "../../src/engine/aim.js";
import type { WindowZInfo } from "../../src/engine/win32.js";
import type { NativeWindowAtPoint } from "../../src/engine/native-types.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import { registerExcludedPid, _resetExcludedPidsForTest } from "../../src/engine/tool-exclusion.js";

const AIM = 4919n;
const OTHER = 777n;
const POPUP = 888n;
/** A window owned by a tool-excluded process — the key locker's secure dialog. */
const LOCKER = 4242n;

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
      .toEqual({ kind: "other", hwnd: OTHER, title: `w${OTHER}`, via: "enumeration" });
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
      .toEqual({ kind: "owned", hwnd: POPUP, title: `w${POPUP}`, via: "os_hit_test" });
    // Through a chain, because the aim can itself be an owned window: a walk that passes THROUGH
    // it and continues would read as unrelated if only the last hop were compared.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, ownerChain: [1n, AIM, 2n] }))))
      .toEqual({ kind: "owned", hwnd: POPUP, title: `w${POPUP}`, via: "os_hit_test" });
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
      .toEqual({ kind: "other", hwnd: OTHER, title: `w${OTHER}`, via: "os_hit_test" });
  });

  it("lets the app's own context menu through and keeps a shell menu out", () => {
    // Two different things, not two implementations of one — the version of this cell that said
    // otherwise rested on a round that was clicking (0, 0), so the WinUI menu it saw belonged to
    // the desktop (win2, 2026-09-10, re-measured).
    //
    // The application's own menu is the classic `#32768`: its own thread, no caption. Ten
    // right-clicks on a fixture's text box produced it ten times out of ten.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, rootHasCaption: false, rootThreadId: AIM_THREAD }))))
      .toEqual({ kind: "unknown", why: "unattributable_window" });
    // A shell menu — the desktop's, Explorer's — is another thread and another process, owned by
    // the shell's XAML island. Refusing there is correct: it is not the application's window.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: POPUP, rootHasCaption: true, rootThreadId: 4242, rootProcessId: 4242 }))))
      .toEqual({ kind: "other", hwnd: POPUP, title: `w${POPUP}`, via: "os_hit_test" });
  });

  it("reads the caption, not popup-ness — which is this rung's whole cost", () => {
    // The decisive arm of the measurement was an ordinary second window of the application with
    // nothing changed but its title erased (win2, 2026-09-10). So an app's own untitled window — a
    // tool palette, a custom frame, a window opened before its document — takes a press here as
    // though it were the aim's dropdown. Held as a cell so the cost is a decision rather than a
    // surprise: the alternative is `other`, which refuses every combo-box press on every desktop.
    const sibling = { root: OTHER, rootThreadId: AIM_THREAD };
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ ...sibling, rootHasCaption: true }))))
      .toEqual({ kind: "other", hwnd: OTHER, title: `w${OTHER}`, via: "os_hit_test" });
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ ...sibling, rootHasCaption: false }))))
      .toEqual({ kind: "unknown", why: "unattributable_window" });
  });

  it("stops the press at a tool-excluded window without describing it", () => {
    // R3: the key locker's own windows are excluded from every tool surface, so a secret being
    // typed cannot be read or driven by the same session. `enumWindowsInZOrder` filters them, so
    // the road below never sees one — but `WindowFromPoint` asks the OS, and the OS does not know
    // about this server's registry.
    //
    // Two properties, and the first version of this branch had only the second: the verdict must
    // REFUSE, and it must name nothing. `unknown` gave up the first — it means "no evidence", the
    // ladder falls through to containment, and a locker dialog drawn inside its owner's rectangle
    // leaves the point inside, so the press went out into the secure dialog (PR 側 codex on #618,
    // P1). Held here as the pair of assertions the branch actually has to satisfy.
    //
    // This cell is about the WIRING — that the default predicate really is
    // `isExcludedWindowHandle`, so arming the registry reaches this branch. It is armed with a PID
    // that matches nothing and leans on the fail-closed arm: `777n` names no window, so its PID
    // reads as 0 whether or not an addon is loaded, and 0 is excluded while armed. Which window is
    // excluded is pinned by the injected cell below, not here.
    registerExcludedPid(999_999);
    try {
      const verdict = whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: OTHER })));
      expect(verdict).toEqual({ kind: "blocked", why: "excluded_window" });
      // Says nothing about the window it stopped the press at — not its handle, not its title.
      expect(Object.keys(verdict)).toEqual(["kind", "why"]);
    } finally {
      _resetExcludedPidsForTest();
    }
  });

  it("costs nothing, and blocks nothing, while no locker is armed", () => {
    // An empty registry short-circuits before any syscall, so this rung does not exist on an
    // ordinary desktop.
    expect(whoIsUnderPoint(AIM, 5, 5, hitting(at({ root: OTHER }))))
      .toEqual({ kind: "other", hwnd: OTHER, title: `w${OTHER}`, via: "os_hit_test" });
  });

  it("blocks the excluded window and not the desktop it is sitting on", () => {
    // **The cell above does not pin this, and the pair of them did not either.** On a machine with
    // no addon every handle's PID reads as 0, so while the registry is armed "excluded" and
    // "unreadable" are the same answer — and a build that simply refused every press whenever a
    // locker was open passed both (gate 2, Opus sandbox review, 2026-09-10). That build is the
    // realistic wrong fix here, and it makes the whole desktop unclickable for as long as a secure
    // dialog is open. So the predicate is injected, and this cell says WHICH window is excluded.
    const only = (h: bigint) => h === LOCKER;
    expect(whoIsUnderPoint(AIM, 5, 5, { ...hitting(at({ root: LOCKER })), isExcluded: only }))
      .toEqual({ kind: "blocked", why: "excluded_window" });
    expect(whoIsUnderPoint(AIM, 5, 5, { ...hitting(at({ root: OTHER })), isExcluded: only }))
      .toEqual({ kind: "other", hwnd: OTHER, title: `w${OTHER}`, via: "os_hit_test" });
    // And the aim itself still answers `aim` — the branch above it does not sweep in the window the
    // caller is aiming at just because a locker is open somewhere.
    expect(whoIsUnderPoint(AIM, 5, 5, { ...hitting(at({ root: AIM })), isExcluded: only }))
      .toEqual({ kind: "aim" });
  });

  it("blocks on the enumeration road too, where the excluded window is not in the list", () => {
    // The other door to the same press. `enumWindowsInZOrder` FILTERS excluded windows, so the
    // reconstruction answers about whatever is behind one — here the aim — and `aim` allows the
    // press, into the locker. Every build without `win32WindowFromPoint` uses this road.
    const covered = enumerating(win({ hwnd: AIM, zOrder: 0 }));
    expect(whoIsUnderPoint(AIM, 500, 500, { ...covered, excludedAtPoint: () => true }))
      .toEqual({ kind: "blocked", why: "excluded_window" });
    // Asked about the POINT, not about the windows the enumeration can see. A verdict that consulted
    // the by-handle predicate here would be asking a filtered list to confirm what the filter
    // removed, and would answer `blocked` for any excluded window ANYWHERE while allowing the press
    // that matters.
    expect(whoIsUnderPoint(AIM, 500, 500, { ...covered, excludedAtPoint: () => false, isExcluded: () => true }))
      .toEqual({ kind: "aim" });
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
    expect(whoIsUnderPoint(AIM, 500, 500, deps)).toEqual({ kind: "other", hwnd: OTHER, title: "設定", via: "enumeration" });
  });

  it("recognises a popup the aim owns, which is where dropdowns live", () => {
    const deps = enumerating(
      win({ hwnd: POPUP, zOrder: 0, ownerHwnd: AIM, title: "" , region: { x: 400, y: 900, width: 200, height: 300 } }),
      win({ hwnd: AIM, zOrder: 1, region: { x: 0, y: 0, width: 1000, height: 800 } }),
    );
    // The point is BELOW the aim's rectangle — a dropdown hanging off the bottom of its owner.
    expect(whoIsUnderPoint(AIM, 500, 1000, deps)).toEqual({ kind: "owned", hwnd: POPUP, title: "", via: "enumeration" });
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
    expect(whoIsUnderPoint(AIM, 500, 500, deps)).toEqual({ kind: "other", hwnd: OTHER, title: "overlay", via: "enumeration" });
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

  it("refuses a press an excluded window is sitting on, and names nothing", async () => {
    // The point is INSIDE the aim's rectangle — the default 1000x1000 rect contains the entity's
    // centre — which is the case the containment check waves through. A key locker's dialog drawn
    // inside its owner is exactly that shape.
    const d = deps({ pointOwner: () => ({ kind: "blocked", why: "excluded_window" }) });
    const exec = createDesktopExecutor(aim, d);
    const err = await exec(entity(), "click").then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AimBlockedByExcludedWindowError);
    expect(d.mouseClick).not.toHaveBeenCalled();
    // Whatever it says, it does not describe the window it stopped at. The verdict carries no
    // handle and no title, and the sentence may not reach for one of its own. Its own class, too:
    // `WindowExcludedError` publishes advice saying the CALLER's window is the excluded one and to
    // go act on a different window — false here, and the only actionable line points away from a
    // window that is perfectly touchable.
    expect((err as Error).message).toMatch(/not its title, not its handle/);
    expect((err as Error).message).not.toContain(String(OTHER));
  });

  it("would have pressed, had that verdict been `unknown` — which is why it is not", async () => {
    // The regression this pair exists to catch, at the SAME point as the cell above: `unknown`
    // means no evidence, and no evidence lets the containment check decide. It says inside.
    const d = deps({ pointOwner: () => ({ kind: "unknown", why: "unattributable_window" }) });
    const exec = createDesktopExecutor(aim, d);
    await exec(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalled();
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
