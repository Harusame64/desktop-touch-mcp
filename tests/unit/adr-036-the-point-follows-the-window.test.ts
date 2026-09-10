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
import { homingCorrectionForSources, type Aim, type WindowRect } from "../../src/engine/aim.js";

/** A lane that reads inside the bracketed fan-out, so the policy lets these cells through. */
const LIVE = ["ocr"];

import * as aimModule from "../../src/engine/aim.js";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

const HWND = 4919n;

/** The measured case: the window is 600x400 at (100, 200) and is dragged 71 px up. */
const ORIGIN: WindowRect = { x: 100, y: 200, width: 600, height: 400 };
const MOVED: WindowRect = { x: 100, y: 129, width: 600, height: 400 };

describe("the correction moves the point with the window, and only then", () => {
  it("cannot be reached without the policy that decides whether it may run", () => {
    // There is ONE way in, and this is the check for it rather than a claim about it. The first
    // version said "cannot miss it" while a bare `homingCorrection` was still exported (win2,
    // 2026-09-10); the second asserted that one name was absent, which the module satisfies forever
    // by having deleted it — a wrapper called anything else would have passed (gate 2, 2026-09-10).
    // So the cell asks the question the design actually makes: how many ways in are there.
    expect(Object.keys(aimModule).filter((k) => /homing/i.test(k))).toEqual(["homingCorrectionForSources"]);
    // And the policy is what the entry point applies: a lane the bracketed origin cannot describe
    // never reaches the correction at all, whatever the rectangles say.
    expect(homingCorrectionForSources(["visual_gpu"], { kind: "measured", rect: ORIGIN }, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "measurement_moment_unknown" });
  });

  it("translates a point that was inside a window that moved", () => {
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, MOVED, 458, 215)).toEqual({ applied: true, x: 458, y: 144, dx: 0, dy: -71 });
  });

  it("leaves a point alone when the window did not move", () => {
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, { ...ORIGIN }, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "not_moved" });
  });

  it("refuses to translate through a resize", () => {
    // A window that changed size may have reflowed its contents: the offset that pointed at a
    // button can point at whatever the layout put there instead, and moving the point by the
    // origin's delta would be inventing a layout rather than following one.
    const resized: WindowRect = { x: 100, y: 129, width: 900, height: 400 };
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, resized, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "window_resized" });
  });

  it("does not claim a point that was never inside the window", () => {
    // A dropdown, a context menu and a tooltip are top-level windows of their own, sitting outside
    // their owner's rectangle. The owner's delta is not theirs, and item 6 is what allows those
    // presses — this rung must not silently move them.
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, MOVED, 458, 900))
      .toEqual({ applied: false, x: 458, y: 900, why: "point_was_outside_origin" });
  });

  it("does not read a parked window as a move of 32000 px", () => {
    // Windows parks a minimised window at -32000, -32000. Read as an ordinary move, the point
    // would be translated INTO the parked rectangle, containment would pass — the point really is
    // inside it — and the caller would get a generic unreachable-coordinate failure instead of the
    // refusal that names the cause. The parked rectangle is how containment recognised a minimised
    // window in the first place (gate 1, 2026-09-09).
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, parked, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "window_off_desktop" });
  });

  it("asks about the popup before it asks about the resize", () => {
    // Order matters between these two: a point that was never inside this window was not described
    // by this window's layout, so a change in that layout says nothing about it. Testing the resize
    // first would refuse a dropdown press because its OWNER had been resized.
    const resizedOwner: WindowRect = { x: 100, y: 129, width: 900, height: 400 };
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, resizedOwner, 458, 900))
      .toEqual({ applied: false, x: 458, y: 900, why: "point_was_outside_origin" });
  });

  it("still refuses a parked or smeared window when the coordinates are not ours to correct", () => {
    // Gate 2 (2026-09-10) on the first version of the sources gate, which sat in a wrapper in FRONT
    // of everything: a `visual_gpu` entity on a MINIMISED window answered `measurement_moment_unknown`,
    // so the minimise refusal never fired and the caller was told by the occlusion rung to bring a
    // minimised window forward — exactly the defect the OFF_DESKTOP comment records closing, re-made
    // one layer up. These two verdicts are about the window and the origin, not about whose
    // measurement the coordinates are, so they come first.
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    expect(homingCorrectionForSources(["visual_gpu"], { kind: "measured", rect: ORIGIN }, parked, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "window_off_desktop" });
    expect(homingCorrectionForSources(["visual_gpu"], { kind: "moved_during_read" }, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "moved_during_read" });
  });

  it("keeps the parked verdict, and does not let the aim's own instability answer for another window", () => {
    // Both directions of this were wrong once (2026-09-10). Below the origin verdicts, the guard
    // let `moved_during_read` answer for coordinates it knows nothing about: that verdict is
    // manufactured from two bracket reads of the AIM's rectangle, and an owned popup does not move
    // when its owner moves — so an entity captured in a dropdown was refused on evidence about a
    // window it does not live on (gate 2). Above `window_off_desktop`, an earlier round had it
    // short-circuit the minimise refusal instead (PR 側 codex). Parked stays first, because a parked
    // owner takes its popups off the screen with it; the rest of the ladder is about the aim's
    // rectangle, so a foreign capture handle answers before them.
    const elsewhere = { capturedIn: 888n, originOf: HWND };
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, parked, 458, 215, elsewhere))
      .toEqual({ applied: false, x: 458, y: 215, why: "window_off_desktop" });
    expect(homingCorrectionForSources(LIVE, { kind: "moved_during_read" }, MOVED, 458, 215, elsewhere))
      .toEqual({ applied: false, x: 458, y: 215, why: "measured_in_another_window" });
    expect(homingCorrectionForSources(LIVE, { kind: "measured", rect: ORIGIN }, MOVED, 458, 215, elsewhere))
      .toEqual({ applied: false, x: 458, y: 215, why: "measured_in_another_window" });
    // And with no capture handle to compare, the aim's own instability is all there is.
    expect(homingCorrectionForSources(LIVE, { kind: "moved_during_read" }, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "moved_during_read" });
  });

  it("names the capture handle rather than the lane when both would decline", () => {
    // Both rungs decline the same correction, so the only thing at stake is which reason is
    // recorded — and today that is the `act.route` row, not the caller's envelope, which
    // `desktop-register.ts` rebuilds from fixed text (ADR-036 item 13). The recorded handle is
    // evidence about THIS entity; the lane name is an inference about when it was measured.
    expect(homingCorrectionForSources(["visual_gpu"], { kind: "measured", rect: ORIGIN }, MOVED, 458, 215,
      { capturedIn: 888n, originOf: HWND }))
      .toEqual({ applied: false, x: 458, y: 215, why: "measured_in_another_window" });
  });

  it("refuses a resize even for a lane whose measurement moment is unknown", () => {
    // PR 側 codex (2026-09-10), and the third time on this branch that a new question was placed in
    // front of an older refusal. The sources gate answered `measurement_moment_unknown` for a
    // `visual_gpu` entity on a RESIZED window; the executor's resize refusal switches on
    // `window_resized`, so it never fired and the remembered point was pressed into a layout that
    // may have reflowed underneath it — a press that was refused before this gate existed.
    const resized: WindowRect = { x: 100, y: 200, width: 900, height: 400 };
    expect(homingCorrectionForSources(["visual_gpu"], { kind: "measured", rect: ORIGIN }, resized, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "window_resized" });
    // And below the geometry it still does its whole job: a window that merely MOVED is not
    // followed for a lane the bracket cannot vouch for.
    expect(homingCorrectionForSources(["visual_gpu"], { kind: "measured", rect: ORIGIN }, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "measurement_moment_unknown" });
  });

  it("keeps 'nobody measured one' apart from 'the window would not hold still'", () => {
    // The distinction the whole `AimOrigin` union exists for: one costs the correction, the other
    // refuses the press.
    expect(homingCorrectionForSources(LIVE, { kind: "moved_during_read" }, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "moved_during_read" });
  });

  it("says 'nothing to compare against' rather than correcting by zero", () => {
    // An aim from before this rung, or from a build whose rectangle read could not answer. The two
    // must not look like a window that stood still: one is a missing measurement, the other is a
    // measurement that came back equal.
    expect(homingCorrectionForSources(LIVE, undefined, MOVED, 458, 215))
      .toEqual({ applied: false, x: 458, y: 215, why: "no_origin_rect" });
  });
});

// ── The press itself ──────────────────────────────────────────────────────────

function entity(rect = { x: 328, y: 205, width: 260, height: 20 }): UiEntity {
  return {
    entityId: "e1", role: "text", label: "CELL BUTTONS", confidence: 0.9,
    // `ocr`, not `visual_gpu`: the OCR capture runs INSIDE the bracketed fan-out, so the origin
    // taken around it describes the same moment as these coordinates. A `visual_gpu` entity comes
    // from a stored snapshot and is declined — see the cell for it below.
    sources: ["ocr"],
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

  it("declines to correct coordinates the bracketed origin cannot describe", async () => {
    // PR 側 codex on the item-5 PR, and it is a REGRESSION rather than a residual — which is the
    // third time today that distinction has been got wrong here. `visual_gpu` candidates come from
    // `getStableCandidates()`, the backend's STORED snapshot, so their rectangles may have been
    // captured at a window position neither bracket read saw.
    //
    // Write `P_cap` for the position at capture, `P_brk` for what the bracket saw, `P_act` for the
    // position at act time. Without this rung the press is right when `P_act == P_cap`; with it,
    // right when `P_cap == P_brk`. A window that moved after the capture, sat elsewhere while the
    // lanes ran and came BACK by act time was therefore pressed correctly before the rung and
    // incorrectly after it. So the correction declines where the bracket cannot vouch.
    const stored: UiEntity = { ...entity(), sources: ["visual_gpu"] };
    const d = deps();
    await createDesktopExecutor(aimed, d)(stored, "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 215);   // the remembered point, uncorrected

    // A merged entity is only corrected when EVERY source was measured inside the bracket.
    const mixed: UiEntity = { ...entity(), sources: ["ocr", "visual_gpu"] };
    const d2 = deps();
    await createDesktopExecutor(aimed, d2)(mixed, "click");
    expect(d2.mouseClick).toHaveBeenCalledWith(458, 215);
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

  it("follows the window anyway when the capture says the entity is the aim's own", async () => {
    // PR 側 codex (2026-09-10). The popup guard reads the screen: an owned window on the remembered
    // point suppresses the correction, because the entity MIGHT belong to it. When `origin.hwnd`
    // says the pixels were captured in the AIM, that "might" is answered — the entity is the aim's
    // own control, the correction is valid, and dropping it presses into whatever popup happens to
    // be sitting on the stale point instead of following the control to where it went.
    const d = deps({ pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }) });
    const fromTheAim: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "CELL BUTTONS", hwnd: HWND.toString() },
    };
    await createDesktopExecutor(aimed, d)(fromTheAim, "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 144);   // corrected, not left on the popup
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

  it("refuses the press when a stored-snapshot entity's window has been resized", async () => {
    // The executor half of the same finding: the reason has to reach the rung that refuses.
    const resized: WindowRect = { x: 100, y: 200, width: 900, height: 400 };
    const d = deps({ aimRect: vi.fn(async () => resized) });
    const stored: UiEntity = { ...entity(), sources: ["visual_gpu"] };
    await expect(createDesktopExecutor(aimed, d)(stored, "click")).rejects.toThrow(/RESIZED/);
    expect(d.mouseClick).not.toHaveBeenCalled();
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

  it("presses when the window the pixels came from is the one under the point", async () => {
    // Two reviews said opposite things about this case and the answer is in neither of them. The
    // entity was captured in window 888 — a dropdown — and the AIM was being dragged while the read
    // happened. `moved_during_read` is a statement about the aim's rectangle, and an owned popup
    // does not move when its owner moves, so it says nothing about these coordinates. What does say
    // something is the live screen: 888 is under the point right now (gate 2, 2026-09-10).
    const d = deps({ pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }) });
    const unstable: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND, origin: { kind: "moved_during_read" } };
    const fromTheDropdown: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "CELL BUTTONS", hwnd: "888" },
    };
    await createDesktopExecutor(unstable, d)(fromTheDropdown, "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 215);   // uncorrected, and pressed
  });

  it("refuses when a DIFFERENT owned window is the one under the point", async () => {
    // The other half, and the reason the allowance is not simply `owned` (PR 側 codex on #609): a
    // dropdown that happens to sit under the stale point is not the dropdown the entity came from,
    // and pressing it reports success for something nobody discovered. The recorded capture handle
    // is what tells the two apart — before it, both answered `owned` and both were pressed.
    const d = deps({ pointOwner: () => ({ kind: "owned" as const, hwnd: 999n, title: "Recent files" }) });
    const unstable: Aim = { kind: "aim", title: "CELL BUTTONS", hwnd: HWND, origin: { kind: "moved_during_read" } };
    const fromTheDropdown: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "CELL BUTTONS", hwnd: "888" },
    };
    await expect(createDesktopExecutor(unstable, d)(fromTheDropdown, "click")).rejects.toThrow(/Recent files/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("presses when the enumeration says the aim is on top, because it cannot see a popup", async () => {
    // This cell shipped for a few hours asserting the opposite, and the measurement reversed it
    // (win2, 2026-09-10). `whoIsUnderPoint` never sees an untitled popup: a `ComboLBox` dropdown or
    // a tooltip drawn over its owner makes it answer `aim` WHILE THE POPUP IS ON TOP, and the press
    // that follows lands on the popup and is correct. Reading `aim` as "the entity's window is not
    // there" would have invented a false refusal for the commonest popup on Windows out of the
    // enumeration's own blind spot.
    const d = deps({ pointOwner: () => ({ kind: "aim" as const }) });
    const fromTheDropdown: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "CELL BUTTONS", hwnd: "888" },
    };
    await createDesktopExecutor(aimed, d)(fromTheDropdown, "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 215);   // uncorrected, and pressed
  });

  it("refuses a minimised aim even when the pixels came from another window", async () => {
    const parked: WindowRect = { x: -32000, y: -32000, width: 600, height: 400 };
    const d = deps({
      aimRect: vi.fn(async () => parked),
      pointOwner: () => ({ kind: "owned" as const, hwnd: 888n, title: "" }),
    });
    const fromAnotherWindow: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "CELL BUTTONS", hwnd: "888" },
    };
    await expect(createDesktopExecutor(aimed, d)(fromAnotherWindow, "click")).rejects.toThrow(/MINIMISED/);
    expect(d.mouseClick).not.toHaveBeenCalled();
  });

  it("declines when the capture says these pixels came from another window", async () => {
    // Gate 2 (2026-09-10): the owned-popup guard was ENTIRELY conditional on `deps.pointOwner`,
    // which is optional by design — a build whose enumeration cannot answer must not have every
    // aimed action refused — so on a build without it nothing stood in front of the popup case at
    // all. This half needs no enumeration: ADR-029 records the handle the capture resolved on every
    // candidate, and it was there unread.
    const d = deps();   // no pointOwner
    const fromAnotherWindow: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "CELL BUTTONS", hwnd: "888" },   // a modal, not the aim
    };
    await createDesktopExecutor(aimed, d)(fromAnotherWindow, "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 215);   // uncorrected
  });

  it("still corrects when the capture and the aim are the same window", async () => {
    const d = deps();
    const fromTheAim: UiEntity = {
      ...entity(),
      origin: { kind: "window", id: "CELL BUTTONS", hwnd: HWND.toString() },
    };
    await createDesktopExecutor(aimed, d)(fromTheAim, "click");
    expect(d.mouseClick).toHaveBeenCalledWith(458, 144);
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
