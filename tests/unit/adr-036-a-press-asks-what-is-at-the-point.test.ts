/**
 * internal #135 — the last question before a coordinate press: what is AT that point now?
 *
 * Every rung the ladder had asks about the WINDOW — moved, resized, minimised, covered, contains
 * the point — and the row said as much out loud (`identityBaseline: "none"`). So a press could land
 * on a DIFFERENT control in the right window and report success: MEASURED 2026-09-20 win2 (internal
 * `750a5f3`, arm G1r) — a fixture's button renamed in place after discover took the downgraded
 * press, and the fixture logged `PRESS OTHERQ` for an act that named `BTNW`.
 *
 * What can be compared was measured too (win2's spike, internal `0a368f8`): the NAME and nothing
 * else. `controlType` disagrees by construction — the click road reads a WPF `Button`, the point
 * read normalises into the `Text` inside it — and `automationId` was empty on both sides. The point
 * read answers the WINDOW for a control with no name, which is byte-for-byte what it answers for a
 * control that has been removed, so that answer cannot be read as "it is gone".
 *
 * These cells pin the verdicts: one refuses, the rest press and say what they saw.
 *
 * MEASURED AFTER (win2, internal `4fd61b6`): a differently named element at the point refuses with
 * `entity_not_found` and the fixture logs no press; the same name — carried by the `Text` inside the
 * control — presses; a control with no name answers `unreadable` and presses; a region with no
 * control of its own answers `window_answered` and presses. Reaching this rung at all took a new
 * fixture: after #133 and #134 a renamed or removed control is not found by the UIA search, so item
 * 16 refuses it before any coordinate is computed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Aim } from "../../src/engine/aim.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";
import type { ExecutorDeps, ElementAtPoint } from "../../src/tools/desktop-executor.js";

const AIM = 4919n;
const POPUP = 888n;

/** Discovered by UIA under the name the act carries — the only shape this rung asks about. */
function entity(over: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e1", role: "button", label: "Save", confidence: 0.9,
    sources: ["uia"],
    affordances: [{ verb: "click", executors: ["mouse"], confidence: 0.9, preconditions: [], postconditions: [] }],
    generation: "gen-1", evidenceDigest: "d",
    rect: { x: 100, y: 200, width: 80, height: 30 },
    locator: { uia: { name: "Save" } },
    // ADR-036 item 15 — the window the pixels were measured in. The road this rung guards is the
    // TITLE-only one: the act named no handle, the UIA click failed with a pattern the element does
    // not have, and the ladder falls to the entity's own origin for a window to check against. With
    // a handle in the aim the UIA failure refuses instead, four branches earlier.
    origin: { kind: "window", id: "App", hwnd: String(AIM) },
    ...over,
  } as UiEntity;
}

let dir: string;
let logPath: string;
const rows = (): Record<string, unknown>[] =>
  existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const elementRows = () => rows().filter((r) => r.route === "element_check");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "at-point-"));
  logPath = join(dir, "aim-probe.jsonl");
  vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE", "1");
  vi.stubEnv("DESKTOP_TOUCH_AIM_PROBE_PATH", logPath);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

/** The ladder, with the rungs above this one all answering "press it". */
async function press(over: Partial<ExecutorDeps>, ent: UiEntity = entity()) {
  const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
  const deps: ExecutorDeps = {
    // The failure that makes the coordinate road the road: the element is there, and it has no
    // InvokePattern. "Not found" would have ended the ladder above this rung (item 16).
    uiaClick: vi.fn(async () => { throw new Error("InvokePattern not supported by this element"); }),
    uiaSetValue: vi.fn(async () => {}),
    cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
    mouseClick: vi.fn(async () => {}),
    aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 1000, height: 1000 })),
    ...over,
  };
  const aim: Aim = { kind: "aim", title: "App" };
  // `click` on an entity UIA named, with the UIA road spent: the downgrade to coordinates, which is
  // the road this rung guards.
  const outcome = await createDesktopExecutor(aim, deps)(ent, "click").then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  return { outcome, deps };
}

const AT = (over: Partial<ElementAtPoint> = {}): ElementAtPoint =>
  ({ name: "Save", controlType: "Text", ...over });

describe("a coordinate press asks what is at the point", () => {
  it("refuses when a differently named element holds the point, and presses nothing", async () => {
    // G1r as a cell: the button was renamed in place, so the point is held by something the act
    // never named. The UIA road already refuses a renamed control (it cannot find the name any
    // more); this is the same answer on the road that does not search.
    const { outcome, deps } = await press({ elementAtPoint: () => AT({ name: "OTHERQ" }) });
    expect(outcome.ok).toBe(false);
    expect(deps.mouseClick).not.toHaveBeenCalled();
    expect(String(outcome.ok === false ? outcome.e : "")).toMatch(/OTHERQ/);
    expect((outcome as { e: Error }).e.name).toBe("TargetGoneError");
    expect(elementRows()).toEqual([expect.objectContaining({
      verdict: "different",
      named: "Save",
      atPoint: { name: "OTHERQ", controlType: "Text", automationId: null },
    })]);
    // The refusal names the rung, spelled as the reason a caller sees.
    expect(rows().filter((r) => r.route === "refusal")).toEqual([expect.objectContaining({
      rung: "element_at_point_differs", refused: "entity_not_found",
    })]);
  });

  it("presses when the point carries the name, though the control type does not match", async () => {
    // The measured shape: the click road reads a `Button`, the point read normalises to the `Text`
    // inside it. Comparing the type would refuse every press on a WPF button.
    const { outcome, deps } = await press({ elementAtPoint: () => AT({ controlType: "Text" }) });
    expect(outcome.ok).toBe(true);
    expect(deps.mouseClick).toHaveBeenCalledWith(140, 215);
    expect(elementRows()[0]).toMatchObject({ verdict: "same" });
  });

  it("compares the way the search does — a case-insensitive substring", async () => {
    // Not equality: this is the predicate both UIA clients use to FIND an element by name, so an
    // element that answers to the act's name is the same thing to the road that would have clicked
    // it. `&`-mnemonics and a longer accessible name are the everyday cases.
    for (const name of ["Save", "save", "Save As…", "SAVE ALL"]) {
      const { outcome } = await press({ elementAtPoint: () => AT({ name }) });
      expect(outcome.ok, name).toBe(true);
    }
    // …and the other direction is not the same thing: "Sav" does not carry "Save".
    const { outcome } = await press({ elementAtPoint: () => AT({ name: "Sav" }) });
    expect(outcome.ok).toBe(false);
  });

  it("presses when the WINDOW answers, because that is also what an unnamed control looks like", async () => {
    // MEASURED (win2, S5a): a `Border` with no name is not in the control view, so the point read
    // returns the nearest ancestor — the window, with its title as the name. A control that was
    // REMOVED produces the identical answer (S3). Refusing here would refuse both, and only one of
    // them is wrong.
    for (const controlType of ["Window", "Pane"]) {
      rmSync(logPath, { force: true });
      const { outcome, deps } = await press({ elementAtPoint: () => AT({ name: "App — Fixture", controlType }) });
      expect(outcome.ok, controlType).toBe(true);
      expect(deps.mouseClick).toHaveBeenCalled();
      expect(elementRows()[0]).toMatchObject({ verdict: "window_answered", atPoint: { controlType } });
    }
  });

  it("presses, and says which silence it was, when nothing can be compared", async () => {
    const cases: [string, Partial<ExecutorDeps>, UiEntity, Record<string, unknown>][] = [
      // The read failed or found nothing there. On a build without the native addon this is every
      // call (internal #138), so the rung must not turn that into a refusal.
      ["unreadable", { elementAtPoint: () => null }, entity(), { verdict: "unreadable", atPoint: null }],
      // An element with a name of nothing cannot be compared to a name. The production dep does not
      // produce this row — `dropFocusRow` drops an unnamed one, so a nameless control arrives as
      // `unreadable` above (measured, win2 `4fd61b6`, where the prediction had been
      // `window_answered`) — but the dep's contract allows it, and a build that asked for unnamed
      // rows would send it. Pressing is the same answer either way.
      ["unnamed", { elementAtPoint: () => AT({ name: "" }) }, entity(), { verdict: "unnamed" }],
      // No dep at all: an older build, or a test double. The press is what it was before the rung.
      ["no dep", {}, entity(), { verdict: "not_asked_no_dep" }],
      // A vision entity carries an OCR label, not a UIA name. One misread character would refuse a
      // press that is perfectly good, so it is not asked.
      ["vision entity", { elementAtPoint: () => AT({ name: "OTHERQ" }) },
        entity({ sources: ["visual_gpu"], locator: undefined }),
        { verdict: "not_asked_entity_unnamed", named: null }],
    ];
    for (const [label, over, ent, row] of cases) {
      rmSync(logPath, { force: true });
      const { outcome, deps } = await press(over, ent);
      expect(outcome.ok, label).toBe(true);
      expect(deps.mouseClick, label).toHaveBeenCalled();
      expect(elementRows()[0], label).toMatchObject(row);
    }
  });

  it("asks on the popup allowance too, which returns before the other rungs", async () => {
    // The `owned` popup returns early — a dropdown lives outside its owner's rectangle — and that
    // path had to reach this rung as well, or the commonest coordinate press on Windows would be
    // the one nobody checks.
    const d = {
      aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 10, height: 10 })),
      pointOwner: () => ({ kind: "owned" as const, hwnd: POPUP, title: "" }),
      elementAtPoint: () => AT({ name: "OTHERQ" }),
    };
    const { outcome, deps } = await press(d);
    expect(outcome.ok).toBe(false);
    expect(deps.mouseClick).not.toHaveBeenCalled();
    expect(elementRows()[0]).toMatchObject({ verdict: "different" });
  });

  it("does not run where the ladder itself does not — no aim handle, no rung", async () => {
    // Without a handle there is no window to check anything against, and the function returns the
    // remembered point before any of this. The row's absence is the evidence.
    const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
    const deps: ExecutorDeps = {
      uiaClick: vi.fn(async () => { throw new Error("InvokePattern not supported by this element"); }),
      uiaSetValue: vi.fn(async () => {}),
      cdpClick: vi.fn(async () => {}), cdpFill: vi.fn(async () => {}),
      terminalSend: vi.fn(async () => {}), keyboardTypeBg: vi.fn(async () => {}),
      mouseClick: vi.fn(async () => {}),
      elementAtPoint: () => AT({ name: "OTHERQ" }),
    };
    await createDesktopExecutor({ kind: "aim", title: "App" } as Aim, deps)(entity({ origin: undefined }), "click");
    expect(deps.mouseClick).toHaveBeenCalled();
    expect(elementRows()).toEqual([]);
  });
});
