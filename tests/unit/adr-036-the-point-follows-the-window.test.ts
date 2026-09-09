/**
 * A remembered coordinate is only meaningful next to the window it was measured against.
 *
 * ADR-036 item 5 — the first rung of the specification's ladder for a coordinate press, and the
 * last one to be built:
 *
 * > `mouse_click(x, y)` → **if rect moved, apply homing correction** → if another top-level window
 * > covers point, block or refocus → if target identity changed, invalidate coordinates
 *
 * The implementation had only the containment check, which answers a different question. Measured
 * on Windows 2026-09-09 (win2, five stacked buttons whose own click handlers write to a log): a
 * lease taken on the title bar, the window moved 71 px up, the remembered point left where it was
 * — `desktop_act` returned `ok:true`, `executor:"mouse"`, and the button that logged the press was
 * `BTN1`, which the lease had never named. Containment passed, because the point was still inside
 * the window; what had changed was WHICH PART of the window was under it.
 *
 * These cells hold the correction and, just as importantly, the three cases it must refuse to
 * invent: a resized window (the contents may have reflowed), a point that was never inside the
 * window to begin with (an owned popup has its own origin), and an aim with no origin at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homingCorrection, type Aim, type WindowRect } from "../../src/engine/aim.js";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const HWND = 4919n;

/** The measured case: the window is 600x400 at (100, 200) and is dragged 71 px up. */
const ORIGIN: WindowRect = { x: 100, y: 200, width: 600, height: 400 };
const MOVED: WindowRect = { x: 100, y: 129, width: 600, height: 400 };

describe("the correction moves the point with the window, and only then", () => {
  it("translates a point that was inside a window that moved", () => {
    expect(homingCorrection({ kind: "measured", rect: ORIGIN }, MOVED, 458, 215)).toEqual({ applied: true, x: 458, y: 144, dx: 0, dy: -71 });
  });

  it("leaves a point alone when the window did not move", () => {
    expect(homingCorrection({ kind: "measured", rect: ORIGIN }, { ...ORIGIN }, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "not_moved" });
  });

  it("refuses to translate through a resize", () => {
    // A window that changed size may have reflowed its contents: the offset that pointed at a
    // button can point at whatever the layout put there instead, and moving the point by the
    // origin's delta would be inventing a layout rather than following one.
    const resized: WindowRect = { x: 100, y: 129, width: 900, height: 400 };
    expect(homingCorrection({ kind: "measured", rect: ORIGIN }, resized, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "window_resized" });
  });

  it("does not claim a point that was never inside the window", () => {
    // A dropdown, a context menu and a tooltip are top-level windows of their own, sitting outside
    // their owner's rectangle. The owner's delta is not theirs, and item 6 is what allows those
    // presses — this rung must not silently move them.
    expect(homingCorrection({ kind: "measured", rect: ORIGIN }, MOVED, 458, 900))
      .toEqual({ applied: false, x: 458, y: 900, why: "point_was_outside_origin" });
  });

  it("does not read a parked window as a move of 32000 px", () => {
    // Windows parks a minimised window at -32000, -32000. Read as an ordinary move, the point
    // would be translated INTO the parked rectangle, containment would pass — the point really is
    // inside it — and the caller would get a generic unreachable-coordinate failure instead of the
    // refusal that names the cause. The parked rectangle is how containment recognised a minimised
    // window in the first place (gate 1, 2026-09-09).
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    expect(homingCorrection({ kind: "measured", rect: ORIGIN }, parked, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "window_off_desktop" });
  });

  it("asks about the popup before it asks about the resize", () => {
    // Order matters between these two: a point that was never inside this window was not described
    // by this window's layout, so a change in that layout says nothing about it. Testing the resize
    // first would refuse a dropdown press because its OWNER had been resized.
    const resizedOwner: WindowRect = { x: 100, y: 129, width: 900, height: 400 };
    expect(homingCorrection({ kind: "measured", rect: ORIGIN }, resizedOwner, 458, 900))
      .toEqual({ applied: false, x: 458, y: 900, why: "point_was_outside_origin" });
  });

  it("keeps 'nobody measured one' apart from 'the window would not hold still'", () => {
    // The distinction the whole `AimOrigin` union exists for: one costs the correction, the other
    // refuses the press.
    expect(homingCorrection({ kind: "moved_during_read" }, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "moved_during_read" });
  });

  it("says 'nothing to compare against' rather than correcting by zero", () => {
    // An aim from before this rung, or from a build whose rectangle read could not answer. The two
    // must not look like a window that stood still: one is a missing measurement, the other is a
    // measurement that came back equal.
    expect(homingCorrection(undefined, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "no_origin_rect" });
  });
});

// ── The press itself ──────────────────────────────────────────────────────────

function entity(rect = { x: 328, y: 205, width: 260, height: 20 }): UiEntity {
  return {
    entityId: "e1", role: "text", label: "CELL BUTTONS", confidence: 0.9,
    sources: ["visual_gpu"],
    affordances: [{ verb: "click", executors: ["mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d", rect,
  };
}

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick: vi.fn(async () => {}), uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    aimRect: vi.fn(async () => MOVED),
    ...over,
  };
}

const aimed: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND, origin: { kind: "measured", rect: ORIGIN } };

describe("the press lands where the control went", () => {
  it("presses 71 px higher when the window was dragged 71 px up", async () => {
    // The measured failure, as a cell: the remembered point is (458, 215) and pressing it now hits
    // whatever is at that place on the screen. The control is at (458, 144).
    const d = deps();
    await createDesktopExecutor(aimed, d)(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 144);
  });

  it("presses the remembered point exactly when there is no origin to compare against", async () => {
    // Every caller that has not been migrated, and every test double. The behaviour has to be the
    // one that existed before this rung, not a correction invented from a single rectangle.
    const d = deps();
    await createDesktopExecutor({ kind: "aim", title: "CELL BUTTONS", hwnd: HWND }, d)(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 215);
  });

  it("asks who is under the CORRECTED point, not the remembered one", async () => {
    // A ladder that checks one point and presses another checks nothing. The occlusion rung runs
    // after the correction for exactly this reason.
    const pointOwner = vi.fn(() => ({ kind: "aim" as const }));
    const d = deps({ pointOwner });
    await createDesktopExecutor(aimed, d)(entity(), "click");
    expect(pointOwner).toHaveBeenCalledWith(HWND, 458, 144);
  });

  it("lets a press through that containment alone would have refused", async () => {
    // The window moved far enough that the remembered point is outside it now — today's refusal,
    // and the caller is told to re-discover. The point did not leave the window; the window left
    // the point, and the correction is what tells those apart.
    const farAway: WindowRect = { x: 100, y: 600, width: 600, height: 400 };
    const d = deps({ aimRect: vi.fn(async () => farAway) });
    await createDesktopExecutor(aimed, d)(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 615);
  });

  it("refuses a press into a window that resized, even where the point still lands inside it", async () => {
    // Gate 1's P1 on the first pass of this rung. The correction declines to translate through a
    // reflow — and then the containment check waved the press through anyway, because a resized
    // window usually still contains the point. That is the silent wrong press this whole ladder
    // exists to remove, so the resize is a refusal in its own right.
    const wider: WindowRect = { x: 100, y: 200, width: 900, height: 400 };
    const d = deps({ aimRect: vi.fn(async () => wider) });
    await expect(createDesktopExecutor(aimed, d)(entity(), "click")).rejects.toThrow(/RESIZED/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("refuses a snapshot the window would not hold still for", async () => {
    // Gate 1's P1 on the third pass. When the two origin samples disagree, the coordinates in that
    // snapshot were measured across more than one window position — an early lane's candidate
    // describes one and a late one's another — and no single correction describes them. Recording
    // that as an ABSENT rectangle would read as "nobody looked", which costs the correction and
    // lets the blind press through; it is recorded as a value so this refusal can exist.
    const d = deps();
    const unstable: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND, origin: { kind: "moved_during_read" } };
    await expect(createDesktopExecutor(unstable, d)(entity(), "click")).rejects.toThrow(/while it was being read/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("refuses a minimised window as a stale aim, not as an occlusion", async () => {
    // The `pointOwner` here is what the first version of this cell was missing: with the deps'
    // default (no owner) the parked window fell through to containment and refused for the right
    // reason by accident. On a real desktop something else is nearly always over the remembered
    // point, `whoIsUnderPoint` filters minimised windows out of its own candidates, and the caller
    // was told to bring a minimised window forward as if it were merely covered (gate 2).
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    const d = deps({
      aimRect: vi.fn(async () => parked),
      pointOwner: () => ({ kind: "other" as const, hwnd: 777n, title: "設定" }),
    });
    await expect(createDesktopExecutor(aimed, d)(entity(), "click")).rejects.toThrow(/MINIMISED/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("leaves the point alone when a window the aim OWNS is sitting on it", async () => {
    // PR 側 codex on #609, second round — and this one is a REGRESSION, not a blind spot to record.
    // A modal dialog, or a dropdown that opens over its combo, is a top-level window of its own
    // whose centre falls INSIDE the owner's rectangle, and it does NOT move when its owner moves.
    // Applying the owner's delta moved a point that was already right, and the ownership test then
    // ran at the moved point and could see the owner as clear. That press was correct before this
    // rung existed, which is the one outcome a new rung may not produce.
    const d = deps({ pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }) });
    await createDesktopExecutor(aimed, d)(entity(), "click");
    // (458, 215) — the remembered point, NOT (458, 144).
    expect(d.mouseClick).toHaveBeenCalledWith(458, 215);
  });

  it("still follows the window when the point belongs to the aim itself", async () => {
    // The other side of the same question: `aim` under the point is not a reason to decline, and
    // neither is `unknown`. Declining on those would turn the rung off wherever the enumeration is
    // silent, which is most of the builds that need it.
    for (const owner of [{ kind: "aim" as const }, { kind: "unknown" as const, why: "no_window_at_point" as const }]) {
      const d = deps({ pointOwner: () => owner });
      await createDesktopExecutor(aimed, d)(entity(), "click");
      expect(d.mouseClick).toHaveBeenCalledWith(458, 144);
    }
  });

  it("refuses a smeared snapshot even when a popup sits under the stale point", async () => {
    // PR 側 codex on #609. The previous round moved the `owned` allowance one rung too far up, past
    // the refusals that are about the whole SNAPSHOT rather than the aim's layout. `owned` says
    // which top-level window is under the point NOW — not that the leased entity came from it — so
    // a smeared read plus any dropdown happening to sit under the stale point reported success
    // after pressing something nobody discovered.
    const d = deps({ pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }) });
    const unstable: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND, origin: { kind: "moved_during_read" } };
    await expect(createDesktopExecutor(unstable, d)(entity(), "click")).rejects.toThrow(/while it was being read/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("refuses a minimised aim even when a popup sits under the stale point", async () => {
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    const d = deps({
      aimRect: vi.fn(async () => parked),
      pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }),
    });
    await expect(createDesktopExecutor(aimed, d)(entity(), "click")).rejects.toThrow(/MINIMISED/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("allows a popup drawn OVER its owner, even after the owner resized", async () => {
    // The regression the resize refusal introduced (gate 2, third pass). A combo dropdown or a
    // modal drawn over its owner has its centre INSIDE the owner's rectangle, so the correction
    // gets past `point_was_outside_origin` and answers `window_resized` about a window the entity
    // does not live on. The entity is on a separate top-level window that did not resize, and
    // `owned` used to let it through — so `owned` is asked before this rung's own verdicts.
    const resizedOwner: WindowRect = { x: 100, y: 200, width: 900, height: 400 };
    const d = deps({
      aimRect: vi.fn(async () => resizedOwner),
      pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }),
    });
    // Centre (458, 215): inside the origin, so the resize test would otherwise have refused it.
    await createDesktopExecutor(aimed, d)(entity(), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 215);
  });

  it("refuses a minimised window even when the aim carries no origin", async () => {
    // The rung was closed for measured origins only (gate 2, third pass): with no origin — the
    // direct `candidateProvider` road, or a bracket read that could not answer — the correction
    // short-circuited before the parked test, and the caller was told by the occlusion rung to
    // bring a MINIMISED window forward. Parked is a property of the current rectangle alone.
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    const d = deps({
      aimRect: vi.fn(async () => parked),
      pointOwner: () => ({ kind: "other" as const, hwnd: 777n, title: "設定" }),
    });
    const noOrigin: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND };
    await expect(createDesktopExecutor(noOrigin, d)(entity(), "click")).rejects.toThrow(/MINIMISED/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("still allows a press on a popup outside its owner, after the owner resized", async () => {
    const resizedOwner: WindowRect = { x: 100, y: 129, width: 900, height: 400 };
    const d = deps({
      aimRect: vi.fn(async () => resizedOwner),
      pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }),
    });
    // The entity is a dropdown item hanging below the owner: outside the origin, so the resize
    // never gets asked about.
    await createDesktopExecutor(aimed, d)(entity({ x: 400, y: 890, width: 200, height: 20 }), "click");
    expect(d.mouseClick).toHaveBeenCalledWith(500, 900);
  });

  it("still refuses when the window resized and the point fell out of it", async () => {
    // No correction is available for a reflow, so the containment check decides — and it decides
    // the way it always did.
    const shrunk: WindowRect = { x: 100, y: 200, width: 600, height: 10 };
    const d = deps({ aimRect: vi.fn(async () => shrunk) });
    await expect(createDesktopExecutor(aimed, d)(entity(), "click")).rejects.toThrow(/Refusing to click/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });
});

describe("the row says which of the two silences it is", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "homing-"));
    logPath = join(dir, "aim-probe.jsonl");
  });
  afterEach(() => {
    delete process.env.DESKTOP_TOUCH_AIM_PROBE;
    delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function rowsWith(aim: Aim, d: ExecutorDeps) {
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
    vi.resetModules();
    const { createDesktopExecutor: create } = await import("../../src/tools/desktop-executor.js");
    await create(aim, d)(entity(), "click");
    return readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  }

  async function rowsFor(aim: Aim, current: WindowRect) {
    return rowsWith(aim, deps({ aimRect: vi.fn(async () => current) }));
  }

  it("writes both rectangles, the delta and the point it moved", async () => {
    const row = (await rowsFor(aimed, MOVED)).find((r) => r.route === "homing");
    expect(row).toMatchObject({
      applied: true,
      origin: { kind: "measured", rect: ORIGIN },
      windowRect: MOVED,
      from: { x: 458, y: 215 },
      to: { x: 458, y: 144 },
      delta: { dx: 0, dy: -71 },
      why: null,
    });
  });

  it("writes a row for a rung it skipped, rather than none at all", async () => {
    // A press with an aim and no `homing` row reads exactly like a build that never reached the
    // rung. The two early returns above the correction — no rectangle dep, and a rectangle that
    // could not be read — used to leave that hole, which is the failure the reasons in this row
    // were written to prevent, one level up (gate 2, second pass).
    const noRectDep = deps();
    delete (noRectDep as { aimRect?: unknown }).aimRect;
    const row = (await rowsWith(aimed, noRectDep)).find((r) => r.route === "homing");
    expect(row).toMatchObject({ checked: false, why: "no_aim_rect_dep" });
  });

  it("separates 'declined to move it' from 'never had an origin'", async () => {
    // Both press the remembered point, and a log that showed only the press could not tell a
    // window that stood still from an aim that never carried an origin.
    const stood = (await rowsFor(aimed, ORIGIN)).find((r) => r.route === "homing");
    expect(stood).toMatchObject({ applied: false, why: "not_moved", origin: { kind: "measured", rect: ORIGIN } });

    rmSync(logPath, { force: true });
    const none = (await rowsFor({ kind: "aim", hwnd: HWND }, MOVED)).find((r) => r.route === "homing");
    expect(none).toMatchObject({ applied: false, why: "no_origin_rect", origin: null });
  });
});
