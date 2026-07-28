/**
 * ADR-029 AC1 — the multi-monitor bug, reproduced on a single monitor.
 *
 * The failure this phase fixes needs only two windows, not two monitors: a
 * visually discovered element whose window is NOT the foreground one. The old
 * gate compared the element against the foreground window's rect, so it blocked
 * with `entity_outside_viewport` whenever the target window was merely
 * unfocused — which on a multi-monitor desktop is the normal case.
 *
 * This runs the production gate with NO injected dependencies, so real Win32
 * behaviour is exercised end to end; the unit tests inject fakes and cannot
 * catch a Win32-level regression. The first describe covers the enumerated
 * path (`enumWindowsInZOrder`), the second the probe path
 * (`getWindowRenderState`) against a real untitled window — the shape the
 * enumeration drops.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnBlankWindow } from "./helpers/blank-window.js";
import { spawnVisualOnlyCanvas } from "./helpers/visual-only-canvas.js";
import { spawnUntitledWindow } from "./helpers/untitled-window.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../../src/engine/win32.js";
import { productionCheckViewport } from "../../src/tools/desktop-register.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

interface Rect { x: number; y: number; width: number; height: number }

const canvas = await spawnVisualOnlyCanvas();
const blank = await spawnBlankWindow();
const untitled = await spawnUntitledWindow();

function findByTitle(title: string): { hwnd: bigint; region: Rect } | null {
  const w = enumWindowsInZOrder().find((x) => x.title === title);
  return w ? { hwnd: w.hwnd, region: w.region } : null;
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/** A point inside `inner` but outside `outer`, or null when `inner` is covered. */
function pointInsideButOutside(inner: Rect, outer: Rect): { x: number; y: number } | null {
  const candidates = [
    { x: inner.x + inner.width - 5, y: inner.y + inner.height - 5 },
    { x: inner.x + 2, y: inner.y + inner.height - 5 },
    { x: inner.x + inner.width - 5, y: inner.y + 2 },
    { x: inner.x + 2, y: inner.y + 2 },
    { x: Math.round(inner.x + inner.width / 2), y: Math.round(inner.y + inner.height / 2) },
  ];
  return candidates.find((p) => !contains(outer, p.x, p.y)) ?? null;
}

function visualEntity(rect: Rect, originHwnd: bigint): UiEntity {
  return {
    entityId: "e-adr029",
    role: "button",
    confidence: 0.9,
    sources: ["ocr"], // visual-only: no structured source, so the gate really runs
    affordances: [],
    generation: "g1",
    evidenceDigest: "d1",
    rect,
    origin: { kind: "window", id: String(originHwnd) },
  };
}

afterAll(() => {
  canvas?.close();
  blank?.close();
  untitled?.close();
});

describe.skipIf(canvas === null || blank === null)("ADR-029 AC1 — viewport gate vs. an unfocused window", () => {
  it("passes an element in a window that is not the foreground one", async () => {
    const origin = findByTitle(canvas!.title);
    const foreground = enumWindowsInZOrder().find((w) => w.title.startsWith("dt-blank-click-target-"));
    expect(origin, "canvas window should be enumerable").not.toBeNull();
    expect(foreground, "blank window should be enumerable").toBeDefined();

    // Make the blank window — NOT the canvas — the foreground one.
    restoreAndFocusWindow(foreground!.hwnd);
    await new Promise((r) => setTimeout(r, 300));

    // Geometry premise: both fixtures land on the SAME screen — the non-primary
    // monitor when the machine has one, the primary otherwise (see
    // helpers/e2e-screen.ts) — with the canvas centred on it and the blank
    // window near its top-left corner. A point inside the canvas and outside the
    // blank window therefore always exists, and the coordinates involved may be
    // negative when that screen sits left of the primary. Asserted rather than
    // skipped: a layout change that makes the scenario un-stageable must fail
    // loudly, not pass vacuously.
    const point = pointInsideButOutside(origin!.region, foreground!.region);
    expect(point, "canvas must not be fully covered by the foreground window").not.toBeNull();

    // Precondition = the old bug: the element sits outside the foreground window.
    // Without this the assertion below could pass for the wrong reason.
    expect(contains(foreground!.region, point!.x, point!.y)).toBe(false);

    const entity = visualEntity({ x: point!.x - 10, y: point!.y - 5, width: 20, height: 10 }, origin!.hwnd);
    expect(productionCheckViewport(entity)).toBeNull();
  });

  it("still blocks an element that left its own window", () => {
    const origin = findByTitle(canvas!.title);
    expect(origin).not.toBeNull();
    const far = {
      x: origin!.region.x + origin!.region.width + 400,
      y: origin!.region.y,
      width: 20,
      height: 10,
    };
    expect(productionCheckViewport(visualEntity(far, origin!.hwnd))).toBe("entity_outside_viewport");
  });

  // The title lane, against a real window: `desktop_discover({target:{windowTitle}})`
  // records the raw query, which is a case-insensitive substring of the live title,
  // not the whole thing. Matching it by equality would block every visual-only
  // element discovered this way — the bug this whole change removes.
  it("resolves a title-query origin against the live window", () => {
    const origin = findByTitle(canvas!.title);
    expect(origin).not.toBeNull();
    const query = canvas!.title.slice(0, 12); // a prefix, as a user would type
    expect(canvas!.title).not.toBe(query);

    const inside = {
      x: origin!.region.x + 20,
      y: origin!.region.y + Math.round(origin!.region.height / 2),
      width: 20,
      height: 10,
    };
    const entity = { ...visualEntity(inside, origin!.hwnd), origin: { kind: "window" as const, id: query } };
    expect(productionCheckViewport(entity)).toBeNull();

    const outside = { ...entity, rect: { x: origin!.region.x + origin!.region.width + 300, y: origin!.region.y, width: 20, height: 10 } };
    expect(productionCheckViewport(outside)).toBe("entity_outside_viewport");
  });

  it("blocks as stale once the origin window is gone", async () => {
    // NOTE: keep this test last in the file — it closes the shared canvas window.
    const origin = findByTitle(canvas!.title);
    expect(origin).not.toBeNull();
    const rect = { x: origin!.region.x + 10, y: origin!.region.y + 10, width: 20, height: 10 };

    canvas!.close();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && findByTitle(canvas!.title) !== null) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(findByTitle(canvas!.title), "canvas window should be closed").toBeNull();

    expect(productionCheckViewport(visualEntity(rect, origin!.hwnd))).toBe("entity_outside_viewport");
  });
});

// The gate's second lookup path, against a real window rather than a fake: an
// untitled borderless window is dropped by `enumWindowsInZOrder`, so reading
// "not enumerated" as "closed" would block this window's elements forever. This
// is the shape of the accessibility-blind targets the gate exists for.
describe.skipIf(untitled === null)("ADR-029 — a live window the enumeration filters out", () => {
  it("is absent from the enumeration but still comparable through the probe", () => {
    const enumerated = enumWindowsInZOrder().some((w) => w.hwnd === untitled!.hwnd);
    expect(enumerated, "an untitled window must not be enumerated (fixture premise)").toBe(false);

    const r = untitled!.rect;
    const inside = { x: r.x + 20, y: r.y + 20, width: 20, height: 10 };
    expect(productionCheckViewport(visualEntity(inside, untitled!.hwnd))).toBeNull();

    const outside = { x: r.x + r.width + 200, y: r.y, width: 20, height: 10 };
    expect(productionCheckViewport(visualEntity(outside, untitled!.hwnd))).toBe("entity_outside_viewport");
  });
});
