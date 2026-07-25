/**
 * ADR-029 AC1 — the multi-monitor bug, reproduced on a single monitor.
 *
 * The failure this phase fixes needs only two windows, not two monitors: a
 * visually discovered element whose window is NOT the foreground one. The old
 * gate compared the element against the foreground window's rect, so it blocked
 * with `entity_outside_viewport` whenever the target window was merely
 * unfocused — which on a multi-monitor desktop is the normal case.
 *
 * This runs the production gate with NO injected dependencies, so real
 * `enumWindowsInZOrder` / `getWindowRenderState` behaviour is exercised end to
 * end; the unit tests inject fakes and cannot catch a Win32-level regression.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnBlankWindow } from "./helpers/blank-window.js";
import { spawnVisualOnlyCanvas } from "./helpers/visual-only-canvas.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../../src/engine/win32.js";
import { productionCheckViewport } from "../../src/tools/desktop-register.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

interface Rect { x: number; y: number; width: number; height: number }

const canvas = await spawnVisualOnlyCanvas();
const blank = await spawnBlankWindow();

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

    // The canvas fixture opens centred and the blank window sits at the top-left,
    // so a point inside the canvas and outside the foreground window always
    // exists. Asserted rather than skipped: a layout change that makes the
    // scenario un-stageable must fail loudly, not pass vacuously.
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

  it("blocks as stale once the origin window is gone", async () => {
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
